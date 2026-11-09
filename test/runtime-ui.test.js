const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

// Only browser/DOM boundaries are mocked; execute the complete dashboard source.
function dashboard(sendMessage, storage = {}, browser = {}) {
  const elements = new Map();
  const documentListeners = {};
  const timers = new Map();
  let now = 0;
  const wallStart = Date.now();
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
      tag, offsetHeight: 0,
      children: [], listeners: {}, dataset: {}, style: { setProperty() {} }, value: "", hidden: true,
      get parentElement() { return this.parent; },
      get classList() {
        const node = this;
        return {
          contains: (name) => (node.className || "").split(" ").includes(name),
          add(...names) { node.className = [...new Set([...(node.className || "").split(" ").filter(Boolean), ...names])].join(" "); },
          remove(...names) { node.className = (node.className || "").split(" ").filter((name) => !names.includes(name)).join(" "); },
          toggle(name, force) {
            const add = force ?? !this.contains(name);
            if (add) this.add(name); else this.remove(name);
            return add;
          },
        };
      },
      appendChild(child) { this.children.push(child); child.parent = this; return child; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      removeAttribute(name) { delete this.attributes[name]; },
      set disabled(value) {
        this.isDisabled = value;
        if (value && activeElement === this) activeElement = undefined;
      },
      get disabled() { return this.isDisabled || false; },
      focus() { if (!this.disabled) activeElement = this; },
      open: false,
      showModal() { this.open = true; },
      close(value = "") { this.returnValue = value; this.open = false; this.listeners.close?.(); },
      getBoundingClientRect() { return { top: 100, bottom: 124, right: 200, width: 120, height: 80 }; },
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
      set textContent(value) { this.text = String(value); this.children = []; },
      get textContent() { return this.text || ""; },
    };
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  get("groupBy").value = "none";
  const html = fs.readFileSync(path.join(__dirname, "../triage.html"), "utf8");
  // Read static controls from shipped markup, including their declared bounds.
  const staticControlIds = new Set();
  for (const [, tag, attributes] of html.matchAll(/<(input|select)\b([^>]*)>/g)) {
    const id = attributes.match(/\bid="([^"]+)"/)?.[1];
    if (!id) continue;
    staticControlIds.add(id);
    const node = get(id);
    node.tag = tag;
    for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(name, value);
    if (node.getAttribute("value") !== null) node.value = node.getAttribute("value");
    if (tag === "select") {
      const options = html.slice(html.indexOf(`<select${attributes}>`) + attributes.length + 8).split("</select>")[0];
      node.value = options.match(/<option\s+value="([^"]+)"/)?.[1] || "";
    }
  }
  // Bind dialog controls to the shipped HTML rather than inventing fixture nodes.
  // This parses static markup only; native modality/Tab traversal need browser acceptance.
  const helpMarkup = [...html.matchAll(/<dialog\b[\s\S]*?<\/dialog>/g)].map(([markup]) => markup).join("");
  const helpStack = [];
  for (const [token] of helpMarkup.matchAll(/<[^>]+>|[^<]+/g)) {
    if (token.startsWith("</")) {
      helpStack.pop();
    } else if (token.startsWith("<")) {
      const node = element(token.match(/^<([\w-]+)/)[1]);
      for (const [, name, value] of token.matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(name, value);
      node.tag = token.match(/^<([\w-]+)/)[1];
      const id = node.getAttribute("id");
      if (id) elements.set(id, node);
      if (helpStack.length) helpStack.at(-1).appendChild(node);
      helpStack.push(node);
    } else if (helpStack.length) {
      helpStack.at(-1).text = (helpStack.at(-1).text || "") + token;
    }
  }
  const headers = [];
  const ageInputs = [...html.matchAll(/<input\b([^>]*name="filterAge"[^>]*)>/g)].map(([, attributes]) => {
    const node = element("input");
    node.name = "filterAge";
    node.value = attributes.match(/value="([^"]+)"/)[1];
    node.checked = false;
    return node;
  });
  const statusButtons = [...html.matchAll(/<button\b([^>]*class="status-toggle"[^>]*)>/g)].map(([, attributes]) => {
    const node = element("button");
    node.className = "status-toggle";
    node.dataset.status = attributes.match(/data-status="([^"]+)"/)[1];
    node.dataset.state = attributes.match(/data-state="([^"]+)"/)[1];
    return node;
  });
  for (const [, attributes, label] of html.matchAll(/<th\b([^>]*)>([^<]*)/g)) {
    const sort = attributes.match(/data-sort="([^"]+)"/);
    if (!sort) continue;
    const header = element("th");
    header.dataset.sort = sort[1];
    header.className = attributes.match(/class="([^"]+)"/)[1];
    header.textContent = label;
    header.closest = (selector) => selector === "th.sortable" ? header : null;
    header.classList = {
      contains: (name) => header.className.split(" ").includes(name),
      add(...names) { header.className = [...new Set([...header.className.split(" "), ...names])].join(" "); },
      remove(...names) { header.className = header.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
    };
    get("thead").appendChild(header);
    headers.push(header);
  }
  const messages = [];
  const messageListeners = [];
  const resizeObservers = [];
  const context = vm.createContext({
    URL, console,
    Date: class extends Date { static now() { return wallStart + now; } },
    ResizeObserver: class {
      constructor(callback) { resizeObservers.push(callback); }
      observe() {}
    },
    getComputedStyle: () => ({ bottom: "24px", rowGap: "12px" }),
    setTimeout(callback, delay = 0) {
      timers.set(++timerId, { callback, at: now + delay });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    window: { innerWidth: 1200, innerHeight: 800, addEventListener() {} },
    chrome: {
      tabs: { getCurrent: async () => ({ id: 100 }), ...browser.tabs },
      runtime: { id: "fixture", getURL: () => "chrome-extension://fixture/triage.html",
        onMessage: { addListener(fn) { messageListeners.push(fn); } },
        sendMessage: async (message) => {
          messages.push(message);
          return sendMessage(message);
        },
        ...browser.runtime,
      },
      storage: { local: { get: async () => ({}), set: async () => {}, ...storage } },
    },
    document: { hidden: false, visibilityState: "visible", get activeElement() { return activeElement; },
      getElementById: get, createElement: element,
      querySelectorAll: (selector) => {
        if (selector === ".status-toggle") return statusButtons;
        if (selector === 'input[name="filterAge"]') return ageInputs;
        if (selector === 'input[name="filterAge"]:checked') return ageInputs.filter((input) => input.checked);
        if (selector === '#domainList label:not([style*="display: none"]) input') {
          return get("domainList").children.filter((label) => label.style.display !== "none").map((label) => label.querySelector("input"));
        }
        if (selector === "#domainList label") return get("domainList").children;
        if (selector === ".more-menu.open") {
          return get("tab-body").children.map((row) => row.querySelector(".more-menu"))
            .filter((menu) => menu?.classList.contains("open"));
        }
        if (selector === "th.sortable") return headers;
        if (selector === 'input[name="filterDomain"]' || selector === 'input[name="filterDomain"]:checked') {
          return get("domainList").children.map((label) => label.querySelector("input"))
            .filter((input) => !selector.endsWith(":checked") || input.checked);
        }
        return [];
      },
      querySelector: get,
      addEventListener(type, listener) { documentListeners[type] = listener; },
      documentElement: element() },
  });
  for (const file of ["utils.js", "triage.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  return { get, staticControlIds, messages, messageListeners, documentListeners, advanceTime, resize: () => resizeObservers.forEach((callback) => callback()),
    run: (code) => vm.runInContext(code, context),
    settle: () => new Promise(setImmediate) };
}

for (const [selector, type] of [[".btn-close", "closeTab"], [".btn-goto", "goToTab"],
  [".btn-discard", "discardTab"], [".btn-dedup", "closeDuplicates"]]) {
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
  [".btn-close", "closeTab"], [".btn-dedup", "closeDuplicates"]]) {
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
    ["btn-filter-domain", "btn-discard", "btn-ignore-url", "btn-ignore-domain"]);
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

