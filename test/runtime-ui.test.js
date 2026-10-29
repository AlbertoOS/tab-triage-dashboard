const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

// Only browser/DOM boundaries are mocked; execute the complete dashboard source.
function dashboard(sendMessage, storage = {}) {
  const elements = new Map();
  const timers = new Map();
  let now = 0;
  let timerId = 0;
  let activeElement;
  function advanceTime(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = end;
  }
  function element(tag) {
    return {
      tag,
      children: [], listeners: {}, dataset: {}, style: { setProperty() {} }, value: "", hidden: true,
      classList: { toggle() {}, add() {}, remove() {} },
      appendChild(child) { this.children.push(child); child.parent = this; return child; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      set disabled(value) {
        this.isDisabled = value;
        if (value && activeElement === this) activeElement = undefined;
      },
      get disabled() { return this.isDisabled || false; },
      focus() { if (!this.disabled) activeElement = this; },
      contains(child) { return child === this || this.children.some((item) => item.contains(child)); },
      cloneNode() { return Object.assign(element(), { disabled: this.disabled }); },
      replaceWith(next) {
        if (this.contains(activeElement)) activeElement = undefined;
        for (const [id, value] of elements) if (value === this) elements.set(id, next);
      },
      querySelector(selector) {
        for (const child of this.children) {
          if (child.tag === selector || (child.className || "").split(" ").includes(selector.slice(1))) return child;
          const found = child.querySelector(selector);
          if (found) return found;
        }
        return null;
      },
      set innerHTML(value) {
        if (this.contains(activeElement)) activeElement = undefined;
        this.children = [];
      },
      set textContent(value) { this.text = value; this.children = []; },
      get textContent() { return this.text || ""; },
    };
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  get("groupBy").value = "none";
  const messages = [];
  const context = vm.createContext({
    URL, console,
    setTimeout(callback, delay = 0) {
      timers.set(++timerId, { callback, at: now + delay });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    window: { addEventListener() {} },
    chrome: {
      runtime: { getURL: () => "chrome-extension://fixture/triage.html", sendMessage: async (message) => {
        messages.push(message);
        return sendMessage(message);
      } },
      storage: { local: { get: async () => ({}), set: async () => {}, ...storage } },
    },
    document: { get activeElement() { return activeElement; },
      getElementById: get, createElement: element,
      querySelectorAll: (selector) => {
        if (selector === 'input[name="filterDomain"]' || selector === 'input[name="filterDomain"]:checked') {
          return get("domainList").children.map((label) => label.querySelector("input"))
            .filter((input) => !selector.endsWith(":checked") || input.checked);
        }
        return [];
      },
      querySelector: get, addEventListener() {}, documentElement: element() },
  });
  for (const file of ["utils.js", "triage.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  return { get, messages, advanceTime, run: (code) => vm.runInContext(code, context),
    settle: () => new Promise(setImmediate) };
}

for (const [selector, type] of [[".btn-close", "closeTab"], [".btn-goto", "goToTab"],
  [".btn-discard", "discardTab"], [".btn-dedup", "closeTabs"]]) {
  it(`contains ${type} errors without false recovery and refreshes partial browser state`, async () => {
    let queries = 0;
    const app = dashboard((message) => {
      if (message.type === "getTabs") {
        queries++;
        return { ok: true, tabs: [1, 2].map((id) => ({ id, windowId: 1, title: "Example", url: "https://example.com" })) };
      }
      return { ok: false, error: "Operation denied" };
    });
    await app.settle();
    const row = app.get("tab-body").children[0];
    await row.querySelector(selector).listeners.click({ stopPropagation() {} });
    await app.settle();
    assert.match(app.get("bulkError").textContent, /Operation denied/);
    assert.equal(app.get("undo-toast").hidden, true);
    assert.equal(queries, 2);
    assert.equal(app.messages.filter((message) => message.type === type).length, 1);
  });
}

for (const [selector, type] of [[".btn-goto", "goToTab"], [".btn-discard", "discardTab"],
  [".btn-close", "closeTab"], [".btn-dedup", "closeTabs"]]) {
  const outcomes = type === "goToTab" || type === "discardTab" ? ["success", "denied", "rejected"] : ["denied", "rejected"];
  for (const outcome of outcomes) {
    it(`preserves existing recovery through ${type} ${outcome}`, async () => {
      let finishAction;
      let seeded = false;
      const app = dashboard((message) => {
        if (message.type === "getTabs") return { ok: true, tabs: [1, 2].map((id) => (
          { id, windowId: 1, title: "Example", url: "https://example.com" }
        )) };
        if (!seeded) return { ok: true };
        return new Promise((resolve, reject) => {
          finishAction = () => outcome === "rejected" ? reject(new Error("Channel closed")) :
            resolve(outcome === "success" ? { ok: true } : { ok: false, error: "Operation denied" });
        });
      });
      await app.settle();
      const click = (action) => app.get("tab-body").children[0].querySelector(action)
        .listeners.click({ stopPropagation() {} });
      await click(".btn-close");
      seeded = true;
      const button = app.get("undo-toast-btn");
      const message = app.get("undo-toast-msg").textContent;
      const pending = click(selector);
      // Test both the pending request and its eventual outcome.
      const visibleWhilePending = !app.get("undo-toast").hidden;
      finishAction();
      await pending;
      assert.equal(visibleWhilePending, true, "pending actions must not dismiss earlier recovery");
      assert.equal(app.get("undo-toast").hidden, false);
      assert.equal(app.get("undo-toast-btn"), button, "do not replace the earlier restore handler");
      assert.equal(button.disabled, false);
      assert.equal(app.get("undo-toast-msg").textContent, message);
      assert.equal(app.messages.filter((entry) => entry.type === "restoreTab").length, 0);
      if (outcome !== "success") assert.match(app.get("bulkError").textContent, /denied|Channel closed/);
    });
  }
}

it("offers one honest session restore, suppresses overlapping clicks and reports failure", async () => {
  let finishRestore;
  const app = dashboard((message) => message.type === "getTabs" ? { ok: true, tabs: [] } :
    new Promise((resolve) => { finishRestore = resolve; }));
  await app.settle();
  app.run('showUndoToast("Duplicate close request completed.", 20)');
  const button = app.get("undo-toast-btn");
  assert.match(button.textContent, /Restore most recently closed tab\/window/);
  assert.equal(app.messages.filter((message) => message.type.startsWith("restore")).length, 0);
  const first = button.listeners.click();
  const second = button.listeners.click();
  assert.equal(app.messages.filter((message) => message.type.startsWith("restore")).length, 1);
  assert.equal(app.messages.at(-1).type, "restoreTab");
  assert.equal("count" in app.messages.at(-1), false);
  finishRestore({ ok: false, error: "Nothing to restore" });
  await Promise.all([first, second]);
  assert.match(app.get("bulkError").textContent, /Nothing to restore/);
  assert.equal(app.get("undo-toast").hidden, false);
  assert.equal(button.disabled, false);
  const retry = button.listeners.click();
  assert.equal(app.messages.filter((message) => message.type === "restoreTab").length, 2);
  finishRestore({ ok: true });
  await retry;
  assert.equal(app.get("bulkError").textContent, "");
  assert.equal(app.get("undo-toast").hidden, true);
});

it("allows one new explicit restore after each new close notification", async () => {
  const app = dashboard((message) => message.type === "getTabs" ? { ok: true, tabs: [] } : { ok: true });
  await app.settle();
  for (let i = 0; i < 2; i++) {
    app.run('showUndoToast("Close request completed.")');
    const button = app.get("undo-toast-btn");
    await button.listeners.click();
    assert.equal(app.get("undo-toast").hidden, true);
  }
  assert.equal(app.messages.filter((message) => message.type === "restoreTab").length, 2);
});

for (const outcome of ["succeeds", "fails", "refresh fails"]) {
  it(`keeps a newer close notification unchanged when an older restore ${outcome}`, async () => {
    let finishRestore;
    let finished = false;
    const app = dashboard((message) => {
      if (message.type === "getTabs") {
        if (finished && outcome === "refresh fails") return { ok: false, error: "Old refresh denied" };
        return { ok: true, tabs: [
          { id: 1, title: "Example", url: "https://example.com" },
        ] };
      }
      if (message.type === "restoreTab") return new Promise((resolve) => { finishRestore = resolve; });
      return { ok: true };
    });
    await app.settle();
    const close = () => app.get("tab-body").children[0].querySelector(".btn-close")
      .listeners.click({ stopPropagation() {} });
    await close();
    const oldButton = app.get("undo-toast-btn");
    const restoring = oldButton.listeners.click();
    await close();
    const currentButton = app.get("undo-toast-btn");
    const message = app.get("undo-toast-msg").textContent;
    assert.notEqual(currentButton, oldButton);
    finished = true;
    finishRestore(outcome === "fails" ? { ok: false, error: "Old restore denied" } : { ok: true });
    await restoring;
    assert.equal(app.get("undo-toast").hidden, false);
    assert.equal(app.get("undo-toast-btn"), currentButton);
    assert.equal(currentButton.disabled, false);
    assert.equal(app.get("undo-toast-msg").textContent, message);
    assert.equal(app.get("bulkError").textContent, "");
  });
}

it("keeps recovery available beyond expiry without stealing keyboard focus", async () => {
  const app = dashboard((message) => message.type === "getTabs" ? { ok: true, tabs: [
    { id: 1, title: "Example", url: "https://example.com" },
  ] } : { ok: true });
  await app.settle();
  app.get("search").focus();
  await app.get("tab-body").children[0].querySelector(".btn-close")
    .listeners.click({ stopPropagation() {} });
  const button = app.get("undo-toast-btn");
  assert.equal(app.run("document.activeElement"), app.get("search"));
  // Prove the fixture executes due callbacks rather than silently ignoring timers.
  app.run('setTimeout(() => { document.getElementById("timer-probe").textContent = "fired"; }, 5000)');
  app.advanceTime(5001);
  assert.equal(app.get("timer-probe").textContent, "fired");
  assert.equal(app.get("undo-toast").hidden, false);
  button.focus();
  app.advanceTime(60000);
  assert.equal(app.run("document.activeElement"), button);
  assert.equal(app.get("undo-toast").hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(app.messages.filter((message) => message.type === "restoreTab").length, 0);
  await button.listeners.click();
  assert.equal(app.get("undo-toast").hidden, true);
  assert.equal(app.messages.filter((message) => message.type === "restoreTab").length, 1);
});

it("gives every rendered menu action an inset visible keyboard focus outline", async () => {
  const app = dashboard(() => ({ ok: true, tabs: [
    { id: 1, title: "Example", url: "https://example.com" },
  ] }));
  await app.settle();
  const menu = app.get("tab-body").children[0].querySelector(".more-menu");
  assert.deepEqual(menu.children.map((button) => button.className),
    ["btn-discard", "btn-ignore-url", "btn-ignore-domain"]);
  for (const button of menu.children) {
    button.focus();
    assert.equal(app.run("document.activeElement"), button);
  }
  const css = fs.readFileSync(path.join(__dirname, "..", "triage.css"), "utf8");
  const rule = css.match(/\.more-menu button:focus-visible\s*\{([^}]+)\}/);
  assert.ok(rule, "borderless menu actions need a focus outline, not only a border-color change");
  assert.match(rule[1], /outline:\s*2px\s+solid\s+var\(--text\)/);
  assert.match(rule[1], /outline-offset:\s*-2px/,
    "keep the ring inside scrollable menu edges rather than clipping it");
});

it("gives the recovery button a contrasting visible keyboard focus outline", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "triage.css"), "utf8");
  const rule = css.match(/\.btn-undo:focus-visible\s*\{([^}]+)\}/);
  assert.ok(rule, "recovery needs its own focus-visible rule because its border is removed");
  const outline = rule[1].match(/outline:\s*(\d+)px\s+solid\s+var\((--[\w-]+)\)/);
  assert.ok(outline, "focus must have a solid, nonzero outline");
  assert.ok(Number(outline[1]) >= 2);
  assert.match(rule[1], /outline-offset:\s*[2-9]\d*px/);
  function luminance(variable) {
    const hex = css.match(new RegExp(`${variable}:\\s*(#[0-9a-f]{6})`, "i"))[1];
    const channels = hex.slice(1).match(/../g).map((value) => {
      const channel = parseInt(value, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  const ring = luminance(outline[2]);
  const surround = luminance("--surface1");
  assert.ok((Math.max(ring, surround) + 0.05) / (Math.min(ring, surround) + 0.05) >= 3,
    "focus ring must contrast at least 3:1 with the toast surface");
});

it("uses a packaged favicon for missing or failed site icons", async () => {
  const app = dashboard(() => ({ ok: true, tabs: [
    { id: 1, title: "Missing", url: "https://missing.example" },
    { id: 2, title: "Remote", url: "https://remote.example", favIconUrl: "https://remote.example/icon.png" },
  ] }));
  await app.settle();
  const rows = app.get("tab-body").children;
  const fallback = rows[0].querySelector(".tab-favicon");
  assert.ok(fallback, "missing icons retain a visible fallback");
  assert.equal(fallback.src, "icons/icon-48.png");
  const remote = rows[1].querySelector(".tab-favicon");
  remote.onerror();
  assert.equal(remote.src, "icons/icon-48.png");
  assert.equal(remote.onerror, null, "fallback failure must not loop");
});

for (const outcome of ["denied", "rejected", "malformed"]) {
  for (const priorRecovery of [false, true]) {
    it(`keeps recovery ${priorRecovery ? "intact" : "hidden"} after partial selected closure ${outcome}`, async () => {
      let tabs = [1, 2].map((id) => ({ id, title: "Example", url: "https://example.com" }));
      const app = dashboard((message) => {
        if (message.type === "getTabs") return { ok: true, tabs };
        if (message.type === "closeTab") return { ok: true };
        tabs = tabs.filter((tab) => tab.id === 2);
        if (outcome === "rejected") throw new Error("Channel closed after partial removal");
        return outcome === "malformed" ? { ok: "yes" } : { ok: false, error: "Partial removal denied" };
      });
      await app.settle();
      if (priorRecovery) await app.get("tab-body").children[0].querySelector(".btn-close")
        .listeners.click({ stopPropagation() {} });
      const button = app.get("undo-toast-btn");
      const message = app.get("undo-toast-msg").textContent;
      app.get("selectFiltered").listeners.click();
      await app.get("closeSelected").listeners.click();
      assert.equal(app.get("undo-toast").hidden, !priorRecovery);
      assert.equal(app.get("undo-toast-btn"), button);
      assert.equal(app.get("undo-toast-msg").textContent, message, "must not announce full success");
      assert.match(app.get("bulkError").textContent, /denied|Channel closed|response/);
      assert.deepEqual(Array.from(app.run("selectedTabIds")), [2]);
      assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [2]);
      assert.equal(app.get("closeSelected").disabled, false);
      assert.equal(app.messages.filter((entry) => entry.type === "restoreTab").length, 0);
    });
  }
}

for (const refreshFails of [false, true]) {
  it(`replaces earlier recovery after acknowledged selected closure even when refresh ${refreshFails ? "fails" : "succeeds"}`, async () => {
    let closed = false;
    const app = dashboard((message) => {
      if (message.type === "getTabs") {
        if (closed && refreshFails) return { ok: false, error: "Refresh denied" };
        return { ok: true, tabs: [{ id: 1, title: "Example", url: "https://example.com" }] };
      }
      if (message.type === "closeTabs") closed = true;
      return { ok: true };
    });
    await app.settle();
    await app.get("tab-body").children[0].querySelector(".btn-close")
      .listeners.click({ stopPropagation() {} });
    const previous = app.get("undo-toast-btn");
    app.get("selectFiltered").listeners.click();
    await app.get("closeSelected").listeners.click();
    assert.equal(app.get("undo-toast").hidden, false);
    assert.notEqual(app.get("undo-toast-btn"), previous);
    assert.equal(app.get("undo-toast-btn").disabled, false);
    assert.equal(app.get("undo-toast-msg").textContent, "Selected-tab close request completed.");
    assert.equal(app.run("selectedTabIds.size"), 0);
    if (refreshFails) assert.match(app.get("bulkError").textContent, /Refresh denied/);
  });
}

it("does not replace earlier recovery when closing an empty selection", async () => {
  const app = dashboard((message) => message.type === "getTabs" ? { ok: true, tabs: [
    { id: 1, title: "Example", url: "https://example.com" },
  ] } : { ok: true });
  await app.settle();
  await app.get("tab-body").children[0].querySelector(".btn-close")
    .listeners.click({ stopPropagation() {} });
  const button = app.get("undo-toast-btn");
  const message = app.get("undo-toast-msg").textContent;
  await app.get("closeSelected").listeners.click();
  assert.equal(app.get("undo-toast").hidden, false);
  assert.equal(app.get("undo-toast-btn"), button);
  assert.equal(app.get("undo-toast-msg").textContent, message);
  assert.equal(app.messages.filter((entry) => entry.type === "closeTabs").length, 0);
});

it("preserves both bulk operation and refresh errors without clearing surviving selection", async () => {
  let queries = 0;
  const app = dashboard((message) => {
    if (message.type !== "getTabs") return { ok: false, error: "Close denied" };
    if (++queries > 1) return { ok: false, error: "Refresh denied" };
    return { ok: true, tabs: [{ id: 1, title: "Example", url: "https://example.com" }] };
  });
  await app.settle();
  app.get("selectFiltered").listeners.click();
  await app.get("closeSelected").listeners.click();
  assert.match(app.get("bulkError").textContent, /Close denied/);
  assert.match(app.get("bulkError").textContent, /Refresh denied/);
  assert.equal(app.run("selectedTabIds.size"), 1);
  assert.equal(app.run("closingSelected"), false);
});

it("rejects truthy non-boolean bulk acknowledgments", async () => {
  const app = dashboard((message) => message.type === "getTabs" ? {
    ok: true, tabs: [{ id: 1, title: "Example", url: "https://example.com" }],
  } : { ok: "yes" });
  await app.settle();
  app.get("selectFiltered").listeners.click();
  await app.get("closeSelected").listeners.click();
  assert.equal(app.run("selectedTabIds.size"), 1);
  assert.match(app.get("bulkError").textContent, /response/i);
});

it("contains saved favicon preference read failures", async () => {
  const app = dashboard(() => ({ ok: true, tabs: [] }), {
    get: async (key) => {
      if (key === "faviconSize") throw new Error("Preference read denied");
      return {};
    },
  });
  await app.settle();
  assert.match(app.get("bulkError").textContent, /Preference read denied/);
});

it("contains favicon preference write failures", async () => {
  const app = dashboard(() => ({ ok: true, tabs: [] }), {
    set: async () => { throw new Error("Preference write denied"); },
  });
  await app.settle();
  app.get("faviconSize").value = "24";
  await app.get("faviconSize").listeners.input();
  await app.settle();
  assert.match(app.get("bulkError").textContent, /Preference write denied/);
});

it("refreshes the real dashboard after a rejected transport and partial closure", async () => {
  let tabs = [1, 2].map((id) => ({ id, title: "Example", url: "https://example.com" }));
  const app = dashboard((message) => {
    if (message.type === "getTabs") return { ok: true, tabs };
    tabs = tabs.filter((tab) => tab.id === 2);
    throw new Error("Message channel closed");
  });
  await app.settle();
  app.get("selectFiltered").listeners.click();
  await app.get("closeSelected").listeners.click();
  assert.match(app.get("bulkError").textContent, /Message channel closed/);
  assert.deepEqual(Array.from(app.run("selectedTabIds")), [2]);
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [2]);
  assert.equal(app.get("closeSelected").disabled, false);
});

it("contains initial load failures and retains known tabs on rejected or malformed refresh", async () => {
  let response = { ok: false, error: "Query denied" };
  const app = dashboard(() => response);
  await app.settle();
  assert.match(app.get("bulkError").textContent, /Query denied/);
  response = { ok: true, tabs: [{ id: 1, windowId: 2, title: "Known", url: "https://example.com" }] };
  await app.get("refresh").listeners.click();
  assert.equal(app.run("allTabs.length"), 1);
  response = { ok: true, tabs: null };
  await app.get("refresh").listeners.click();
  assert.equal(app.run("allTabs.length"), 1);
  assert.match(app.get("bulkError").textContent, /refresh|response/i);
});
