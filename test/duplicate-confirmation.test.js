const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const fixture = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(
  fixture.slice(0, fixture.indexOf("for (const [selector, type]")) + ";dashboard",
  { require, __dirname, URL, setImmediate },
);

async function createApp() {
  let plan;
  const app = dashboard((message) => {
    if (message.type === "getTabs") return { ok: true, tabs: [1, 2].map((id) => (
      { id, windowId: 1, index: id, url: "https://copies.example/page" }
    )) };
    if (message.type === "previewDuplicates") return { ok: true, plan };
    return { ok: true, closedCount: 1, skippedCount: 0, failedCount: 0, unverifiedCount: 0 };
  });
  await app.settle();
  plan = app.run('buildDuplicatePlan(enrichedTabs, "global", api.runtime.getURL("triage.html"))');
  app.get("search").value = "preserved-query";
  app.get("dedupAll").focus();
  return app;
}

it("holds duplicate closure behind an explicit named native-dialog confirmation", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../triage.html"), "utf8");
  assert.match(html, /<dialog\b[^>]*id="duplicateConfirmDialog"[^>]*aria-labelledby="duplicateConfirmTitle"/);
  const app = await createApp();
  const pending = app.get("dedupAll").listeners.click();
  await app.settle();
  assert.equal(app.get("duplicateConfirmDialog").open, true);
  assert.equal(app.run("document.activeElement"), app.get("duplicateConfirmAccept"));
  assert.match(app.get("duplicateConfirmMessage").textContent, /all accessible windows.*filtered-out.*ignored/s);
  assert.match(app.get("duplicateConfirmMessage").textContent, /At risk: 0 pinned, 0 active/);
  assert.equal(app.messages.some((message) => message.type === "closeDuplicates"), false);
  app.get("duplicateConfirmCancel").listeners.click();
  await pending;
  assert.equal(app.run("document.activeElement"), app.get("dedupAll"));
});

it("consumes the first nonrepeat Escape while confirmation is open, not only its repeats", async () => {
  const app = await createApp();
  const pending = app.get("dedupAll").listeners.click();
  await app.settle();
  let prevented = false;
  app.documentListeners.keydown({ key: "Escape", repeat: false, preventDefault() { prevented = true; } });
  for (let count = 0; count < 16; count++) app.documentListeners.keydown({ key: "Escape", repeat: true });
  await pending;
  assert.equal(prevented, true);
  assert.equal(app.get("duplicateConfirmDialog").open, false);
  assert.equal(app.get("search").value, "preserved-query");
  assert.equal(app.messages.some((message) => message.type === "closeDuplicates"), false);
  app.documentListeners.keydown({ key: "Escape", repeat: false });
  assert.equal(app.get("search").value, "");
});

it("requires a fresh affirmative response after cancellation without swallowing later Escape", async () => {
  const app = await createApp();
  let pending = app.get("dedupAll").listeners.click();
  await app.settle();
  app.get("duplicateConfirmCancel").listeners.click();
  await pending;
  app.documentListeners.keydown({ key: "Escape", repeat: false });
  assert.equal(app.get("search").value, "", "mouse cancellation must not arm a sticky Escape suppression flag");
  pending = app.get("dedupAll").listeners.click();
  await app.settle();
  assert.equal(app.get("duplicateConfirmDialog").open, true);
  assert.equal(app.messages.filter((message) => message.type === "closeDuplicates").length, 0);
  app.get("duplicateConfirmAccept").listeners.click();
  await pending;
  assert.equal(app.messages.filter((message) => message.type === "closeDuplicates").length, 1);
  assert.match(app.get("duplicateStatus").textContent, /Closed 1 tabs/);
});

for (const hideRow of [false, true]) {
  it(`restores a refreshed row confirmation to ${hideRow ? "search when its action disappears" : "the replacement action"}`, async () => {
    const app = await createApp();
    app.get("search").value = "";
    const original = app.get("tab-body").children.find((row) => row.dataset.tabId === "1").querySelector(".btn-close-copies");
    original.focus();
    const pending = app.run('runDuplicateAction("closeAll", 1)');
    await app.settle();
    if (hideRow) app.get("search").value = "no-match";
    await app.get("refresh").listeners.click();
    assert.equal(app.get("duplicateConfirmDialog").open, true);
    const replacement = app.get("tab-body").children.find((row) => row.dataset.tabId === "1")?.querySelector(".btn-close-copies");
    assert.notEqual(replacement, original);
    app.get("duplicateConfirmCancel").listeners.click();
    await pending;
    assert.equal(app.run("document.activeElement") === (hideRow ? app.get("search") : replacement), true);
    assert.equal(app.messages.some((message) => message.type === "closeDuplicates"), false);
  });
}

it("also consumes held Escape for ignored-list reset without changing preferences", async () => {
  const app = await createApp();
  app.run('ignoredDomains.add("copies.example")');
  app.get("resetIgnored").focus();
  const pending = app.get("resetIgnored").listeners.click();
  assert.equal(app.get("duplicateConfirmDialog").open, true);
  assert.equal(app.get("duplicateConfirmTitle").textContent, "Reset ignored lists");
  assert.equal(app.get("duplicateConfirmMessage").textContent, "Remove all ignored URLs and domains?");
  app.documentListeners.keydown({ key: "Escape", repeat: false, preventDefault() {} });
  for (let count = 0; count < 16; count++) app.documentListeners.keydown({ key: "Escape", repeat: true });
  await pending;
  assert.equal(app.run('ignoredDomains.has("copies.example")'), true);
  assert.equal(app.get("search").value, "preserved-query");
  assert.equal(app.run("document.activeElement"), app.get("resetIgnored"));
  app.documentListeners.keydown({ key: "Escape", repeat: false });
  assert.equal(app.get("search").value, "");
});

it("requires affirmative ignored-list reset and resets the next duplicate confirmation's labels", async () => {
  const app = await createApp();
  app.run('ignoredDomains.add("copies.example")');
  let pending = app.get("resetIgnored").listeners.click();
  assert.equal(app.get("duplicateConfirmAccept").textContent, "Reset ignored lists");
  assert.equal(app.run('ignoredDomains.has("copies.example")'), true);
  app.get("duplicateConfirmAccept").listeners.click();
  await pending;
  assert.equal(app.run("ignoredDomains.size"), 0);
  pending = app.get("dedupAll").listeners.click();
  await app.settle();
  assert.equal(app.get("duplicateConfirmTitle").textContent, "Confirm duplicate closure");
  assert.equal(app.get("duplicateConfirmAccept").textContent, "Confirm closure");
  assert.equal(app.get("duplicateConfirmDialog").open, true);
  assert.equal(app.messages.some((message) => message.type === "closeDuplicates"), false);
  app.get("duplicateConfirmCancel").listeners.click();
  await pending;
});

it("does not replace a pending approval with another confirmation action", async () => {
  const app = await createApp();
  app.run('ignoredDomains.add("untouched.example")');
  const pending = app.get("dedupAll").listeners.click();
  await app.settle();
  await app.get("resetIgnored").listeners.click();
  assert.equal(app.get("duplicateConfirmDialog").open, true);
  assert.equal(app.get("duplicateConfirmTitle").textContent, "Confirm duplicate closure");
  assert.equal(app.run('ignoredDomains.has("untouched.example")'), true);
  app.get("duplicateConfirmCancel").listeners.click();
  await pending;
  assert.equal(app.messages.some((message) => message.type === "closeDuplicates"), false);
});
