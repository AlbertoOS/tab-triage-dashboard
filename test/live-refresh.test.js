const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(source.slice(0, source.indexOf("for (const [selector, type]")) + ";dashboard", {
  require, __dirname, URL, setImmediate,
});
const tab = (id, fields = {}) => ({ id, windowId: 1, index: id, title: "Synthetic tab", url: `https://example.test/${id}`, ...fields });
function events() {
  const tabs = {};
  for (const name of ["onRemoved", "onCreated", "onUpdated", "onMoved", "onAttached", "onDetached", "onActivated", "onReplaced"]) {
    const listeners = new Set();
    tabs[name] = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
      emit: (...args) => { for (const fn of listeners) fn(...args); }, get size() { return listeners.size; } };
  }
  return tabs;
}
async function tick(app, ms = 150) { app.advanceTime(ms); await app.settle(); }

it("serializes a held automatic read and a targeted post-action read with fresh acknowledgment", async () => {
  const tabs = events();
  let hold = false;
  let active = 0;
  let maximum = 0;
  const pending = [];
  const app = dashboard((message) => {
    if (message.type !== "getTabs") return { ok: true };
    if (!hold) return { ok: true, tabs: [tab(1)] };
    maximum = Math.max(maximum, ++active);
    return new Promise((resolve) => pending.push((inventory) => { active--; resolve({ ok: true, tabs: inventory }); }));
  }, {}, { tabs });
  await app.settle();
  hold = true;
  tabs.onRemoved.emit(2);
  await tick(app);
  const acknowledgments = [];
  assert.equal(app.messageListeners[0]({ type: "refreshDashboard", tabId: 100 }, {}, (value) => acknowledgments.push(value)), true);
  const action = app.get("tab-body").children[0].querySelector(".btn-discard").listeners.click({ stopPropagation() {} });
  await app.settle();
  assert.equal(pending.length, 1, "no parallel inventory query");
  pending.shift()([tab(2)]);
  await app.settle();
  assert.deepEqual(Array.from(app.run("allTabs.map(t => t.id)")), [1], "superseded read must not publish");
  assert.equal(acknowledgments.length, 0);
  assert.equal(pending.length, 1, "one trailing read after the action");
  pending.shift()([tab(3)]);
  await action;
  await app.settle();
  assert.equal(maximum, 1);
  assert.deepEqual(Array.from(app.run("allTabs.map(t => t.id)")), [3]);
  assert.equal(acknowledgments[0].ok, true);
});

it("a burst during a held read has one trailing refresh and releases after failure", async () => {
  const tabs = events();
  let hold = false;
  const pending = [];
  const app = dashboard(() => !hold ? { ok: true, tabs: [tab(1)] } :
    new Promise((resolve) => pending.push(resolve)), {}, { tabs });
  await app.settle();
  hold = true;
  tabs.onRemoved.emit(2);
  await tick(app);
  for (let i = 0; i < 1001; i++) tabs.onCreated.emit(tab(i + 2));
  await tick(app);
  assert.equal(pending.length, 1);
  pending.shift()({ ok: true, tabs: [tab(2)] });
  await app.settle();
  assert.deepEqual(Array.from(app.run("allTabs.map(t => t.id)")), [2], "event churn cannot starve publication");
  await tick(app);
  assert.equal(pending.length, 1);
  pending.shift()({ ok: false, error: "Query denied" });
  await app.settle();
  assert.deepEqual(Array.from(app.run("allTabs.map(t => t.id)")), [2]);
  assert.equal(app.get("bulkError").textContent, "");
  hold = false;
  await app.get("refresh").listeners.click();
  assert.deepEqual(Array.from(app.run("allTabs.map(t => t.id)")), [1]);
  assert.equal(app.messages.length, 4);
});