for (const [label, expected, directions] of [
  ["Age", [["2", "3", "1"], ["1", "3", "2"], ["1", "2", "3"]], ["desc", "asc", null]],
  ["Title", [["2", "1", "3"], ["3", "1", "2"], ["1", "2", "3"]], ["asc", "desc", null]],
  ["Domain", [["2", "1", "3"], ["3", "1", "2"], ["1", "2", "3"]], ["asc", "desc", null]],
]) {
  it(`cycles the real ${label} header through both directions and unsorted twice`, async () => {
    const tabs = [
      { id: 1, title: "Bravo", url: "https://bravo.example", lastAccessed: 3000 },
      { id: 2, title: "alpha", url: "https://alpha.example", lastAccessed: 1000 },
      { id: 3, title: "CHARLIE", url: "https://charlie.example", lastAccessed: 2000 },
    ];
    const app = dashboard(() => ({ ok: true, tabs }));
    await app.settle();
    const header = app.get("thead").children.find((item) => item.textContent === label);
    assert.ok(header, "use the header and sort key from the actual HTML");
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let step = 0; step < directions.length; step++) {
        app.get("thead").listeners.click({ target: header });
        assert.deepEqual(app.get("tab-body").children.map((row) => row.dataset.tabId), expected[step]);
        assert.equal(header.classList.contains("sort-asc"), directions[step] === "asc");
        assert.equal(header.classList.contains("sort-desc"), directions[step] === "desc");
        assert.equal(header.getAttribute("data-sort-order"), null);
      }
    }
    assert.equal(app.messages.length, 1, "sorting must not issue additional browser commands");
    assert.equal(app.messages[0].type, "getTabs");
    assert.deepEqual(tabs.map((tab) => tab.id), [1, 2, 3], "do not mutate the browser's input order");
  });
}

