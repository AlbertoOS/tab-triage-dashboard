const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const fixtureSource = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(fixtureSource.slice(0, fixtureSource.indexOf("for (const [selector, type]")) + ";dashboard", { require, __dirname, URL, setImmediate });

it("enriches and renders collision-safe internal, opaque, file and extension duplicates", async () => {
  const urls = ["chrome://newtab/", "chrome://settings/", "chrome://extensions/",
    "file:///one.example", "file:///two.example", "about:blank", "about:config",
    "chrome-extension://one/page", "chrome-extension://two/page", "data:text/plain,one",
    "data:text/plain,two", "", undefined, "", undefined, "about:blank", "chrome://settings/"];
  const app = dashboard(() => ({ ok: true, tabs: urls.map((url, id) => ({ id, url, windowId: 1 })) }));
  await app.settle();
  const dupes = Array.from(app.run("enrichedTabs.filter((tab) => tab.isDuplicate).map((tab) => tab.id)"));
  assert.deepEqual(dupes, [1, 5, 15, 16]);
  for (const row of app.get("tab-body").children) {
    assert.equal(!!row.querySelector(".btn-dedup"), dupes.includes(Number(row.dataset.tabId)));
  }
});

function broker(initial, namespace = "chrome", hooks = {}) {
  let tabs = initial.map((tab) => ({ ...tab }));
  let listener;
  const removed = [];
  let queries = 0;
  let loads = 0;
  const api = {
    action: { onClicked: { addListener() {} } },
    runtime: { getURL: () => "chrome-extension://fixture/triage.html",
      onMessage: { addListener(fn) { listener = fn; } } },
    tabs: {
      query: async () => { queries++; if (hooks.query) await hooks.query(tabs, queries); return tabs.map((tab) => ({ ...tab })); },
      remove: async (value) => {
        const ids = Array.isArray(value) ? value : [value];
        for (const id of ids) {
          removed.push(id);
          if (hooks.remove && await hooks.remove(id, tabs) === false) continue;
          tabs = tabs.filter((tab) => tab.id !== id);
        }
      },
    },
  };
  const context = vm.createContext({ [namespace]: api, URL, console,
    importScripts: () => { loads++; vm.runInContext(fs.readFileSync(path.join(__dirname, "../utils.js"), "utf8"), context); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  const send = (msg) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Command did not respond")), 500);
    listener(msg, {}, (result) => { clearTimeout(timeout); resolve(result); });
  });
  return { send, removed, get loads() { return loads; }, get tabs() { return tabs; }, set tabs(value) { tabs = value; }, get queries() { return queries; } };
}
function tab(id, url = "https://copies.example/page", extra = {}) {
  return { id, url, windowId: 1, index: id, pinned: false, active: false, ...extra };
}

function activateSuccessor(id, tabs) {
  const closing = tabs.find((item) => item.id === id);
  if (!closing.active) return;
  const siblings = tabs.filter((item) => item.id !== id && item.windowId === closing.windowId);
  const next = siblings.find((item) => item.index > closing.index) || siblings.at(-1);
  for (const item of siblings) item.active = item.id === next?.id;
}

async function clickDuplicateAction(app, button, accept = true) {
  const pending = button.listeners.click({ stopPropagation() {} });
  await app.settle();
  if (app.get("duplicateConfirmDialog").open) {
    app.get(accept ? "duplicateConfirmAccept" : "duplicateConfirmCancel").listeners.click();
  }
  await pending;
}

for (const namespace of ["chrome", "browser"]) {
  for (const mode of ["keep", "closeAll"]) {
    const label = mode === "keep" ? "Keep this" : "Close all copies";
    const clickedId = mode === "keep" ? 3 : 1;
    const selector = mode === "keep" ? ".btn-dedup" : ".btn-close-copies";
    it(`finishes ${label} when closing an active copy activates its successor through ${namespace}`, async () => {
      const bg = broker([tab(1, undefined, { active: true }), tab(2), tab(3)], namespace, {
        remove: activateSuccessor,
      });
      const app = dashboard(bg.send);
      await app.settle();
      const row = app.get("tab-body").children.find((item) => item.dataset.tabId === String(clickedId));
      await clickDuplicateAction(app, row.querySelector(selector));
      assert.deepEqual(bg.tabs.map((item) => item.id), mode === "keep" ? [3] : []);
      assert.deepEqual(bg.removed, mode === "keep" ? [2, 1] : [2, 3, 1]);
      assert.match(app.get("undo-toast-msg").textContent, mode === "keep" ? /Closed 2 tabs/ : /Closed 3 tabs/);
    });

    it(`preserves an externally activated candidate during ${label} through ${namespace}`, async () => {
      const bg = broker([tab(1, undefined, { active: true }), tab(2), tab(3)], namespace, {
        query: (tabs, count) => {
          if (count !== 2) return;
          for (const item of tabs) item.active = item.id === 2;
        },
        remove: activateSuccessor,
      });
      const app = dashboard(bg.send);
      await app.settle();
      const row = app.get("tab-body").children.find((item) => item.dataset.tabId === String(clickedId));
      await clickDuplicateAction(app, row.querySelector(selector));
      assert.deepEqual(bg.tabs.map((item) => item.id), mode === "keep" ? [2, 3] : [2]);
      assert.equal(bg.removed.includes(2), false);
      assert.deepEqual([...bg.removed].sort((a, b) => a - b), mode === "keep" ? [1] : [1, 3]);
      assert.match(app.get("undo-toast-msg").textContent, /1 skipped/);
    });
  }
}

for (const namespace of ["browser", "chrome"]) {
  it(`previews all windows and retains every protected copy through ${namespace}`, async () => {
    const bg = broker([tab(9), tab(2), tab(3, undefined, { pinned: true }),
      tab(4, undefined, { active: true, windowId: 2 }), tab(5),
      tab(6, undefined, { pendingUrl: "chrome-extension://fixture/triage.html" }),
      tab(7, "https://other.example"), tab(8, "https://other.example", { windowId: 2 })], namespace);
    const preview = await bg.send({ type: "previewDuplicates" });
    assert.equal(preview.ok, true);
    assert.equal(preview.plan.mode, "global");
    assert.deepEqual(Array.from(preview.plan.groups.flatMap((group) => group.candidates.map((item) => item.id))), [2, 5, 9, 8]);
    assert.deepEqual(bg.removed, []);
    const result = await bg.send({ type: "closeDuplicates", plan: preview.plan });
    assert.equal(result.ok, true);
    assert.equal(result.closedCount, 4);
    assert.deepEqual(bg.removed, [2, 5, 9, 8]);
    assert.deepEqual(bg.tabs.map((item) => item.id), [3, 4, 6, 7]);
  });
}

it("labels keep-this loaded scope and separately confirms close-all with pinned/active risk counts", async () => {
  const tabs = [tab(1), tab(2, undefined, { pinned: true, active: true, windowId: 2 }), tab(3)];
  const bg = broker(tabs);
  const app = dashboard(bg.send);
  await app.settle();
  app.run('ignoredDomains.add("copies.example"); document.getElementById("search").value = "hidden";');
  const row = app.get("tab-body").children[0];
  assert.match(row.querySelector(".btn-dedup").textContent, /Keep this.*2/);
  assert.match(row.querySelector(".btn-dedup").title, /loaded.*all windows.*ignored/i);
  let question;
  const closeAll = row.querySelector(".btn-close-copies");
  assert.ok(closeAll, "close all copies is distinct from keep this");
  closeAll.focus();
  await clickDuplicateAction(app, closeAll, false);
  question = app.get("duplicateConfirmMessage").textContent;
  assert.match(question, /Close all copies/);
  assert.match(question, /3 tabs/);
  assert.match(question, /1 pinned.*1 active/);
  assert.match(question, /including this tab/);
  assert.deepEqual(bg.removed, []);
  assert.equal(app.run("document.activeElement"), closeAll);
  await clickDuplicateAction(app, closeAll);
  assert.deepEqual(bg.removed, [1, 3, 2]);
  assert.match(app.get("undo-toast-msg").textContent, /Closed 3 tabs/);
});

it("keeps clicked copy and includes pinned active ignored/filtered copies across loaded windows", async () => {
  const bg = broker([tab(1), tab(2, undefined, { pinned: true, active: true, windowId: 2 }), tab(3)]);
  const app = dashboard(bg.send);
  await app.settle();
  app.run('ignoredDomains.add("copies.example"); document.getElementById("search").value = "hidden";');
  await app.get("tab-body").children[0].querySelector(".btn-dedup").listeners.click({ stopPropagation() {} });
  assert.deepEqual(bg.removed, [3, 2]);
  assert.deepEqual(bg.tabs.map((item) => item.id), [1]);
});

it("confirms global browser-wide preview independently of filters and ignore lists", async () => {
  const bg = broker([tab(3), tab(2), tab(1), tab(4, undefined, { pinned: true }), tab(5, undefined, { active: true, windowId: 2 })]);
  const app = dashboard(bg.send);
  await app.settle();
  app.run('ignoredDomains.add("copies.example"); document.getElementById("search").value = "no results"; render();');
  await clickDuplicateAction(app, app.get("dedupAll"), false);
  const question = app.get("duplicateConfirmMessage").textContent;
  assert.match(question, /all accessible windows.*filtered-out.*ignored/s);
  assert.match(question, /3 tabs/);
  assert.match(question, /protected.*remain/s);
  assert.deepEqual(bg.removed, []);
  await clickDuplicateAction(app, app.get("dedupAll"));
  assert.deepEqual(bg.removed, [1, 2, 3]);
});

it("rejects malformed duplicate plans before any browser API effect", async () => {
  const bg = broker([tab(1), tab(2)]);
  const base = (await bg.send({ type: "previewDuplicates" })).plan;
  const before = bg.queries;
  const invalid = [null, {}, { ...base, mode: "unknown" }, { ...base, groups: null }];
  for (const field of ["id", "windowId"]) {
    for (const value of [true, -1, 1.5, "2", NaN, Infinity, undefined]) {
      const plan = structuredClone(base);
      plan.groups[0].candidates[0][field] = value;
      invalid.push(plan);
    }
  }
  for (const value of [true, -1, "1", NaN, Infinity]) {
    const plan = structuredClone(base);
    plan.groups[0].keeperIds = [value];
    invalid.push(plan);
  }
  const holes = structuredClone(base);
  holes.groups[0].candidates = Array(1);
  invalid.push(holes);
  for (const plan of invalid) {
    assert.equal((await bg.send({ type: "closeDuplicates", plan })).ok, false);
  }
  assert.equal(bg.queries, before);
  assert.deepEqual(bg.removed, []);
});

it("never extends a preview to new duplicates and skips changed protected pending or closed candidates", async () => {
  const bg = broker([1, 2, 3, 4, 5, 6, 7, 8].map((id) => tab(id)));
  const { plan } = await bg.send({ type: "previewDuplicates" });
  bg.tabs = [tab(1), tab(2, "https://elsewhere.example"), tab(3, undefined, { pinned: true }),
    tab(4, undefined, { active: true }), tab(5, undefined, { pendingUrl: "chrome-extension://fixture/triage.html" }),
    tab(6, undefined, { pendingUrl: "https://navigating.example" }), tab(8), tab(9)];
  const result = await bg.send({ type: "closeDuplicates", plan });
  assert.deepEqual(bg.removed, [8]);
  assert.equal(result.closedCount, 1);
  assert.equal(result.skippedCount, 6);
});

it("skips loading candidates whose pending destination is unavailable", async () => {
  for (const namespace of ["browser", "chrome"]) {
    for (const mode of ["global", "keep", "closeAll"]) {
      const bg = broker([tab(1), tab(2), tab(3)], namespace);
      const { plan } = await bg.send({ type: "previewDuplicates" });
      plan.mode = mode;
      if (mode === "closeAll") {
        plan.groups[0].keeperIds = [];
        plan.groups[0].candidates = bg.tabs.map((item) => ({ ...item }));
      }
      bg.tabs[1].status = "loading";
      const result = await bg.send({ type: "closeDuplicates", plan });
      assert.deepEqual(bg.removed, mode === "closeAll" ? [1, 3] : [3], `${namespace}/${mode}`);
      assert.equal(result.skippedCount, 1);
      assert.ok(bg.tabs.some((item) => item.id === 2));
    }
  }
});

it("does not rely on a loading keeper whose pending destination is unavailable", async () => {
  for (const namespace of ["browser", "chrome"]) {
    for (const mode of ["global", "keep"]) {
      const bg = broker([tab(1), tab(2), tab(3)], namespace);
      const { plan } = await bg.send({ type: "previewDuplicates" });
      plan.mode = mode;
      bg.tabs[0].status = "loading";
      const result = await bg.send({ type: "closeDuplicates", plan });
      assert.deepEqual(bg.removed, []);
      assert.equal(result.skippedCount, 2);
    }
  }
});

it("retains closure eligibility for an explicitly matching pending destination", async () => {
  for (const namespace of ["browser", "chrome"]) {
    const bg = broker([tab(1), tab(2)], namespace);
    const { plan } = await bg.send({ type: "previewDuplicates" });
    for (const item of bg.tabs) {
      item.status = "loading";
      item.pendingUrl = item.url;
    }
    const result = await bg.send({ type: "closeDuplicates", plan });
    assert.deepEqual(bg.removed, [2]);
    assert.equal(result.closedCount, 1);
    assert.equal(result.skippedCount, 0);
  }
});

it("skips an equivalent but navigated candidate and aborts when the preview keeper disappears", async () => {
  const bg = broker([tab(1), tab(2), tab(3)]);
  const { plan } = await bg.send({ type: "previewDuplicates" });
  bg.tabs[1].url += "/";
  const result = await bg.send({ type: "closeDuplicates", plan });
  assert.deepEqual(bg.removed, [3]);
  assert.equal(result.skippedCount, 1);
  bg.tabs = [tab(2), tab(3), tab(9)];
  assert.equal((await bg.send({ type: "closeDuplicates", plan })).skippedCount, 2);
  assert.deepEqual(bg.removed, [3]);
});

it("reports actual readback outcomes for success, denial, no-op and closed-before-rejection", async () => {
  const bg = broker([1, 2, 3, 4, 5].map((id) => tab(id)), "chrome", {
    remove: async (id, tabs) => {
      if (id === 3) throw new Error("Denied");
      if (id === 4) { tabs.splice(tabs.findIndex((tab) => tab.id === id), 1); throw new Error("Closed before rejection"); }
    },
  });
  const { plan } = await bg.send({ type: "previewDuplicates" });
  const result = await bg.send({ type: "closeDuplicates", plan });
  assert.equal(result.closedCount, 3);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(bg.tabs.map((tab) => tab.id), [1, 3]);
});

it("rejects overlapping duplicate and legacy closes in the broker then releases the gate", async () => {
  let finish;
  const bg = broker([tab(1), tab(2)], "chrome", { remove: () => new Promise((resolve) => { finish = resolve; }) });
  const { plan } = await bg.send({ type: "previewDuplicates" });
  const pending = bg.send({ type: "closeDuplicates", plan });
  await new Promise(setImmediate);
  for (const message of [{ type: "closeDuplicates", plan }, { type: "closeTabs", tabIds: [1] }, { type: "closeTab", tabId: 1 }]) {
    assert.equal((await bg.send(message)).ok, false);
  }
  assert.deepEqual(bg.removed, [2]);
  finish();
  await pending;
  assert.equal((await bg.send({ type: "closeDuplicates", plan })).ok, true);
});

it("suppresses row and selected closures while a global preview is pending", async () => {
  let finishPreview;
  const messages = [];
  const app = dashboard((message) => {
    messages.push(message);
    if (message.type === "getTabs") return { ok: true, tabs: [tab(1), tab(2)] };
    if (message.type === "previewDuplicates") return new Promise((resolve) => { finishPreview = resolve; });
    return { ok: true };
  });
  await app.settle();
  app.get("selectFiltered").listeners.click();
  const pending = app.get("dedupAll").listeners.click();
  await app.get("closeSelected").listeners.click();
  await app.get("tab-body").children[0].querySelector(".btn-close").listeners.click({ stopPropagation() {} });
  assert.equal(messages.filter((message) => ["closeTabs", "closeTab"].includes(message.type)).length, 0);
  finishPreview({ ok: true, plan: { mode: "global", groups: [] } });
  await pending;
});

it("renders duplicate controls without rebuilding an inventory-wide plan for every row", async () => {
  const app = dashboard(() => ({ ok: true, tabs: Array.from({ length: 100 }, (_, id) => tab(id)) }));
  await app.settle();
  app.run('globalThis.identityCalls = 0; const originalIdentity = normalizeUrl; normalizeUrl = (url) => { identityCalls++; return originalIdentity(url); }; render();');
  assert.ok(app.run("identityCalls") <= 300, "render should remain linear in inventory size");
});

it("loads Chromium worker helpers during initial script evaluation, not after installation", () => {
  assert.equal(broker([]).loads, 1);
});

it("preserves the global trigger's focus after asynchronous preview cancellation", async () => {
  const bg = broker([tab(1), tab(2)]);
  const app = dashboard(bg.send);
  await app.settle();
  const trigger = app.get("dedupAll");
  trigger.focus();
  await clickDuplicateAction(app, trigger, false);
  assert.equal(app.run("document.activeElement"), trigger);
  assert.deepEqual(bg.removed, []);
  assert.equal(app.get("undo-toast").hidden, true);
});

it("preserves search through repeat events after confirmation cancellation", async () => {
  const bg = broker([tab(1), tab(2)]);
  const app = dashboard(bg.send);
  await app.settle();
  app.get("search").value = "preserved-query";
  const trigger = app.get("dedupAll");
  trigger.focus();
  await clickDuplicateAction(app, trigger, false);
  // Repeat events after dialog cancellation must not clear the search.
  for (let repeat = 0; repeat < 8; repeat++) {
    app.documentListeners.keydown({ key: "Escape", repeat: true });
  }
  assert.equal(app.get("search").value, "preserved-query");
  assert.deepEqual(bg.removed, []);
  assert.equal(app.run("document.activeElement"), trigger);
  app.documentListeners.keydown({ key: "Escape", repeat: false });
  assert.equal(app.get("search").value, "");
});

it("styles both destructive row actions, wrapping controls and explicit busy state", () => {
  const css = fs.readFileSync(path.join(__dirname, "../triage.css"), "utf8");
  assert.match(css, /\.action-buttons\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.btn-close,\s*\.btn-close-copies\s*\{/);
  assert.match(css, /button\[aria-disabled="true"\]/);
  assert.match(css, /#duplicateStatus/);
});

it("reports unavailable readback as unverified rather than inventing closure counts", async () => {
  const bg = broker([tab(1), tab(2)], "chrome", {
    remove: async () => { throw new Error("Denied"); },
    query: async (tabs, count) => { if (count === 3) throw new Error("Readback unavailable"); },
  });
  const { plan } = await bg.send({ type: "previewDuplicates" });
  const result = await bg.send({ type: "closeDuplicates", plan });
  assert.equal(result.closedCount, 0);
  assert.equal(result.failedCount, 0);
  assert.equal(result.unverifiedCount, 1);
});

it("rejects unknown new-command options and inconsistent identities without tab API effects", async () => {
  const bg = broker([tab(1), tab(2)]);
  const { plan } = await bg.send({ type: "previewDuplicates" });
  const before = bg.queries;
  const inconsistent = structuredClone(plan);
  inconsistent.groups[0].key = "https://unrelated.example";
  assert.equal((await bg.send({ type: "closeDuplicates", plan: inconsistent })).ok, false);
  assert.equal((await bg.send({ type: "previewDuplicates", mode: "unknown" })).ok, false);
  assert.equal((await bg.send({ type: "closeDuplicates", plan, overrideProtection: true })).ok, false);
  assert.equal(bg.queries, before);
  assert.deepEqual(bg.removed, []);
});

it("counts an acknowledged browser no-op as failed rather than closed", async () => {
  const bg = broker([tab(1), tab(2)], "chrome", { remove: async () => false });
  const { plan } = await bg.send({ type: "previewDuplicates" });
  const result = await bg.send({ type: "closeDuplicates", plan });
  assert.equal(result.closedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(bg.tabs.map((tab) => tab.id), [1, 2]);
});

it("rechecks keepers and newly protected candidates between individual removals", async () => {
  const bg = broker([tab(1), tab(2), tab(3), tab(4)], "chrome", {
    remove: async (id, tabs) => {
      if (id === 2) {
        tabs.splice(tabs.findIndex((tab) => tab.id === 1), 1);
        tabs.find((tab) => tab.id === 3).active = true;
      }
    },
  });
  const { plan } = await bg.send({ type: "previewDuplicates" });
  const result = await bg.send({ type: "closeDuplicates", plan });
  assert.deepEqual(bg.removed, [2]);
  assert.equal(result.closedCount, 1);
  assert.equal(result.skippedCount, 2);
});

it("retains prior row inclusion but skips newly pinned/active copies after its snapshot", async () => {
  const bg = broker([tab(1), tab(2), tab(3), tab(4, undefined, { pinned: true, active: true })]);
  const app = dashboard(bg.send);
  await app.settle();
  bg.tabs[1].pinned = true;
  bg.tabs[2].active = true;
  await app.get("tab-body").children[0].querySelector(".btn-dedup").listeners.click({ stopPropagation() {} });
  assert.deepEqual(bg.removed, [4]);
  assert.deepEqual(bg.tabs.map((tab) => tab.id), [1, 2, 3]);
  assert.match(app.get("duplicateStatus").textContent, /Closed 1 tabs; 2 skipped/);
});

it("offers recovery for verified mixed closure without claiming full success", async () => {
  const bg = broker([tab(1), tab(2), tab(3)], "chrome", { remove: async (id) => { if (id === 3) throw new Error("Denied"); } });
  const app = dashboard(bg.send);
  await app.settle();
  await app.get("tab-body").children[0].querySelector(".btn-dedup").listeners.click({ stopPropagation() {} });
  assert.match(app.get("undo-toast-msg").textContent, /Closed 1 tabs; 0 skipped, 1 failed/);
  assert.match(app.get("bulkError").textContent, /Some duplicate closures failed/);
  assert.deepEqual(Array.from(app.run("allTabs.map((tab) => tab.id)")), [1, 3]);
});

it("rejects impossible duplicate response totals without false recovery", async () => {
  const app = dashboard((message) => message.type === "getTabs" ? { ok: true, tabs: [tab(1), tab(2)] } :
    { ok: true, closedCount: 99, skippedCount: 0, failedCount: 0, unverifiedCount: 0 });
  await app.settle();
  await app.get("tab-body").children[0].querySelector(".btn-dedup").listeners.click({ stopPropagation() {} });
  assert.equal(app.get("undo-toast").hidden, true);
  assert.match(app.get("bulkError").textContent, /Invalid duplicate closure response/);
});

it("keeps an internal clicked copy without deleting different opaque-origin URLs", async () => {
  const bg = broker([tab(1, "chrome://settings/"), tab(2, "chrome://settings/"),
    tab(3, "chrome://newtab/"), tab(4, "chrome://extensions/"),
    tab(5, "file:///one.example"), tab(6, "chrome-extension://other/page")]);
  const app = dashboard(bg.send);
  await app.settle();
  await app.get("tab-body").children[0].querySelector(".btn-dedup").listeners.click({ stopPropagation() {} });
  assert.deepEqual(bg.removed, [2]);
  assert.deepEqual(bg.tabs.map((tab) => tab.id), [1, 3, 4, 5, 6]);
});

it("protects loaded and pending dashboards even after preview identities become dashboard URLs", async () => {
  const bg = broker([tab(1), tab(2), tab(3)]);
  const { plan } = await bg.send({ type: "previewDuplicates" });
  bg.tabs[1].url = "chrome-extension://fixture/triage.html#dashboard";
  bg.tabs[2].pendingUrl = "chrome-extension://fixture/triage.html?loading=1";
  const result = await bg.send({ type: "closeDuplicates", plan });
  assert.equal(result.skippedCount, 2);
  assert.deepEqual(bg.removed, []);
});