for (const seconds of [1, 60]) {
  it(`Timed waits ${seconds} seconds after settlement and Off preserves manual refresh`, async () => {
    const tabs = events();
    const writes = [];
    const app = dashboard(() => ({ ok: true, tabs: [tab(1)] }), {
      get: async (key) => key === "liveRefresh" ? { liveRefresh: { mode: "timed", seconds } } : {},
      set: async (value) => writes.push(structuredClone(value)),
    }, { tabs });
    await app.settle();
    assert.equal(app.staticControlIds.has("liveRefreshMode"), true);
    assert.equal(app.staticControlIds.has("liveRefreshSeconds"), true);
    assert.equal(app.get("liveRefreshSeconds").getAttribute("min"), "1");
    assert.equal(app.get("liveRefreshSeconds").getAttribute("max"), "60");
    assert.equal(app.get("liveRefreshMode").value, "timed");
    assert.equal(Number(app.get("liveRefreshSeconds").value), seconds);
    tabs.onCreated.emit(tab(2));
    await tick(app, seconds * 1000 - 1);
    assert.equal(app.messages.length, 1);
    await tick(app, 1);
    assert.equal(app.messages.length, 2);
    app.get("liveRefreshMode").value = "off";
    await app.get("liveRefreshMode").listeners.change();
    for (let i = 0; i < 10; i++) tabs.onRemoved.emit(i);
    await tick(app, 60000);
    assert.equal(app.messages.length, 2);
    await app.get("refresh").listeners.click();
    assert.equal(app.messages.length, 3);
    assert.deepEqual(writes, [{ liveRefresh: { mode: "off", seconds } }]);
  });
}

for (const saved of ["timed", {}, { mode: "other", seconds: 5 },
  ...[0, 61, 1.5, "1", null].map((seconds) => ({ mode: "timed", seconds }))]) {
  it(`rejects invalid saved live inventory settings ${JSON.stringify(saved)}`, async () => {
    const tabs = events();
    const app = dashboard(() => ({ ok: true, tabs: [] }), {
      get: async (key) => key === "liveRefresh" ? { liveRefresh: saved } : {},
    }, { tabs });
    await app.settle();
    assert.equal(app.get("liveRefreshMode").value, "instant");
    assert.equal(Number(app.get("liveRefreshSeconds").value), 5);
    await tick(app, 60000);
    assert.equal(app.messages.length, 1);
    tabs.onCreated.emit(tab(1));
    await tick(app);
    assert.equal(app.messages.length, 2);
  });
}

it("a late saved setting cannot overwrite a newer control edit", async () => {
  let finishRead;
  const writes = [];
  const app = dashboard(() => ({ ok: true, tabs: [] }), {
    get: (key) => key === "liveRefresh" ? new Promise((resolve) => { finishRead = resolve; }) : Promise.resolve({}),
    set: async (value) => writes.push(structuredClone(value)),
  });
  await app.settle();
  app.get("liveRefreshMode").value = "off";
  await app.get("liveRefreshMode").listeners.change();
  finishRead({ liveRefresh: { mode: "timed", seconds: 1 } });
  await app.settle();
  assert.equal(app.get("liveRefreshMode").value, "off");
  await tick(app, 60000);
  assert.equal(app.messages.length, 1);
  assert.deepEqual(writes, [{ liveRefresh: { mode: "off", seconds: 5 } }]);
});

it("invalid interval edits never schedule or persist an out-of-range timer", async () => {
  const writes = [];
  const app = dashboard(() => ({ ok: true, tabs: [] }), { set: async (value) => writes.push(structuredClone(value)) });
  await app.settle();
  app.get("liveRefreshMode").value = "timed";
  await app.get("liveRefreshMode").listeners.change();
  for (const value of ["", "0", "61", "1.5", "not-a-number"]) {
    app.get("liveRefreshSeconds").value = value;
    await app.get("liveRefreshSeconds").listeners.change();
    assert.equal(app.get("liveRefreshSeconds").getAttribute("aria-invalid"), "true");
    assert.equal(writes.length, 1);
  }
  app.get("liveRefreshSeconds").value = "1";
  await app.get("liveRefreshSeconds").listeners.change();
  assert.equal(app.get("liveRefreshSeconds").getAttribute("aria-invalid"), null);
  assert.equal(writes.length, 2);
  await tick(app, 999);
  assert.equal(app.messages.length, 1);
  await tick(app, 1);
  assert.equal(app.messages.length, 2);
});