it("preserves each sortable column's default direction and completes its three-state cycle", async () => {
  const app = dashboard(() => ({ ok: true, tabs: [] }));
  await app.settle();
  for (const header of app.get("thead").children) {
    const first = header.textContent === "Title" || header.textContent === "Domain" ? "asc" : "desc";
    for (const direction of [first, first === "asc" ? "desc" : "asc", null]) {
      app.get("thead").listeners.click({ target: header });
      assert.equal(header.classList.contains("sort-asc"), direction === "asc", header.textContent);
      assert.equal(header.classList.contains("sort-desc"), direction === "desc", header.textContent);
      assert.equal(app.run("currentSort.length"), direction ? 1 : 0);
    }
  }
});

it("cycles secondary sorting without losing primary sorting and renumbers remaining priorities", async () => {
  const tabs = [
    { id: 1, title: "Bravo", url: "https://one.example", lastAccessed: 20 },
    { id: 2, title: "Alpha", url: "https://two.example", lastAccessed: 30 },
    { id: 3, title: "Bravo", url: "https://three.example", lastAccessed: 10 },
    { id: 4, title: "Alpha", url: "https://four.example", lastAccessed: 5 },
  ];
  const app = dashboard(() => ({ ok: true, tabs }));
  await app.settle();
  const title = app.get("thead").children.find((header) => header.textContent === "Title");
  const age = app.get("thead").children.find((header) => header.textContent === "Age");
  const click = (header) => app.get("thead").listeners.click({ target: { closest: () => header } });
  const order = () => app.get("tab-body").children.map((row) => row.dataset.tabId);
  click(title);
  assert.deepEqual(order(), ["2", "4", "1", "3"]);
  click(age);
  assert.deepEqual(order(), ["4", "2", "3", "1"]);
  assert.equal(title.getAttribute("data-sort-order"), "1");
  assert.equal(age.getAttribute("data-sort-order"), "2");
  click(age);
  assert.deepEqual(order(), ["2", "4", "1", "3"]);
  click(title);
  assert.deepEqual(order(), ["1", "3", "2", "4"]);
  click(title);
  assert.deepEqual(order(), ["2", "1", "3", "4"]);
  assert.equal(title.classList.contains("sort-asc"), false);
  assert.equal(title.classList.contains("sort-desc"), false);
  assert.equal(title.getAttribute("data-sort-order"), null);
  assert.equal(age.getAttribute("data-sort-order"), null);
  assert.equal(age.classList.contains("sort-asc"), true);
  app.get("thead").listeners.click({ target: { closest: () => null } });
  assert.deepEqual(order(), ["2", "1", "3", "4"], "ignore non-sortable headers");
  click(age);
  assert.deepEqual(order(), ["1", "2", "3", "4"]);
  assert.equal(app.run("currentSort.length"), 0);
});
