const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function background(overrides = {}) {
  let listener;
  let click;
  const warnings = [];
  const api = {
    action: { onClicked: { addListener(fn) { click = fn; } } },
    runtime: {
      getURL: () => "chrome-extension://fixture/triage.html",
      onMessage: { addListener(fn) { listener = fn; } },
    },
    tabs: { query: async () => [], remove: async () => {}, ...overrides.tabs },
    windows: { update: async () => {}, ...overrides.windows },
    sessions: overrides.sessions,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), { chrome: api, console: { error: (...args) => warnings.push(args) } });
  const send = (message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No command response")), 100);
    listener(message, {}, (response) => { clearTimeout(timer); resolve(response); });
  });
  send.click = () => click();
  send.warnings = warnings;
  return send;
}

it("rejects malformed command arguments without invoking tab removal", async () => {
  let removed = false;
  const send = background({ tabs: { remove: async () => { removed = true; } } });
  const response = await send({ type: "closeTab", tabId: "not-an-id" });
  assert.equal(response.ok, false);
  assert.equal(removed, false);
});

it("rejects malformed envelopes, batch IDs, window IDs and legacy bulk restore", async () => {
  let calls = 0;
  const forbidden = async () => { calls++; };
  const send = background({ tabs: { query: forbidden, remove: forbidden, update: forbidden },
    windows: { update: forbidden }, sessions: { restore: forbidden } });
  for (const message of [null, {}, { type: "unknown" }, { type: "closeTabs" },
    { type: "closeTabs", tabIds: "12" }, { type: "closeTabs", tabIds: [1, -2] },
    { type: "goToTab", tabId: 1, windowId: "2" }, { type: "restoreTabs", count: 10 }]) {
    const response = await send(message);
    assert.equal(response.ok, false, JSON.stringify(message));
    assert.equal(typeof response.error, "string");
  }
  assert.equal(calls, 0);
});

it("responds after focusing a tab and reports each browser operation failure", async () => {
  const events = [];
  const send = background({ tabs: { update: async () => { events.push("tab"); } },
    windows: { update: async () => { events.push("window"); } } });
  assert.equal((await send({ type: "goToTab", tabId: 1, windowId: 2 })).ok, true);
  assert.deepEqual(events, ["tab", "window"]);
  for (const [type, area, method] of [["goToTab", "windows", "update"], ["goToTab", "tabs", "update"],
    ["closeTab", "tabs", "remove"], ["discardTab", "tabs", "discard"],
    ["restoreTab", "sessions", "restore"]]) {
    const fail = async () => { throw new Error("Operation denied"); };
    const command = background({ tabs: { update: async () => {} }, [area]: { [method]: fail } });
    const response = await command({ type, tabId: 1, windowId: 2 });
    assert.equal(response.ok, false, type);
    assert.match(response.error, /Operation denied/);
  }
  assert.equal((await background()({ type: "restoreTab" })).ok, false);
});

it("catches toolbar page creation failures", async () => {
  const send = background({ tabs: { create: async () => { throw new Error("Creation denied"); } } });
  await send.click();
  await new Promise(setImmediate);
  assert.equal(send.warnings.length, 1);
  assert.match(send.warnings[0].join(" "), /Creation denied/);
});

it("restores exactly one session per explicit command", async () => {
  let calls = 0;
  const send = background({ sessions: { restore: async () => { calls++; } } });
  assert.equal((await send({ type: "restoreTab", count: 100 })).ok, true);
  assert.equal(calls, 1);
});

it("acknowledges successful single-tab commands only after their browser calls", async () => {
  for (const [type, method] of [["closeTab", "remove"], ["discardTab", "discard"]]) {
    let complete;
    let calledId;
    const send = background({ tabs: { [method]: (id) => {
      calledId = id;
      return new Promise((resolve) => { complete = resolve; });
    } } });
    let answered = false;
    const response = send({ type, tabId: 7 }).then((result) => { answered = true; return result; });
    await new Promise(setImmediate);
    assert.equal(calledId, 7);
    assert.equal(answered, false);
    complete();
    assert.equal((await response).ok, true);
  }
});

it("returns query failures to the dashboard", async () => {
  const send = background({ tabs: { query: async () => { throw new Error("Query denied"); } } });
  const response = await send({ type: "getTabs" });
  assert.equal(response.ok, false);
  assert.match(response.error, /Query denied/);
});
