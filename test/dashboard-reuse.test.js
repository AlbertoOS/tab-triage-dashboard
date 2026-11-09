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
      update: async (id) => {
        events.push(["activate", id]);
        const current = [...candidates, ...tabs].find((tab) => tab.id === id);
        assert.ok(current, "activation requires an existing tab");
        return { ...current, active: true };
      },
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

it("ordinary and manual loads publish only the latest requested inventory", async () => {
  const queries = [];
  const app = dashboard(() => {
    const query = deferred();
    queries.push(query);
    return query.promise;
  });
  await app.settle();
  const manual = app.get("refresh").listeners.click();
  await app.settle();
  assert.equal(queries.length, 1, "the newer request queues behind the active inventory read");
  queries[0].resolve({ ok: true, tabs: [tab(1)] });
  await app.settle();
  assert.deepEqual(Array.from(app.run("allTabs")), [], "a superseded read cannot publish");
  queries[1].resolve({ ok: true, tabs: [tab(2)] });
  await manual;
  await app.settle();
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [2]);
  assert.deepEqual(Array.from(app.get("tab-body").children, (row) => row.dataset.tabId), ["2"]);
});

it("failed inventory retains the committed ignore lists and rendered bundle", async () => {
  let fail = false;
  const app = dashboard(() => fail ? { ok: false, error: "Query denied" } :
    { ok: true, tabs: [tab(1)] }, { get: async () => fail ? { ignoredDomains: ["example.test"] } : {} });
  await app.settle();
  fail = true;
  await app.get("refresh").listeners.click();
  assert.deepEqual(Array.from(app.run("getFilteredTabs().map((tab) => tab.id)")), [1]);
  assert.deepEqual(Array.from(app.run("ignoredDomains")), []);
  assert.deepEqual(Array.from(app.get("tab-body").children, (row) => row.dataset.tabId), ["1"]);
  assert.match(app.get("bulkError").textContent, /Query denied/);
});

for (const owner of ["manual", "row action", "selected close", "restore"]) {
  it(`suppresses superseded ${owner} load failures after a newer successful refresh`, async () => {
    let pending = false;
    const queries = [];
    const app = dashboard((message) => {
      if (message.type !== "getTabs") return { ok: true };
      if (!pending) return { ok: true, tabs: [tab(1)] };
      const query = deferred();
      queries.push(query);
      return query.promise;
    });
    await app.settle();
    app.get("selectFiltered").listeners.click();
    app.run('showUndoToast("Earlier close completed.")');
    pending = true;
    const old = owner === "manual" ? app.get("refresh").listeners.click() :
      owner === "row action" ? app.get("tab-body").children[0].querySelector(".btn-discard")
        .listeners.click({ stopPropagation() {} }) :
      owner === "selected close" ? app.get("closeSelected").listeners.click() :
        app.get("undo-toast-btn").listeners.click();
    await app.settle();
    const winner = app.get("refresh").listeners.click();
    await app.settle();
    assert.equal(queries.length, 1);
    queries[0].resolve({ ok: false, error: "Stale query denied" });
    await app.settle();
    queries[1].resolve({ ok: true, tabs: [tab(2)] });
    await winner;
    await old;
    assert.equal(app.get("bulkError").textContent, "");
    assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [2]);
  });
}

for (const owner of ["targeted refresh", "row action", "selected close", "restore"]) {
  it(`joins the newest failed load without stale ${owner} publication or duplicate diagnostics`, async () => {
    let pending = false;
    const queries = [];
    const app = dashboard((message) => {
      if (message.type !== "getTabs") return { ok: true };
      if (!pending) return { ok: true, tabs: [tab(1)] };
      const query = deferred();
      queries.push(query);
      return query.promise;
    });
    await app.settle();
    app.get("selectFiltered").listeners.click();
    app.run('showUndoToast("Earlier close completed.")');
    const responses = [];
    pending = true;
    let old;
    if (owner === "targeted refresh") {
      assert.equal(app.messageListeners[0]({ type: "refreshDashboard", tabId: 100 }, {},
        (response) => responses.push(response)), true);
    } else if (owner === "row action") {
      old = app.get("tab-body").children[0].querySelector(".btn-discard").listeners.click({ stopPropagation() {} });
    } else if (owner === "selected close") {
      old = app.get("closeSelected").listeners.click();
    } else {
      old = app.get("undo-toast-btn").listeners.click();
    }
    await app.settle();
    const winner = app.get("refresh").listeners.click();
    await app.settle();
    assert.equal(queries.length, 1);
    queries[0].resolve({ ok: true, tabs: [tab(2)] });
    await app.settle();
    assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [1]);
    queries[1].resolve({ ok: false, error: "Newest query denied" });
    await winner;
    await old;
    await app.settle();
    assert.equal(app.get("bulkError").textContent, "Could not refresh tabs: Newest query denied");
    assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [1]);
    if (owner === "targeted refresh") {
      assert.equal(responses.length, 1);
      assert.equal(responses[0].ok, false, "a superseded refresh must not claim fresh inventory");
      assert.equal(responses[0].error, "Newest query denied");
    }
  });
}

