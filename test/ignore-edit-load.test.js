const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute complete production scripts and actual handlers; defer only browser I/O.
const uiSource = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(uiSource.slice(0, uiSource.indexOf("for (const [selector, type]")) + ";dashboard", { require, __dirname, URL, setImmediate });
const tab = (id, domain) => ({ id, windowId: 1, title: `Tab ${id}`, url: `https://${domain}/page` });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function fixture(initial = {}) {
  let saved = clone(initial);
  const reads = [];
  const queries = [];
  const writes = [];
  let pending = false;
  let holdWrites = false;
  const app = dashboard(() => {
    if (!pending) return { ok: true, tabs: [tab(1, "a.test"), tab(2, "b.test")] };
    const query = deferred();
    queries.push(query);
    return query.promise;
  }, {
    get: (keys) => {
      if (keys === "faviconSize") return Promise.resolve({});
      const snapshot = clone(saved);
      if (!pending) return Promise.resolve(snapshot);
      const read = deferred();
      reads.push({ ...read, snapshot });
      return read.promise;
    },
    set: async (value) => {
      const write = { ...deferred(), value: clone(value) };
      writes.push(write);
      if (holdWrites) await write.promise;
      saved = clone(value);
    },
  });
  return { app, reads, queries, writes,
    start() { pending = true; },
    holdWrites() { holdWrites = true; },
    saved: () => clone(saved),
  };
}
function clickRow(app, id, selector) {
  const row = app.get("tab-body").children.find((entry) => entry.dataset.tabId === String(id));
  assert.ok(row, `row ${id} exists before the edit`);
  row.querySelector(selector).listeners.click({ stopPropagation() {} });
}
function assertChoices(app, urls, domains, visible) {
  assert.deepEqual(Array.from(app.run("ignoredUrls")).sort(), urls);
  assert.deepEqual(Array.from(app.run("ignoredDomains")).sort(), domains);
  assert.equal(app.get("ignoredCount").textContent, `${urls.length} URLs, ${domains.length} domains`);
  assert.deepEqual(Array.from(app.get("tab-body").children, (row) => Number(row.dataset.tabId)), visible);
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [1, 2, 3], "winning inventory still publishes");
}

it("row ignoreDomain survives a load's older preference snapshot and the next save", async () => {
  const { app, reads, queries, saved, start } = fixture();
  await app.settle();
  start();
  const refresh = app.get("refresh").listeners.click();
  reads[0].resolve(reads[0].snapshot);
  await app.settle();
  clickRow(app, 1, ".btn-ignore-domain");
  await app.settle();
  assert.deepEqual(saved(), { ignoredUrls: [], ignoredDomains: ["a.test"] });
  queries[0].resolve({ ok: true, tabs: [tab(1, "a.test"), tab(2, "b.test"), tab(3, "c.test")] });
  await refresh;
  assertChoices(app, [], ["a.test"], [2, 3]);
  clickRow(app, 2, ".btn-ignore-domain");
  await app.settle();
  assert.deepEqual(saved(), { ignoredUrls: [], ignoredDomains: ["a.test", "b.test"] });
});

const cases = {
  ignoreDomain: { initial: {}, urls: [], domains: ["a.test"], visible: [2, 3],
    edit: (app) => clickRow(app, 1, ".btn-ignore-domain") },
  ignoreUrl: { initial: {}, urls: ["https://a.test/page"], domains: [], visible: [2, 3],
    edit: (app) => clickRow(app, 1, ".btn-ignore-url") },
  unignoreUrl: { initial: { ignoredUrls: ["https://a.test/page", "https://keep.test/page"] },
    urls: ["https://keep.test/page"], domains: [], visible: [1, 2, 3],
    edit: (app) => app.get("ignoredUrlList").children[0].querySelector(".btn-unignore").listeners.click() },
  unignoreDomain: { initial: { ignoredDomains: ["a.test", "keep.test"] },
    urls: [], domains: ["keep.test"], visible: [1, 2, 3],
    edit: (app) => app.get("ignoredDomainList").children[0].querySelector(".btn-unignore").listeners.click() },
  resetIgnores: { initial: { ignoredUrls: ["https://a.test/page"], ignoredDomains: ["keep.test"] },
    urls: [], domains: [], visible: [1, 2, 3],
    edit: (app) => {
      app.run("globalThis.confirm = () => true");
      app.get("resetIgnored").listeners.click();
    } },
};

for (const action of ["ignoreUrl", "unignoreUrl", "unignoreDomain", "resetIgnores"]) {
  it(`${action} survives a load's older preference snapshot and the next save`, async () => {
    const scenario = cases[action];
    const { app, reads, queries, saved, start } = fixture(scenario.initial);
    await app.settle();
    start();
    const refresh = app.get("refresh").listeners.click();
    reads[0].resolve(reads[0].snapshot);
    await app.settle();
    scenario.edit(app);
    await app.settle();
    assert.deepEqual(saved(), { ignoredUrls: scenario.urls, ignoredDomains: scenario.domains });
    queries[0].resolve({ ok: true, tabs: [tab(1, "a.test"), tab(2, "b.test"), tab(3, "c.test")] });
    await refresh;
    assertChoices(app, scenario.urls, scenario.domains, scenario.visible);
    clickRow(app, 2, ".btn-ignore-domain");
    await app.settle();
    assert.deepEqual(saved(), { ignoredUrls: scenario.urls, ignoredDomains: [...scenario.domains, "b.test"] });
  });
}

