const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Reuse full-source fixtures, replacing only DOM and browser API boundaries.
const uiSource = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(uiSource.slice(0, uiSource.indexOf("for (const [selector, type]")) + ";dashboard", { require, __dirname, URL, setImmediate });
const brokerSource = fs.readFileSync(path.join(__dirname, "commands.test.js"), "utf8");
const background = vm.runInNewContext(brokerSource.slice(0, brokerSource.indexOf('it("rejects malformed')) + ";background", { require, __dirname, setTimeout, clearTimeout });
const dashboardUrl = "chrome-extension://fixture/triage.html";
const tab = (id, title = `Tab ${id}`) => ({ id, windowId: 1, title, url: `https://example.test/${id}` });

function reuseHarness(initialTabs, candidates = [{ id: 100, windowId: 1, url: dashboardUrl }]) {
  let tabs = initialTabs;
  let queryError;
  const pages = [];
  const broadcasts = [];
  const returns = [];
  const responses = [];
  const events = [];
  const send = background({
    runtime: { sendMessage: (message) => {
      broadcasts.push(JSON.parse(JSON.stringify(message)));
      // runtime.sendMessage excludes the sending background context. In contrast,
      // each page's getTabs command below reaches the real broker and other pages.
      return new Promise((resolve, reject) => {
        let open = false;
        for (const page of pages) {
          for (const listener of page.messageListeners) {
            const returned = listener(message, { id: "fixture" }, (response) => {
              responses.push(response);
              resolve(response);
            });
            returns.push(returned);
            open ||= returned === true;
          }
        }
        if (!open) reject(new Error("Receiving end does not exist."));
      });
    } },
    tabs: {
      query: async () => {
        if (queryError && broadcasts.length) throw new Error(queryError);
        return [...candidates, ...tabs];
      },
      update: async (id) => { events.push(["activate", id]); },
      create: async () => { assert.fail("reuse must not create another dashboard"); },
    },
    windows: { update: async (id) => { events.push(["focus", id]); } },
  });
  function page(id = 100, storage = {}) {
    const app = dashboard((message) => {
      for (const other of pages) {
        if (other === app) continue;
        for (const listener of other.messageListeners) {
          assert.equal(listener(message, { id: "fixture", tab: { id } }, () => {
            assert.fail("dashboard must not compete with the command broker");
          }), false);
        }
      }
      return send(message);
    }, storage, { tabs: { getCurrent: async () => ({ id }) } });
    pages.push(app);
    return app;
  }
  return { send, page, broadcasts, returns, responses, events,
    setTabs(value) { tabs = value; },
    failRefresh(error) { queryError = error; } };
}

it("refreshes inventory on every already-active dashboard reuse", async () => {
  const harness = reuseHarness([tab(1, "Old title"), tab(2)]);
  const app = harness.page();
  await app.settle();
  for (const title of ["Updated title", "Updated again"]) {
    harness.setTabs([tab(1, title), tab(3)]);
    await harness.send.click({ id: 100, windowId: 1, active: true });
    await app.settle();
    assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [100, 1, 3]);
    assert.equal(app.run("allTabs.find((tab) => tab.id === 1).title"), title);
    assert.deepEqual(Array.from(app.get("tab-body").children, (row) => row.dataset.tabId), ["100", "1", "3"]);
  }
  assert.deepEqual(harness.broadcasts, [
    { type: "refreshDashboard", tabId: 100 }, { type: "refreshDashboard", tabId: 100 },
  ]);
  assert.deepEqual(harness.returns, [true, true], "Chrome 121 requires literal true, not a Promise listener");
  assert.equal(harness.responses.length, 2);
  assert.equal(app.messages.length, 3, "initial load plus one inventory query per reuse");
  assert.equal(harness.send.warnings.length, 0);
});