for (const mode of ["instant", "timed", "off"]) {
  it(`${mode} pauses automatic reads while hidden and reconciles once on visible resume when enabled`, async () => {
    const tabs = events();
    const app = dashboard(() => ({ ok: true, tabs: [] }), {
      get: async (key) => key === "liveRefresh" ? { liveRefresh: { mode, seconds: 1 } } : {},
    }, { tabs });
    await app.settle();
    app.run('document.hidden = true; document.visibilityState = "hidden";');
    app.documentListeners.visibilitychange?.();
    for (let i = 0; i < 10; i++) tabs.onRemoved.emit(i);
    await tick(app, 60000);
    assert.equal(app.messages.length, 1, "no hidden automatic work");
    app.run('document.hidden = false; document.visibilityState = "visible";');
    app.documentListeners.visibilitychange?.();
    await tick(app);
    assert.equal(app.messages.length, mode === "off" ? 1 : 2);
    if (mode === "instant") {
      await tick(app, 60000);
      assert.equal(app.messages.length, 2);
    }
  });
}

const clickEvent = { stopPropagation() {}, target: { closest() { return null; } } };
for (const interaction of ["help", "confirmation", "domain", "row"]) {
  it(`defers automatic inventory work during the ${interaction} interaction and flushes once dismissed`, async () => {
    const tabs = events();
    let inventory = [tab(1), tab(2)];
    const app = dashboard(() => ({ ok: true, tabs: structuredClone(inventory) }), {}, { tabs });
    await app.settle();
    const row = app.get("tab-body").children[0];
    let confirmation;
    if (interaction === "help") app.get("helpAbout").listeners.click();
    if (interaction === "confirmation") confirmation = app.run('confirmAction("Finite preview")');
    if (interaction === "domain") app.get("domainDropdownBtn").listeners.click(clickEvent);
    if (interaction === "row") row.querySelector(".btn-more").listeners.click(clickEvent);
    await tick(app, 0);
    const focus = app.run("document.activeElement");
    inventory = [tab(3)];
    for (let i = 0; i < 10; i++) tabs.onRemoved.emit(i);
    await tick(app, 60000);
    assert.equal(app.messages.length, 1, "do not poll an open interaction");
    assert.equal(app.get("tab-body").children[0], row);
    assert.equal(app.run("document.activeElement"), focus);
    if (interaction === "help") app.get("helpClose").listeners.click();
    if (interaction === "confirmation") { app.get("duplicateConfirmCancel").listeners.click(); await confirmation; }
    if (interaction === "domain") app.get("domainDropdownBtn").listeners.click(clickEvent);
    if (interaction === "row") row.querySelector(".btn-more").listeners.click(clickEvent);
    await tick(app);
    assert.deepEqual(Array.from(app.run("allTabs.map(t => t.id)")), [3]);
    assert.equal(app.messages.length, 2);
    await tick(app, 60000);
    assert.equal(app.messages.length, 2);
  });
}

it("opening Help during an automatic read defers publication but not explicit refresh", async () => {
  const tabs = events();
  let finish;
  let hold = false;
  let inventory = [tab(1)];
  const app = dashboard(() => hold ? new Promise((resolve) => { finish = resolve; }) :
    { ok: true, tabs: structuredClone(inventory) }, {}, { tabs });
  await app.settle();
  hold = true;
  tabs.onCreated.emit(tab(2));
  await tick(app);
  app.get("helpAbout").listeners.click();
  finish({ ok: true, tabs: [tab(2)] });
  await app.settle();
  assert.deepEqual(Array.from(app.run("allTabs.map(t => t.id)")), [1]);
  assert.equal(app.run("document.activeElement"), app.get("helpClose"));
  hold = false;
  inventory = [tab(3)];
  await app.get("refresh").listeners.click();
  assert.deepEqual(Array.from(app.run("allTabs.map(t => t.id)")), [3]);
  assert.equal(app.get("helpDialog").open, true);
  app.get("helpClose").listeners.click();
  await tick(app);
  assert.equal(app.messages.length, 3, "explicit read already reconciled deferred work");
});