it("targeted load begun during an ignore save retains the edit even after that save settles", async () => {
  const { app, reads, queries, writes, saved, start, holdWrites } = fixture();
  await app.settle();
  holdWrites();
  clickRow(app, 1, ".btn-ignore-domain");
  assert.equal(writes.length, 1);
  start();
  const responses = [];
  assert.equal(app.messageListeners[0]({ type: "refreshDashboard", tabId: 100 }, {},
    (response) => responses.push(clone(response))), true);
  writes[0].resolve();
  await app.settle();
  assert.deepEqual(saved(), { ignoredUrls: [], ignoredDomains: ["a.test"] });
  reads[0].resolve(reads[0].snapshot);
  await app.settle();
  assert.deepEqual(responses, [], "acknowledgment still waits for inventory");
  queries[0].resolve({ ok: true, tabs: [tab(1, "a.test"), tab(2, "b.test"), tab(3, "c.test")] });
  await app.settle();
  assertChoices(app, [], ["a.test"], [2, 3]);
  assert.deepEqual(responses, [{ ok: true }]);
  clickRow(app, 2, ".btn-ignore-domain");
  writes[1].resolve();
  await app.settle();
  assert.deepEqual(saved(), { ignoredUrls: [], ignoredDomains: ["a.test", "b.test"] });
});

for (const [action, scenario] of Object.entries(cases)) {
  for (const window of ["preference read pending", "save pending before load"]) {
    it(`${action} retains current choices with ${window}`, async () => {
      const { app, reads, queries, writes, saved, start, holdWrites } = fixture(scenario.initial);
      await app.settle();
      let refresh;
      if (window === "save pending before load") {
        holdWrites();
        scenario.edit(app);
        assert.equal(writes.length, 1);
        start();
        refresh = app.get("refresh").listeners.click();
        // The read captured old storage; finish the save before publication.
        writes[0].resolve();
      } else {
        start();
        refresh = app.get("refresh").listeners.click();
        scenario.edit(app);
      }
      await app.settle();
      assert.deepEqual(saved(), { ignoredUrls: scenario.urls, ignoredDomains: scenario.domains });
      reads[0].resolve(reads[0].snapshot);
      await app.settle();
      queries[0].resolve({ ok: true, tabs: [tab(1, "a.test"), tab(2, "b.test"), tab(3, "c.test")] });
      await refresh;
      assertChoices(app, scenario.urls, scenario.domains, scenario.visible);
      clickRow(app, 2, ".btn-ignore-domain");
      writes[1].resolve();
      await app.settle();
      assert.deepEqual(saved(), { ignoredUrls: scenario.urls, ignoredDomains: [...scenario.domains, "b.test"] });
    });
  }
}

it("a second pending save remains protected after the first save completes", async () => {
  const { app, reads, queries, writes, saved, start, holdWrites } = fixture();
  await app.settle();
  holdWrites();
  clickRow(app, 1, ".btn-ignore-domain");
  clickRow(app, 2, ".btn-ignore-domain");
  writes[0].resolve();
  await app.settle();
  start();
  const refresh = app.get("refresh").listeners.click();
  reads[0].resolve(reads[0].snapshot);
  await app.settle();
  queries[0].resolve({ ok: true, tabs: [tab(1, "a.test"), tab(2, "b.test"), tab(3, "c.test")] });
  await refresh;
  assertChoices(app, [], ["a.test", "b.test"], [3]);
  writes[1].resolve();
  await app.settle();
  assert.deepEqual(saved(), { ignoredUrls: [], ignoredDomains: ["a.test", "b.test"] });
});

for (const failure of ["rejection", "synchronous throw"]) {
  it(`propagates storage ${failure} and releases the pending-save guard for the next load`, async () => {
    const { app, reads, queries, writes, start, holdWrites } = fixture({ ignoredDomains: ["keep.test"] });
    await app.settle();
    let edit;
    if (failure === "rejection") {
      holdWrites();
      edit = app.run('ignoreDomain("a.test")');
    } else {
      app.run('api.storage.local.set = () => { throw new Error("Save denied"); }');
      edit = app.run('ignoreDomain("a.test")');
    }
    const rejected = assert.rejects(edit, /Save denied/);
    if (failure === "rejection") writes[0].reject(new Error("Save denied"));
    await rejected;
    start();
    const refresh = app.get("refresh").listeners.click();
    reads[0].resolve(reads[0].snapshot);
    await app.settle();
    queries[0].resolve({ ok: true, tabs: [tab(1, "a.test"), tab(2, "b.test"), tab(3, "c.test")] });
    await refresh;
    assertChoices(app, [], ["keep.test"], [1, 2, 3]);
  });
}

it("empty ignore inputs and a cancelled reset do not block a fresh stored preference read", async () => {
  const { app, reads, queries, writes, start } = fixture();
  await app.settle();
  start();
  const refresh = app.get("refresh").listeners.click();
  await app.run('ignoreUrl("")');
  await app.run('ignoreDomain("")');
  app.run("globalThis.confirm = () => false");
  app.get("resetIgnored").listeners.click();
  assert.equal(writes.length, 0);
  reads[0].resolve({ ignoredDomains: ["a.test"] });
  await app.settle();
  queries[0].resolve({ ok: true, tabs: [tab(1, "a.test"), tab(2, "b.test"), tab(3, "c.test")] });
  await refresh;
  assertChoices(app, [], ["a.test"], [2, 3]);
});

