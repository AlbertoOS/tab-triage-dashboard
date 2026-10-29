const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

// Only browser/DOM boundaries are mocked; execute the complete dashboard source.
function dashboard(sendMessage, storage = {}) {
  const elements = new Map();
  function element(tag) {
    return {
      tag,
      children: [], listeners: {}, dataset: {}, style: { setProperty() {} }, value: "", hidden: true,
      classList: { toggle() {}, add() {}, remove() {} },
      appendChild(child) { this.children.push(child); child.parent = this; return child; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {},
      cloneNode() { return Object.assign(element(), { disabled: this.disabled }); },
      replaceWith(next) { for (const [id, value] of elements) if (value === this) elements.set(id, next); },
      querySelector(selector) {
        for (const child of this.children) {
          if (child.tag === selector || (child.className || "").split(" ").includes(selector.slice(1))) return child;
          const found = child.querySelector(selector);
          if (found) return found;
        }
        return null;
      },
      set innerHTML(value) { this.children = []; },
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
    URL, console, setTimeout: () => 1, clearTimeout() {},
    chrome: {
      runtime: { getURL: () => "chrome-extension://fixture/triage.html", sendMessage: async (message) => {
        messages.push(message);
        return sendMessage(message);
      } },
      storage: { local: { get: async () => ({}), set: async () => {}, ...storage } },
    },
    document: { getElementById: get, createElement: element, querySelectorAll: () => [],
      querySelector: get, addEventListener() {}, documentElement: element() },
  });
  for (const file of ["utils.js", "triage.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  return { get, messages, run: (code) => vm.runInContext(code, context),
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