it("retains domain subsearch, checked zero-count choices and logical checkbox focus on refresh", async () => {
  let inventory = [tab(1, { url: "https://keep.test/" }), tab(2, { url: "https://other.test/" })];
  const app = dashboard(() => ({ ok: true, tabs: structuredClone(inventory) }));
  await app.settle();
  const input = app.get("domainList").children[0].querySelector("input");
  input.checked = true;
  input.focus();
  app.get("domainSearch").value = "keep";
  app.get("domainSearch").listeners.input({ target: app.get("domainSearch") });
  inventory = [tab(2, { url: "https://other.test/" })];
  await app.get("refresh").listeners.click();
  const choices = app.get("domainList").children;
  const kept = choices.find((label) => label.querySelector("input").value === "keep.test");
  const other = choices.find((label) => label.querySelector("input").value === "other.test");
  assert.equal(app.run("document.activeElement"), kept.querySelector("input"));
  assert.equal(kept.querySelector("input").checked, true);
  assert.equal(kept.querySelector(".domain-item-count").textContent, "0");
  assert.equal(kept.style.display, "");
  assert.equal(other.style.display, "none");
  assert.equal(app.get("tab-body").children.length, 0);
});

it("automatic publication preserves focused ignore controls, operation errors and recovery ownership", async () => {
  const tabs = events();
  let inventory = [tab(1)];
  const app = dashboard(() => ({ ok: true, tabs: structuredClone(inventory) }), {
    get: async (key) => Array.isArray(key) ? { ignoredDomains: ["ignored.test"] } : {},
  }, { tabs });
  await app.settle();
  app.get("bulkError").textContent = "Close denied";
  app.run('showUndoToast("Previous close")');
  const recovery = app.get("undo-toast-btn");
  const ignoredButton = app.get("ignoredDomainList").children[0].querySelector(".btn-unignore");
  ignoredButton.focus();
  inventory = [tab(1), tab(2)];
  tabs.onCreated.emit(tab(2));
  await tick(app);
  assert.notEqual(app.get("ignoredDomainList").children[0].querySelector(".btn-unignore"), ignoredButton,
    "changed inventory must exercise keyed focus restoration on a rebuilt control");
  assert.equal(app.run("document.activeElement"), app.get("ignoredDomainList").children[0].querySelector(".btn-unignore"));
  assert.equal(app.get("bulkError").textContent, "Close denied");
  assert.equal(app.get("undo-toast-btn"), recovery);
  assert.equal(app.get("undo-toast-msg").textContent, "Previous close");
  assert.equal(app.get("undo-toast").hidden, false);
});

it("unchanged automatic snapshots do not replace rows or focused controls", async () => {
  const tabs = events();
  let inventory = [tab(1)];
  const app = dashboard(() => ({ ok: true, tabs: structuredClone(inventory) }), {}, { tabs });
  await app.settle();
  const row = app.get("tab-body").children[0];
  const button = row.querySelector(".btn-goto");
  button.focus();
  tabs.onMoved.emit(1, { windowId: 1 });
  await tick(app);
  assert.equal(app.messages.length, 2);
  assert.equal(app.get("tab-body").children[0], row);
  assert.equal(app.run("document.activeElement"), button);
  inventory = [tab(1, { title: "Changed title" })];
  tabs.onUpdated.emit(1, { title: "Changed title" });
  await tick(app);
  assert.notEqual(app.get("tab-body").children[0], row);
  assert.equal(app.get("tab-body").children[0].querySelector(".tab-title-text").textContent, "Changed title");
  assert.equal(app.run("document.activeElement"), app.get("tab-body").children[0].querySelector(".btn-goto"));
});