it("retains a selected zero-count domain across targeted reuse and its return", async () => {
  const selected = { ...tab(1), url: "https://selected.test/1" };
  const unrelated = { ...tab(2), url: "https://unrelated.test/2" };
  const harness = reuseHarness([selected, unrelated]);
  const app = harness.page();
  await app.settle();
  const find = () => app.get("domainList").children.find((label) => label.querySelector("input").value === "selected.test");
  find().querySelector("input").checked = true;
  find().querySelector("input").listeners.change();
  harness.setTabs([unrelated]);
  await harness.send.click({ windowId: 1 });
  assert.deepEqual(Array.from(app.run("getSelectedDomains()")), ["selected.test"]);
  assert.equal(find().querySelector("input").checked, true);
  assert.equal(find().querySelector("input").disabled, false);
  assert.equal(find().querySelector(".domain-item-count").textContent, "0");
  assert.equal(app.get("domainDropdownBtn").textContent, "selected.test");
  assert.deepEqual(Array.from(app.run("getFilteredTabs().map((tab) => tab.id)")), []);
  assert.equal(app.get("tab-body").children.length, 0);
  harness.setTabs([selected, unrelated]);
  await harness.send.click({ windowId: 1 });
  assert.equal(find().querySelector(".domain-item-count").textContent, "1");
  assert.deepEqual(Array.from(app.run("getFilteredTabs().map((tab) => tab.id)")), [1]);
});

it("stages queued ignore reads with their inventory until the latest bundle commits", async () => {
  let pending = false;
  const reads = [];
  const queries = [];
  const app = dashboard(() => {
    if (!pending) return { ok: true, tabs: [tab(1)] };
    const query = deferred();
    queries.push(query);
    return query.promise;
  }, { get: (keys) => {
    if (keys === "faviconSize" || !pending) return Promise.resolve({ ignoredDomains: ["committed.test"] });
    const read = deferred();
    reads.push(read);
    return read.promise;
  } });
  await app.settle();
  pending = true;
  const old = app.get("refresh").listeners.click();
  const winner = app.get("refresh").listeners.click();
  assert.equal(reads.length, 1, "storage and inventory share one flight");
  reads[0].resolve({ ignoredDomains: ["old.test"], ignoredUrls: ["https://old.test/ignored"] });
  await app.settle();
  assert.deepEqual(Array.from(app.run("ignoredDomains")), ["committed.test"]);
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [1]);
  assert.deepEqual(Array.from(app.run("getFilteredTabs().map((tab) => tab.id)")), [1]);
  queries[0].resolve({ ok: true, tabs: [tab(3)] });
  await app.settle();
  assert.deepEqual(Array.from(app.run("ignoredDomains")), ["committed.test"]);
  reads[1].resolve({ ignoredDomains: ["new.test"], ignoredUrls: ["https://new.test/ignored"] });
  await app.settle();
  queries[1].resolve({ ok: true, tabs: [tab(2)] });
  await winner;
  await old;
  assert.deepEqual(Array.from(app.run("ignoredDomains")), ["new.test"]);
  assert.deepEqual(Array.from(app.run("ignoredUrls")), ["https://new.test/ignored"]);
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [2]);
  assert.deepEqual(Array.from(app.get("tab-body").children, (row) => row.dataset.tabId), ["2"]);
});

it("superseded targeted refresh waits for the winning inventory before acknowledging success", async () => {
  let pending = false;
  const queries = [];
  const app = dashboard(() => {
    if (!pending) return { ok: true, tabs: [tab(1)] };
    const query = deferred();
    queries.push(query);
    return query.promise;
  });
  await app.settle();
  pending = true;
  const responses = [];
  assert.equal(app.messageListeners[0]({ type: "refreshDashboard", tabId: 100 }, {},
    (response) => responses.push(response)), true);
  await app.settle();
  const winner = app.get("refresh").listeners.click();
  await app.settle();
  queries[0].resolve({ ok: true, tabs: [tab(2)] });
  await app.settle();
  assert.equal(responses.length, 0, "older success is not proof of freshness");
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [1]);
  queries[1].resolve({ ok: true, tabs: [tab(3)] });
  await winner;
  await app.settle();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.deepEqual(Array.from(app.get("tab-body").children, (row) => row.dataset.tabId), ["3"]);
});

