const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(source.slice(0, source.indexOf("for (const [selector, type]")) + ";dashboard", { require, __dirname, URL, setImmediate });

it("models native focus loss when a focused notification button is replaced", async () => {
  const app = dashboard(() => ({ ok: true, tabs: [] }));
  await app.settle();
  const old = app.get("undo-toast-btn");
  old.focus();
  old.replaceWith(old.cloneNode(true));
  assert.notEqual(app.run("document.activeElement"), old, "detached controls cannot keep focus");
  const current = app.get("undo-toast-btn");
  current.focus();
  current.disabled = true;
  assert.notEqual(app.run("document.activeElement"), current, "native disabled controls can lose focus before settlement");
});

for (const outcome of ["success", "denied", "rejected", "refresh-rejected"]) {
  for (const moved of ["recovery", "search", "other"]) {
    it(`ignores stale restore ${outcome} after replacement with ${moved} focused`, async () => {
      let finishRestore;
      let settled = false;
      const app = dashboard((message) => {
        if (message.type === "getTabs") {
          if (settled && outcome === "refresh-rejected") throw new Error("Old refresh rejected");
          return { ok: true, tabs: [] };
        }
        return new Promise((resolve, reject) => {
          finishRestore = () => outcome === "rejected" ? reject(new Error("Old channel closed")) :
            resolve(outcome === "denied" ? { ok: false, error: "Old restore denied" } : { ok: true });
        });
      });
      await app.settle();
      app.run('showUndoToast("Old close completed.")');
      const old = app.get("undo-toast-btn");
      old.focus();
      const pending = old.listeners.click();
      app.run('showUndoToast("New close completed.")');
      const current = app.get("undo-toast-btn");
      assert.notEqual(current, old);
      assert.equal(app.run("document.activeElement"), current);
      const focused = moved === "recovery" ? current : app.get(moved === "search" ? "search" : "refresh");
      focused.focus();
      settled = true;
      finishRestore();
      await pending;
      assert.equal(app.get("undo-toast").hidden, false);
      assert.equal(app.get("undo-toast-btn"), current);
      assert.equal(current.disabled, false);
      assert.equal(app.get("undo-toast-msg").textContent, "New close completed.");
      assert.equal(app.get("bulkError").textContent, "");
      assert.equal(app.run("document.activeElement"), focused);
      assert.equal(app.messages.filter((entry) => entry.type === "restoreTab").length, 1);
    });
  }
}

for (const moved of ["recovery", "search", "other"]) {
  it(`transfers replacement recovery focus only from the current button: ${moved}`, async () => {
    let finishClose;
    const app = dashboard((message) => message.type === "getTabs" ? { ok: true, tabs: [] } :
      new Promise((resolve) => { finishClose = resolve; }));
    await app.settle();
    app.run('showUndoToast("Earlier close completed.")');
    const oldButton = app.get("undo-toast-btn");
    const pending = app.run('runTabAction({ type: "closeTab", tabId: 1 }, "New close completed.")');
    const focused = moved === "recovery" ? oldButton : app.get(moved === "search" ? "search" : "refresh");
    focused.focus();
    finishClose({ ok: true });
    await pending;
    const current = app.get("undo-toast-btn");
    assert.notEqual(current, oldButton);
    assert.equal(app.run("document.activeElement"), moved === "recovery" ? current : focused);
    assert.equal(app.get("undo-toast").hidden, false);
    assert.equal(current.disabled, false);
  });
}

for (const outcome of ["success", "denied", "rejected"]) {
  for (const moved of ["recovery", "search", "other"]) {
    it(`settles restore ${outcome} without leaving hidden focus or stealing ${moved} focus`, async () => {
      let finishRestore;
      const app = dashboard((message) => message.type === "getTabs" ? { ok: true, tabs: [] } :
        new Promise((resolve, reject) => {
          finishRestore = () => outcome === "rejected" ? reject(new Error("Channel closed")) :
            resolve(outcome === "success" ? { ok: true } : { ok: false, error: "Restore denied" });
        }));
      await app.settle();
      app.run('showUndoToast("Close completed.")');
      const button = app.get("undo-toast-btn");
      button.focus();
      const pending = button.listeners.click();
      assert.equal(app.run("document.activeElement"), button, "pending restore must not blur its focused control");
      assert.equal(button.getAttribute("aria-disabled"), "true");
      await button.listeners.click();
      assert.equal(app.messages.filter((entry) => entry.type === "restoreTab").length, 1, "pending Enter/click cannot restore twice");
      const focused = moved === "recovery" ? button : app.get(moved === "search" ? "search" : "refresh");
      focused.focus();
      finishRestore();
      await pending;
      assert.equal(app.run("document.activeElement"),
        outcome === "success" && moved === "recovery" ? app.get("search") : focused);
      assert.equal(app.get("undo-toast").hidden, outcome === "success");
      if (outcome !== "success") {
        assert.equal(button.disabled, false);
        assert.match(app.get("bulkError").textContent, /Restore denied|Channel closed/);
      }
      const restores = app.messages.filter((entry) => entry.type === "restoreTab");
      assert.equal(restores.length, 1);
      assert.deepEqual(Object.keys(restores[0]), ["type"], "restore exactly one browser-selected session");
    });
  }
}