it("ignores irrelevant update noise but reconciles every inventory event through canonical reads", async () => {
  const tabs = events();
  let inventory = [tab(1)];
  const app = dashboard(() => ({ ok: true, tabs: structuredClone(inventory) }), {}, { tabs });
  await app.settle();
  for (const event of Object.values(tabs)) assert.equal(event.size, 1);
  for (let i = 0; i < 1000; i++) tabs.onUpdated.emit(1, { attention: true });
  await tick(app);
  assert.equal(app.messages.length, 1, "unrendered metadata is not an inventory invalidation");
  for (const name of Object.keys(tabs)) {
    inventory = [tab(2, { windowId: 2, pinned: true, discarded: true, active: true, url: "https://changed.test/", title: name })];
    tabs[name].emit(2, { title: name });
    await tick(app);
    assert.equal(app.run("allTabs[0].title"), name);
    assert.equal(app.run("enrichedTabs[0].domain"), "changed.test");
    assert.equal(app.run("enrichedTabs[0].windowId"), 2);
    assert.equal(app.run('enrichedTabs[0].statusList.includes("discarded")'), true);
  }
  assert.equal(app.messages.length, 9);
  assert.ok(app.messages.every((message) => message.type === "getTabs"), "automatic refresh cannot activate or mutate tabs");
});

it("Off stops automatic work even when an unfinished interval edit is invalid", async () => {
  const app = dashboard(() => ({ ok: true, tabs: [] }));
  await app.settle();
  app.get("liveRefreshMode").value = "timed";
  await app.get("liveRefreshMode").listeners.change();
  app.get("liveRefreshSeconds").value = "";
  await app.get("liveRefreshSeconds").listeners.change();
  app.get("liveRefreshMode").value = "off";
  await app.get("liveRefreshMode").listeners.change();
  assert.equal(app.get("liveRefreshInterval").hidden, true);
  await tick(app, 60000);
  assert.equal(app.messages.length, 1);
});

it("styles the live delay control with visible focus and an explicit hidden override", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "triage.css"), "utf8");
  assert.match(css, /#liveRefreshInterval\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(css, /#liveRefreshSeconds:focus-visible\s*\{[^}]*outline:\s*2px\s+solid\s+var\(--text\)/);
});

it("automatic reads preserve search caret, effective filters, sort, clusters and surviving selection", async () => {
  const tabs = events();
  let inventory = [tab(1, { pinned: true }), tab(2, { pinned: true }), tab(3)];
  const app = dashboard(() => ({ ok: true, tabs: structuredClone(inventory) }), {}, { tabs });
  await app.settle();
  const now = app.run("Date.now()");
  inventory = inventory.map((item) => ({ ...item, lastAccessed: now - 1000 }));
  await app.get("refresh").listeners.click();
  const search = app.get("search");
  search.value = "tab Synthetic";
  search.selectionStart = 2;
  search.selectionEnd = 7;
  app.get("fuzzyToggle").listeners.click();
  const pin = app.run('document.querySelectorAll(".status-toggle").find(button => button.dataset.status === "pinned")');
  pin.listeners.click();
  const age = app.run('document.querySelectorAll(\'input[name="filterAge"]\').find(input => input.value === "1h")');
  age.checked = true;
  age.listeners.change();
  app.get("domainList").children[0].querySelector("input").checked = true;
  app.get("domainList").children[0].querySelector("input").listeners.change();
  app.get("groupBy").value = "window";
  app.get("groupBy").listeners.change();
  app.get("selectFiltered").listeners.click();
  app.run('currentSort = [{ key: "title", dir: "asc" }]; collapsedGroups.add("remembered");');
  search.focus();
  inventory = [inventory[0], inventory[2], tab(4, { pinned: true, lastAccessed: now })];
  tabs.onReplaced.emit(4, 2);
  await tick(app);
  assert.equal(app.run("document.activeElement"), search);
  assert.equal(search.value, "tab Synthetic");
  assert.equal(search.selectionStart, 2);
  assert.equal(search.selectionEnd, 7);
  assert.equal(app.run("fuzzySearch"), true);
  assert.equal(pin.dataset.state, "include");
  assert.equal(age.checked, true);
  assert.equal(app.get("groupBy").value, "window");
  assert.deepEqual(Array.from(app.run("getSelectedDomains()")), ["example.test"]);
  assert.deepEqual(Array.from(app.run("getFilteredTabs().map(t => t.id)")), [1, 4]);
  assert.deepEqual(Array.from(app.run("selectedTabIds")), [1], "drop removed selection without selecting a new tab");
  assert.equal(app.run('currentSort[0].key === "title" && collapsedGroups.has("remembered")'), true);
});