it("reports failed reuse refresh without claiming fresh inventory and permits retry", async () => {
  const harness = reuseHarness([tab(1)]);
  const app = harness.page();
  await app.settle();
  harness.failRefresh("Inventory denied");
  await harness.send.click({ windowId: 1 });
  assert.equal(harness.responses[0]?.ok, false);
  assert.match(harness.responses[0].error, /Inventory denied/);
  assert.match(app.get("bulkError").textContent, /Inventory denied/);
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [100, 1]);
  assert.equal(harness.send.warnings.length, 1);
  harness.failRefresh(null);
  harness.setTabs([tab(2)]);
  await harness.send.click({ windowId: 1 });
  assert.equal(harness.responses[1]?.ok, true);
  assert.equal(app.get("bulkError").textContent, "");
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [100, 2]);
});

it("still loads inventory when current-tab identity lookup fails", async () => {
  const app = dashboard(() => ({ ok: true, tabs: [tab(1)] }), {}, {
    tabs: { getCurrent: async () => { throw new Error("Identity denied"); } },
  });
  await app.settle();
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [1]);
  assert.match(app.get("bulkError").textContent, /Identity denied/);
  assert.equal(app.messageListeners.length, 0, "do not install a listener with unknown identity");
});

it("refreshes only the chosen cross-window page and preserves its UI state", async () => {
  const harness = reuseHarness([tab(1, "Keep Bravo"), tab(2, "Keep Charlie"), tab(3, "Other")], [
    { id: 100, windowId: 7, url: dashboardUrl },
    { id: 101, windowId: 8, url: dashboardUrl },
  ]);
  let saved = {};
  const app = harness.page(100, { get: async () => saved });
  const other = harness.page(101);
  await app.settle();
  app.get("search").value = "Keep";
  app.get("fuzzyToggle").listeners.click();
  const domain = app.get("domainList").children.find((label) => label.querySelector("input").value === "example.test")
    .querySelector("input");
  domain.checked = true;
  domain.listeners.change();
  const title = app.get("thead").children.find((header) => header.textContent === "Title");
  app.get("thead").listeners.click({ target: title });
  app.get("selectFiltered").listeners.click();
  app.run('collapsedGroups.add("preserved"); showUndoToast("Previous close completed.")');
  const recovery = app.get("undo-toast-btn");
  recovery.focus();
  saved = { ignoredUrls: ["https://example.test/5"], ignoredDomains: ["ignored.test"] };
  harness.setTabs([tab(1, "Keep Zebra"), tab(4, "Keep Alpha"), tab(5, "Keep Ignored")]);
  // No dashboard in the clicked window: choose the first dashboard in another window.
  await harness.send.click({ windowId: 9 });
  assert.deepEqual(harness.events, [["activate", 100], ["focus", 7]]);
  assert.deepEqual(harness.returns, [true, false]);
  assert.equal(harness.responses.length, 1, "non-target pages must not respond");
  assert.equal(other.messages.length, 1, "do not refresh another dashboard");
  assert.deepEqual(Array.from(app.get("tab-body").children, (row) => row.dataset.tabId), ["4", "1"]);
  assert.deepEqual(Array.from(app.run("selectedTabIds")), [1], "prune removed selection without selecting new tabs");
  assert.equal(app.get("search").value, "Keep");
  assert.equal(app.run("fuzzySearch"), true);
  assert.equal(app.run('collapsedGroups.has("preserved")'), true);
  assert.equal(app.get("domainDropdownBtn").textContent, "example.test");
  assert.equal(title.classList.contains("sort-asc"), true);
  assert.equal(app.run('ignoredDomains.has("ignored.test")'), true);
  assert.equal(app.get("undo-toast").hidden, false);
  assert.equal(app.get("undo-toast-btn"), recovery);
  assert.equal(app.get("undo-toast-msg").textContent, "Previous close completed.");
  assert.equal(app.run("document.activeElement"), recovery);
  // Page listeners decline ordinary commands, and direct notifications sent to
  // the broker are still invalid commands (no exception to the allowlist).
  assert.equal((await harness.send({ type: "refreshDashboard", tabId: 100 })).ok, false);
  for (const message of [null, {}, { type: "getTabs" }, { type: "unknown" },
    { type: "refreshDashboard", tabId: "100" }, { type: "refreshDashboard", tabId: -1 }]) {
    assert.equal(app.messageListeners[0](message, {}, () => assert.fail("unexpected response")), false);
  }
});