for (const clear of ["uncheck", "None"]) {
  it(`allows explicit ${clear} of a selected zero-count domain without resurrecting it`, async () => {
    const selected = { ...tab(1), url: "https://selected.test/1" };
    const harness = reuseHarness([selected, tab(2)]);
    const app = harness.page();
    await app.settle();
    const checkbox = () => app.get("domainList").children.find((label) =>
      label.querySelector("input").value === "selected.test")?.querySelector("input");
    checkbox().checked = true;
    checkbox().listeners.change();
    harness.setTabs([tab(2)]);
    await harness.send.click({ windowId: 1 });
    assert.deepEqual(Array.from(app.run("getFilteredTabs()")), []);
    if (clear === "None") app.get("domainSelectNone").listeners.click();
    else {
      checkbox().checked = false;
      checkbox().listeners.change();
    }
    assert.deepEqual(Array.from(app.run("getSelectedDomains()")), []);
    assert.deepEqual(Array.from(app.run("getFilteredTabs().map((tab) => tab.id)")), [100, 2]);
    await harness.send.click({ windowId: 1 });
    assert.equal(checkbox(), undefined, "unchecked absent domains are not retained");
    harness.setTabs([selected, tab(2)]);
    await harness.send.click({ windowId: 1 });
    assert.equal(checkbox().checked, false);
    assert.deepEqual(Array.from(app.run("getFilteredTabs().map((tab) => tab.id)")), [100, 1, 2]);
  });
}

for (const owner of ["row action", "selected close", "restore"]) {
  it(`retains genuine ${owner} errors while its stale load joins a winning success`, async () => {
    let pending = false;
    const action = deferred();
    const winningAction = deferred();
    const queries = [];
    const app = dashboard((message) => {
      if (message.type === "goToTab") return winningAction.promise;
      if (message.type !== "getTabs") return action.promise;
      if (!pending) return { ok: true, tabs: [tab(1)] };
      const query = deferred();
      queries.push(query);
      return query.promise;
    });
    await app.settle();
    app.get("selectFiltered").listeners.click();
    app.run('showUndoToast("Earlier close completed.")');
    const recovery = app.get("undo-toast-btn");
    const operation = owner === "row action" ? app.get("tab-body").children[0].querySelector(".btn-discard")
      .listeners.click({ stopPropagation() {} }) : owner === "selected close" ?
      app.get("closeSelected").listeners.click() : recovery.listeners.click();
    pending = true;
    // Start the next refresh before the operation's real error is delivered.
    const manual = app.get("refresh").listeners.click();
    const winning = app.get("tab-body").children[0].querySelector(".btn-goto")
      .listeners.click({ stopPropagation() {} });
    await app.settle();
    action.resolve({ ok: false, error: "Action denied" });
    await app.settle();
    assert.equal(queries.length, 1);
    queries[0].resolve({ ok: true, tabs: [tab(3)] });
    await app.settle();
    winningAction.resolve({ ok: true });
    await app.settle();
    assert.equal(queries.length, 2);
    queries[1].resolve({ ok: false, error: "Stale action query denied" });
    await app.settle();
    queries[2].resolve({ ok: true, tabs: [tab(2)] });
    await winning;
    await Promise.all([operation, manual]);
    assert.match(app.get("bulkError").textContent, /Action denied/);
    assert.doesNotMatch(app.get("bulkError").textContent, /Stale action query/);
    assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [2]);
    assert.equal(app.get("undo-toast-btn"), recovery);
    assert.equal(app.get("undo-toast").hidden, false);
  });
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
      update: async () => ({ id: 100, windowId: 1, url: dashboardUrl, active: true }),
      create: async () => assert.fail("do not create duplicates on missing acknowledgment"),
    },
  });
  await send.click({ windowId: 1 });
  await send.click({ windowId: 1 });
  assert.equal(broadcasts.length, 2, "invalid acknowledgment releases the in-flight map");
  assert.equal(send.warnings.length, 2);
  assert.match(send.warnings[0].join(" "), /did not acknowledge refresh/);
});