for (const mode of ["closeAll", "global"]) {
  for (const accept of [false, true]) {
    it(`${mode} retains its finite confirmation plan through native invalidations (${accept ? "accept" : "cancel"})`, async () => {
      const tabs = events();
      const copy = (id) => tab(id, { url: "https://copies.test/page" });
      let inventory = [copy(1), copy(2)];
      const app = dashboard((message) => {
        if (message.type === "getTabs") return { ok: true, tabs: structuredClone(inventory) };
        if (message.type === "previewDuplicates") return { ok: true,
          plan: app.run('buildDuplicatePlan(enrichedTabs, "global", api.runtime.getURL("triage.html"))') };
        assert.equal(message.type, "closeDuplicates");
        return { ok: true, closedCount: message.plan.groups.flatMap(group => group.candidates).length,
          skippedCount: 0, failedCount: 0, unverifiedCount: 0 };
      }, {}, { tabs });
      await app.settle();
      const pending = mode === "closeAll" ? app.get("tab-body").children[0].querySelector(".btn-close-copies").listeners.click(clickEvent) :
        app.get("dedupAll").listeners.click();
      await app.settle();
      assert.equal(app.get("duplicateConfirmDialog").open, true);
      const preview = app.get("duplicateConfirmMessage").textContent;
      inventory.push(copy(3));
      tabs.onCreated.emit(copy(3));
      await tick(app, 60000);
      assert.equal(app.get("duplicateConfirmMessage").textContent, preview);
      assert.equal(app.run("document.activeElement"), app.get("duplicateConfirmAccept"));
      assert.equal(app.messages.filter((entry) => entry.type === "closeDuplicates").length, 0);
      app.get(accept ? "duplicateConfirmAccept" : "duplicateConfirmCancel").listeners.click();
      await pending;
      await tick(app);
      const sent = app.messages.find((entry) => entry.type === "closeDuplicates");
      if (accept) assert.deepEqual(Array.from(sent.plan.groups.flatMap(group => group.candidates), item => item.id), mode === "closeAll" ? [1, 2] : [2]);
      else assert.equal(sent, undefined);
      assert.equal(app.run("allTabs.length"), 3);
    });
  }
}

for (const boundary of ["hidden", "off", "row", "domain"]) {
  it(`rechecks ${boundary} after an automatic async read before publishing`, async () => {
    const tabs = events();
    let finish;
    let held = false;
    const app = dashboard(() => held ? new Promise((resolve) => { finish = resolve; }) :
      { ok: true, tabs: [tab(1)] }, {}, { tabs });
    await app.settle();
    held = true;
    tabs.onCreated.emit(tab(2));
    await tick(app);
    if (boundary === "hidden") { app.run("document.hidden = true;"); app.documentListeners.visibilitychange(); }
    if (boundary === "off") { app.get("liveRefreshMode").value = "off"; await app.get("liveRefreshMode").listeners.change(); }
    if (boundary === "row") app.get("tab-body").children[0].querySelector(".btn-more").listeners.click(clickEvent);
    if (boundary === "domain") app.get("domainDropdownBtn").listeners.click(clickEvent);
    finish({ ok: true, tabs: [tab(2)] });
    await app.settle();
    assert.deepEqual(Array.from(app.run("allTabs.map(t => t.id)")), [1]);
    await tick(app, 60000);
    assert.equal(app.messages.length, 2);
    held = false;
    await app.get("refresh").listeners.click();
    assert.equal(app.messages.length, 3, "explicit work remains available");
  });
}