it("contains missing receivers during pending navigation and permits loaded reuse", async () => {
  const harness = reuseHarness([tab(1)], [
    { id: 100, windowId: 1, url: "about:blank", pendingUrl: dashboardUrl },
  ]);
  await harness.send.click({ windowId: 1 });
  assert.equal(harness.send.warnings.length, 1);
  assert.match(harness.send.warnings[0].join(" "), /Receiving end/);
  harness.setTabs([tab(2)]);
  const app = harness.page();
  await app.settle();
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [100, 2], "initial load covers a missed notification");
  harness.setTabs([tab(3)]);
  await harness.send.click({ windowId: 1 });
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [100, 3]);
  assert.equal(harness.send.warnings.length, 1, "retry released the in-flight map");
});

it("registers the target before starting initial inventory loading", async () => {
  let identify;
  const app = dashboard(() => ({ ok: true, tabs: [tab(1)] }), {}, {
    tabs: { getCurrent: () => new Promise((resolve) => { identify = resolve; }) },
  });
  await app.settle();
  assert.equal(app.messages.length, 0, "wait for identity before initial load");
  identify({ id: 100 });
  await app.settle();
  assert.equal(app.messageListeners.length, 1);
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [1]);
});

it("contains response-channel failure after successfully refreshing inventory", async () => {
  let tabs = [tab(1)];
  const app = dashboard(() => ({ ok: true, tabs }));
  await app.settle();
  tabs = [tab(2)];
  assert.equal(app.messageListeners[0]({ type: "refreshDashboard", tabId: 100 }, {}, () => {
    throw new Error("Response channel closed");
  }), true);
  await app.settle();
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [2]);
  assert.match(app.get("bulkError").textContent, /Response channel closed/);
});

for (const failure of ["transport", "malformed inventory", "ignore storage"]) {
  it(`contains ${failure} failure during targeted refresh and keeps prior inventory`, async () => {
    let fail = false;
    const app = dashboard(() => {
      if (fail && failure === "transport") throw new Error("Transport denied");
      return { ok: true, tabs: fail && failure === "malformed inventory" ? null : [tab(1)] };
    }, { get: async () => {
      if (fail && failure === "ignore storage") throw new Error("Storage denied");
      return {};
    } });
    await app.settle();
    app.get("selectFiltered").listeners.click();
    app.run('showUndoToast("Earlier close completed.")');
    const recovery = app.get("undo-toast-btn");
    fail = true;
    const responses = [];
    assert.equal(app.messageListeners[0]({ type: "refreshDashboard", tabId: 100 }, {}, (response) => {
      responses.push(response);
    }), true);
    await app.settle();
    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, false);
    assert.match(app.get("bulkError").textContent, /Could not refresh tabs:/);
    assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [1]);
    assert.deepEqual(Array.from(app.run("selectedTabIds")), [1]);
    assert.equal(app.get("undo-toast-btn"), recovery);
    assert.equal(app.get("undo-toast").hidden, false);
  });
}

it("contains malformed refresh acknowledgments without duplicate fallback", async () => {
  const broadcasts = [];
  const send = background({
    runtime: { sendMessage: async (message) => { broadcasts.push(message); return { ok: "yes" }; } },
    tabs: {
      query: async () => [{ id: 100, windowId: 1, url: dashboardUrl }],
      update: async () => {},
      create: async () => assert.fail("do not create duplicates on missing acknowledgment"),
    },
  });
  await send.click({ windowId: 1 });
  await send.click({ windowId: 1 });
  assert.equal(broadcasts.length, 2, "invalid acknowledgment releases the in-flight map");
  assert.equal(send.warnings.length, 2);
  assert.match(send.warnings[0].join(" "), /did not acknowledge refresh/);
});
