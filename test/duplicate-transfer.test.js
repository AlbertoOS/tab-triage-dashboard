const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function tab(id, extra = {}) {
  return { id, url: "https://copies.example/page", windowId: 1, index: id,
    active: false, pinned: false, status: "complete", ...extra };
}

// Only browser I/O is replaced; commands execute the complete broker source.
function broker(initial, namespace = "browser", hooks = {}) {
  const tabs = new Map(initial.map((item) => [item.id, { ...item }]));
  const listeners = new Set();
  const stats = { queries: 0, queryRecords: 0, gets: 0, getRecords: 0, registrations: 0, removals: [] };
  let receive;
  const emit = (id) => { for (const listener of listeners) listener(id, { windowId: 1, isWindowClosing: false }); };
  const api = {
    action: { onClicked: { addListener() {} } },
    runtime: { getURL: () => "chrome-extension://fixture/triage.html",
      onMessage: { addListener(listener) { receive = listener; } } },
    tabs: {
      onRemoved: {
        addListener(listener) { stats.registrations++; listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
      },
      async query() {
        stats.queries++;
        await hooks.query?.(tabs, stats);
        const result = Array.from(tabs.values(), (item) => ({ ...item }));
        stats.queryRecords += result.length;
        return result;
      },
      async get(id) {
        stats.gets++;
        await hooks.get?.(id, tabs, stats);
        if (!tabs.has(id)) throw new Error("Unavailable tab");
        stats.getRecords++;
        return { ...tabs.get(id) };
      },
      async remove(id) {
        stats.removals.push(id);
        if (hooks.remove) return hooks.remove(id, tabs, emit);
        tabs.delete(id);
        emit(id);
      },
    },
  };
  if (hooks.noEvents) delete api.tabs.onRemoved;
  if (hooks.noGet) delete api.tabs.get;
  const context = vm.createContext({ [namespace]: api, URL, console, setTimeout, clearTimeout,
    importScripts: () => vm.runInContext(fs.readFileSync(path.join(__dirname, "../utils.js"), "utf8"), context) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  const send = (message) => new Promise((resolve) => receive(message, {}, resolve));
  return { tabs, stats, listeners, emit, send,
    plan: (mode, clickedId) => context.duplicateTools.buildDuplicatePlan([...tabs.values()], mode,
      api.runtime.getURL("triage.html"), clickedId),
  };
}

for (const namespace of ["browser", "chrome"]) {
  it(`accepts removal events delivered in the next task without full inventory transfers through ${namespace}`, async () => {
    const bg = broker(Array.from({ length: 20 }, (_, id) => tab(id)), namespace, {
      remove(id, tabs, emit) {
        tabs.delete(id);
        setTimeout(() => emit(id), 0);
      },
    });
    const { plan } = await bg.send({ type: "previewDuplicates" });
    const result = await bg.send({ type: "closeDuplicates", plan });
    assert.equal(result.closedCount, 19);
    assert.equal(bg.stats.queries, 1, "allow an already queued removal event to arrive before inventory fallback");
    assert.equal(bg.listeners.size, 0);
  });

  it(`transfers only linear tab records for 1000-copy closure through ${namespace}`, async (t) => {
    const bg = broker(Array.from({ length: 1000 }, (_, id) => tab(id)), namespace);
    const { plan } = await bg.send({ type: "previewDuplicates" });
    const result = await bg.send({ type: "closeDuplicates", plan });
    const { queries, queryRecords, gets, getRecords } = bg.stats;
    t.diagnostic(JSON.stringify({ namespace, queries, queryRecords, gets, getRecords, ...result }));
    assert.equal(result.closedCount, 999);
    assert.equal(result.skippedCount + result.failedCount + result.unverifiedCount, 0);
    assert.deepEqual(bg.stats.removals, Array.from({ length: 999 }, (_, i) => i + 1));
    assert.deepEqual([...bg.tabs.keys()], [0]);
    assert.equal(bg.stats.queries, 1, "execution must not repeatedly transfer the complete inventory");
    assert.equal(bg.stats.queryRecords, 1000);
    assert.equal(bg.stats.getRecords, 1998, "each candidate and one fixed preview keeper must be freshly read");
    assert.equal(bg.listeners.size, 0);
  });

  it(`reads only one live keeper per candidate among many protected preview keepers through ${namespace}`, async () => {
    const bg = broker(Array.from({ length: 1000 }, (_, id) => tab(id, { pinned: id < 500 })), namespace);
    const { plan } = await bg.send({ type: "previewDuplicates" });
    const result = await bg.send({ type: "closeDuplicates", plan });
    assert.equal(result.closedCount, 500);
    assert.equal(bg.stats.queries, 1);
    assert.equal(bg.stats.getRecords, 1000);
    assert.deepEqual([...bg.tabs.keys()], Array.from({ length: 500 }, (_, id) => id));
  });

  it(`preserves targeted live fences and the fixed preview scope through ${namespace}`, async () => {
    const bg = broker(Array.from({ length: 10 }, (_, id) => tab(id)), namespace);
    const { plan } = await bg.send({ type: "previewDuplicates" });
    bg.tabs.get(1).pinned = true;
    bg.tabs.get(2).active = true;
    bg.tabs.get(3).url += "/";
    bg.tabs.get(4).windowId = 2;
    bg.tabs.get(5).status = "loading";
    bg.tabs.get(6).pendingUrl = "chrome-extension://fixture/triage.html";
    bg.tabs.get(7).pendingUrl = "https://elsewhere.example/";
    bg.tabs.delete(8);
    bg.tabs.set(10, tab(10));
    bg.tabs.get(9).status = "loading";
    bg.tabs.get(9).pendingUrl = bg.tabs.get(9).url;
    const result = await bg.send({ type: "closeDuplicates", plan });
    assert.deepEqual(bg.stats.removals, [9]);
    assert.equal(result.closedCount, 1);
    assert.equal(result.skippedCount, 8);
    assert.ok(bg.tabs.has(10));
    assert.equal(bg.listeners.size, 0);
  });

  it(`rechecks a preferred keeper and falls back only to fixed preview keepers through ${namespace}`, async () => {
    const bg = broker([tab(0, { pinned: true }), tab(1, { active: true }), tab(2), tab(3), tab(4)], namespace, {
      remove(id, tabs, emit) {
        tabs.delete(id);
        emit(id);
        if (id === 2) tabs.get(0).status = "loading";
        if (id === 3) { tabs.delete(1); tabs.set(9, tab(9)); }
      },
    });
    const { plan } = await bg.send({ type: "previewDuplicates" });
    const result = await bg.send({ type: "closeDuplicates", plan });
    assert.deepEqual(bg.stats.removals, [2, 3]);
    assert.equal(result.closedCount, 2);
    assert.equal(result.skippedCount, 1);
    assert.ok(bg.tabs.has(4));
    assert.equal(bg.listeners.size, 0);
  });

  for (const mode of ["keep", "closeAll"]) {
    for (const externalActivation of [false, true]) {
      it(`preserves ${mode} successor activation with external activation ${externalActivation} through targeted ${namespace} checks`, async () => {
        const bg = broker([tab(1, { active: true }), tab(2), tab(3)], namespace, {
          remove(id, tabs, emit) {
            if (tabs.get(id).active) {
              const siblings = [...tabs.values()].filter((item) => item.id !== id);
              const next = siblings.find((item) => item.index > tabs.get(id).index) || siblings.at(-1);
              for (const item of siblings) item.active = item.id === next?.id;
            }
            tabs.delete(id);
            emit(id);
          },
        });
        const plan = bg.plan(mode, 3);
        if (externalActivation) {
          bg.tabs.get(1).active = false;
          bg.tabs.get(2).active = true;
        }
        const result = await bg.send({ type: "closeDuplicates", plan });
        const expected = externalActivation ? (mode === "keep" ? [1] : [3, 1]) :
          (mode === "keep" ? [2, 1] : [2, 3, 1]);
        assert.deepEqual(bg.stats.removals, expected);
        assert.equal(result.closedCount, expected.length);
        assert.equal(result.skippedCount, externalActivation ? 1 : 0);
        assert.equal(bg.listeners.size, 0);
      });
    }

    it(`retains confirmed ${mode} protection policy and inactive-first order through ${namespace}`, async () => {
      const bg = broker([tab(0), tab(1, { active: true, pinned: true }), tab(2), tab(3), tab(4)], namespace, {
        remove(id, tabs, emit) {
          tabs.delete(id);
          emit(id);
          if (id === 2) tabs.get(3).active = true;
        },
      });
      const { plan } = await bg.send({ type: "previewDuplicates" });
      plan.mode = mode;
      plan.groups[0].keeperIds = mode === "keep" ? [0] : [];
      plan.groups[0].candidates = [2, 3, 4, 1].map((id) => ({ ...bg.tabs.get(id) }));
      const result = await bg.send({ type: "closeDuplicates", plan });
      assert.deepEqual(bg.stats.removals, [2, 4, 1]);
      assert.equal(result.closedCount, 3);
      assert.equal(result.skippedCount, 1);
      assert.ok(bg.tabs.has(3));
    });
  }

  for (const outcome of ["denied", "no-op", "closed-rejected", "silent-closed", "unverified", "unrelated-event"]) {
    it(`reports authoritative ${outcome} readback without interpreting get errors as absence through ${namespace}`, async () => {
      let removing = false;
      const bg = broker([tab(0), tab(1)], namespace, {
        remove(id, tabs, emit) {
          removing = true;
          if (["closed-rejected", "silent-closed"].includes(outcome)) tabs.delete(id);
          if (outcome === "closed-rejected") emit(id);
          if (outcome === "unrelated-event") emit(99);
          if (["denied", "closed-rejected", "unverified"].includes(outcome)) throw new Error("Operation rejected");
        },
        get() { if (removing && ["unverified", "unrelated-event"].includes(outcome)) throw new Error("Temporary API failure"); },
        query() { if (removing && outcome === "unverified") throw new Error("Inventory unavailable"); },
      });
      const { plan } = await bg.send({ type: "previewDuplicates" });
      const result = await bg.send({ type: "closeDuplicates", plan });
      assert.equal(result.closedCount, ["closed-rejected", "silent-closed"].includes(outcome) ? 1 : 0);
      assert.equal(result.unverifiedCount, outcome === "unverified" ? 1 : 0);
      assert.equal(result.failedCount, ["denied", "no-op", "unrelated-event"].includes(outcome) ? 1 : 0);
      assert.equal(result.skippedCount, 0);
      assert.equal(bg.listeners.size, 0);
    });
  }

  it(`uses inventory fallback for transient preflight get errors through ${namespace}`, async () => {
    const bg = broker([tab(0), tab(1)], namespace, { get() { throw new Error("Temporary API failure"); } });
    const { plan } = await bg.send({ type: "previewDuplicates" });
    bg.tabs.get(1).active = true;
    const result = await bg.send({ type: "closeDuplicates", plan });
    assert.equal(result.skippedCount, 1);
    assert.deepEqual(bg.stats.removals, []);
    assert.equal(bg.stats.queries, 2);
    assert.equal(bg.listeners.size, 0);
  });

  it(`validates identities before registering listeners or calling tab APIs through ${namespace}`, async () => {
    const bg = broker([tab(0), tab(1)], namespace);
    const { plan } = await bg.send({ type: "previewDuplicates" });
    plan.groups[0].key = "https://unrelated.example";
    assert.equal((await bg.send({ type: "closeDuplicates", plan })).ok, false);
    assert.equal((await bg.send({ type: "closeDuplicates", plan: {} })).ok, false);
    assert.equal(bg.stats.queries, 1);
    assert.equal(bg.stats.gets, 0);
    assert.equal(bg.stats.registrations, 0);
    assert.equal(bg.listeners.size, 0);
  });

  it(`holds the shared closure gate until fallback readback completes through ${namespace}`, async () => {
    let release;
    let arrived;
    const reading = new Promise((resolve) => { arrived = resolve; });
    let removed = false;
    const bg = broker([tab(0), tab(1)], namespace, {
      remove(id, tabs) { tabs.delete(id); removed = true; },
      async query() {
        if (removed) { arrived(); await new Promise((resolve) => { release = resolve; }); }
      },
    });
    const { plan } = await bg.send({ type: "previewDuplicates" });
    const pending = bg.send({ type: "closeDuplicates", plan });
    await reading;
    for (const message of [{ type: "closeTab", tabId: 0 }, { type: "closeTabs", tabIds: [0] }, { type: "closeDuplicates", plan }]) {
      assert.equal((await bg.send(message)).ok, false);
    }
    assert.equal(bg.listeners.size, 1);
    release();
    assert.equal((await pending).closedCount, 1);
    assert.equal(bg.listeners.size, 0);
    assert.equal((await bg.send({ type: "closeTab", tabId: 0 })).ok, true);
  });

  for (const missing of ["noEvents", "noGet"]) {
    it(`retains honest query compatibility with ${missing} through ${namespace}`, async () => {
      const bg = broker([tab(0), tab(1)], namespace, { [missing]: true });
      const { plan } = await bg.send({ type: "previewDuplicates" });
      const result = await bg.send({ type: "closeDuplicates", plan });
      assert.equal(result.closedCount, 1);
      assert.equal(result.failedCount + result.unverifiedCount, 0);
      assert.equal(bg.listeners.size, 0);
    });
  }
}