it("Timed delay begins after a held read settles, including a failed read", async () => {
  let held = false;
  let finish;
  const app = dashboard(() => held ? new Promise((resolve) => { finish = resolve; }) :
    { ok: true, tabs: [tab(1)] }, {
    get: async (key) => key === "liveRefresh" ? { liveRefresh: { mode: "timed", seconds: 1 } } : {},
  });
  await app.settle();
  app.get("bulkError").textContent = "Action denied";
  held = true;
  await tick(app, 1000);
  await tick(app, 60000);
  assert.equal(app.messages.length, 2);
  finish({ ok: false, error: "Query denied" });
  await app.settle();
  assert.equal(app.get("bulkError").textContent, "Action denied");
  assert.equal(app.run("allTabs.length"), 1);
  await tick(app, 999);
  assert.equal(app.messages.length, 2);
  await tick(app, 1);
  assert.equal(app.messages.length, 3);
  finish({ ok: false, error: "Query denied" });
  await app.settle();
  assert.equal(app.get("bulkError").textContent, "Action denied", "automatic failures cannot duplicate operation diagnostics");
});

it("a pending saved Off preference cannot briefly start default automatic work", async () => {
  const tabs = events();
  let finishRead;
  const app = dashboard(() => ({ ok: true, tabs: [] }), {
    get: (key) => key === "liveRefresh" ? new Promise((resolve) => { finishRead = resolve; }) : Promise.resolve({}),
  }, { tabs });
  await app.settle();
  tabs.onCreated.emit(tab(1));
  await tick(app, 60000);
  assert.equal(app.messages.length, 1, "initial inventory is independent, automatic work waits for settings");
  finishRead({ liveRefresh: { mode: "off", seconds: 1 } });
  await app.settle();
  await tick(app, 60000);
  assert.equal(app.messages.length, 1);
});

for (const control of ["closeSelected", "clearSelection", "exportSelected", "selectFiltered", "selectAllTabs", "exportAll"]) {
  it(`returns focus to Search when live inventory disables ${control}`, async () => {
    const tabs = events();
    let inventory = [tab(1)];
    const app = dashboard(() => ({ ok: true, tabs: structuredClone(inventory) }), {}, { tabs });
    await app.settle();
    app.get("selectFiltered").listeners.click();
    const button = app.get(control);
    assert.equal(button.disabled, false);
    button.focus();
    inventory = [];
    tabs.onRemoved.emit(1, { windowId: 1 });
    await tick(app);
    assert.equal(button.disabled, true);
    assert.equal(app.run("document.activeElement"), app.get("search"));
    assert.equal(app.run("selectedTabIds.size"), 0);
    assert.equal(app.run("allTabs.length"), 0);
  });
}

for (const control of ["closeSelected", "search"]) {
  it(`does not move focus from still-usable ${control} during live publication`, async () => {
    const tabs = events();
    let inventory = [tab(1)];
    const app = dashboard(() => ({ ok: true, tabs: structuredClone(inventory) }), {}, { tabs });
    await app.settle();
    app.get("selectFiltered").listeners.click();
    const focused = app.get(control);
    focused.focus();
    inventory = [tab(1), tab(2)];
    tabs.onCreated.emit(tab(2));
    await tick(app);
    assert.equal(app.run("document.activeElement"), focused);
    assert.equal(app.get("closeSelected").disabled, false);
    assert.deepEqual(Array.from(app.run("selectedTabIds")), [1]);
  });
}

it("Instant reconciles an external removal in a 1000-tab inventory without idle polling", async () => {
  let inventory = Array.from({ length: 1000 }, (_, i) => tab(i + 1));
  const tabs = events();
  const app = dashboard(() => ({ ok: true, tabs: structuredClone(inventory) }), {}, { tabs });
  await app.settle();
  inventory.pop();
  tabs.onRemoved.emit(1000, { windowId: 1 });
  assert.equal(app.messages.length, 1, "coalesce using a positive delay");
  await tick(app);
  assert.match(app.get("stats").textContent, /^999\/999 tabs/);
  assert.equal(app.get("tab-body").children.length, 999);
  assert.equal(app.messages.length, 2);
  await tick(app, 60000);
  assert.equal(app.messages.length, 2, "Instant has no idle polling");
});
