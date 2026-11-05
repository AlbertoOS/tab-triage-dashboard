const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function background(overrides = {}, namespace = "chrome") {
  let listener;
  let click;
  const warnings = [];
  const api = {
    action: { onClicked: { addListener(fn) { click = fn; } } },
    runtime: {
      getURL: () => "chrome-extension://fixture/triage.html",
      onMessage: { addListener(fn) { listener = fn; } },
    },
    tabs: { query: async () => [], remove: async () => {},
      get: async (id) => ({ id, active: false, discarded: false }), ...overrides.tabs },
    windows: { update: async () => {}, ...overrides.windows },
    sessions: overrides.sessions,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), { [namespace]: api, console: { error: (...args) => warnings.push(args) } });
  const send = (message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No command response")), 100);
    listener(message, {}, (response) => { clearTimeout(timer); resolve(response); });
  });
  send.click = (tab) => click(tab);
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
    let completed = false;
    const send = background({ tabs: {
      get: async (id) => ({ id, active: false, discarded: completed }),
      [method]: (id) => {
        calledId = id;
        return new Promise((resolve) => { complete = () => { completed = true; resolve(); }; });
      },
    } });
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

for (const namespace of ["browser", "chrome"]) {
  it(`reuses an existing dashboard and focuses its window through ${namespace}`, async () => {
    const events = [];
    const send = background({ tabs: {
      query: async () => [{ id: 4, windowId: 2, url: "chrome-extension://fixture/triage.html" }],
      update: async (id, properties) => { events.push(["activate", id, properties.active]); },
      create: async () => { events.push(["create"]); },
    }, windows: {
      update: async (id, properties) => { events.push(["focus", id, properties.focused]); },
    } }, namespace);
    await send.click({ windowId: 1, incognito: false });
    assert.deepEqual(events, [["activate", 4, true], ["focus", 2, true]]);
    assert.equal(send.warnings.length, 0);
  });
}

for (const candidate of [
  { url: "chrome-extension://fixture/triage.html?view=all#tabs" },
  { url: "about:blank", pendingUrl: "chrome-extension://fixture/triage.html" },
]) {
  it("recognizes the dashboard's real path while loaded or pending", async () => {
    let activated;
    let created = false;
    const send = background({ tabs: {
      query: async () => [{ id: 4, windowId: 2, ...candidate }],
      update: async (id) => { activated = id; },
      create: async () => { created = true; },
    } });
    await send.click({ windowId: 1 });
    assert.equal(activated, 4);
    assert.equal(created, false);
  });
}

it("prefers the clicked window's dashboard without crossing private browsing contexts", async () => {
  const activated = [];
  const send = background({ tabs: {
    query: async () => [
      { id: 1, windowId: 7, incognito: true, url: "chrome-extension://fixture/triage.html" },
      { id: 2, windowId: 8, incognito: false, url: "chrome-extension://fixture/triage.html" },
      { id: 3, windowId: 7, incognito: false, url: "chrome-extension://fixture/triage.html" },
    ],
    update: async (id) => { activated.push(id); },
    create: async () => { assert.fail("reuse an existing dashboard"); },
  } });
  await send.click({ windowId: 7, incognito: false });
  await send.click({ windowId: 8, incognito: true });
  assert.deepEqual(activated, [3, 1]);
});

it("creates an active dashboard in the clicked window only when no matching dashboard exists", async () => {
  let created;
  const send = background({ tabs: {
    query: async () => [
      { id: 1, incognito: true, url: "chrome-extension://fixture/triage.html" },
      { id: 2, url: "https://example.com/triage.html" },
      { id: 3, url: "chrome-extension://fixture/triage.html.backup" },
      { id: 4, url: "chrome-extension://fixture/triage.html", pendingUrl: "https://example.com" },
    ],
    update: async () => { assert.fail("do not activate unrelated or departing tabs"); },
    create: async (properties) => { created = JSON.parse(JSON.stringify(properties)); },
  } });
  await send.click({ windowId: 9, incognito: false });
  assert.deepEqual(created, { url: "chrome-extension://fixture/triage.html", active: true, windowId: 9 });
});

it("coalesces overlapping toolbar clicks and permits another click after completion", async () => {
  const queries = [];
  let created = 0;
  let activated = 0;
  const send = background({ tabs: {
    query: () => new Promise((resolve) => { queries.push(resolve); }),
    create: async () => { created++; },
    update: async () => { activated++; },
  } });
  const first = send.click({ windowId: 7 });
  const second = send.click({ windowId: 7 });
  await new Promise(setImmediate);
  const overlappingQueries = queries.length;
  for (const resolve of queries.splice(0)) resolve([]);
  await Promise.all([first, second]);
  assert.equal(overlappingQueries, 1);
  assert.equal(created, 1);
  const third = send.click({ windowId: 7 });
  await new Promise(setImmediate);
  assert.equal(queries.length, 1);
  queries[0]([{ id: 1, windowId: 7, url: "chrome-extension://fixture/triage.html" }]);
  await third;
  assert.equal(activated, 1);
  assert.equal(created, 1);
});

it("keeps simultaneous regular and private launches independent", async () => {
  const queries = [];
  const windows = [];
  const send = background({ tabs: {
    query: () => new Promise((resolve) => { queries.push(resolve); }),
    create: async (properties) => { windows.push(properties.windowId); },
  } });
  const opens = [
    send.click({ windowId: 1, incognito: false }),
    send.click({ windowId: 2, incognito: true }),
    send.click({ windowId: 1, incognito: false }),
    send.click({ windowId: 2, incognito: true }),
  ];
  await new Promise(setImmediate);
  assert.equal(queries.length, 2);
  for (const resolve of queries) resolve([]);
  await Promise.all(opens);
  assert.deepEqual(windows, [1, 2]);
});

for (const stage of ["query", "activate", "focus"]) {
  it(`contains toolbar ${stage} failures without creating duplicates and permits retry`, async () => {
    let queries = 0;
    let created = 0;
    const fail = async () => { throw new Error("Operation denied"); };
    const send = background({ tabs: {
      query: async () => {
        queries++;
        if (stage === "query") return fail();
        return [{ id: 1, windowId: 2, url: "chrome-extension://fixture/triage.html" }];
      },
      update: stage === "activate" ? fail : async () => {},
      create: async () => { created++; },
    }, windows: { update: stage === "focus" ? fail : async () => {} } });
    await send.click({ windowId: 2 });
    await send.click({ windowId: 2 });
    assert.equal(queries, 2, "failure must release the in-flight launch");
    assert.equal(created, 0, "do not fall back to duplicates when reuse fails");
    assert.equal(send.warnings.length, 2);
    assert.match(send.warnings[0].join(" "), /Operation denied/);
  });
}
