const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(source.slice(0, source.indexOf("for (const [selector, type]")) + ";dashboard", { require, __dirname, URL, setImmediate });

for (const outcome of ["success", "denied", "rejected"]) {
  for (const moved of ["none", "search", "other-row", "during-refresh"]) {
    it(`preserves logical row focus through discard ${outcome}, focus move: ${moved}`, async () => {
      let finishAction;
      let finishRefresh;
      let queries = 0;
      const tabs = [1, 2].map((id) => ({ id, windowId: 1, title: "Example", url: "https://example.test" }));
      const app = dashboard((message) => {
        if (message.type === "getTabs") {
          if (++queries === 1) return { ok: true, tabs };
          return new Promise((resolve) => { finishRefresh = () => resolve({ ok: true, tabs }); });
        }
        return new Promise((resolve, reject) => {
          finishAction = () => outcome === "rejected" ? reject(new Error("Rejected")) :
            resolve(outcome === "success" ? { ok: true } : { ok: false, error: "Denied" });
        });
      });
      await app.settle();
      const action = app.get("tab-body").children[0].querySelector(".btn-discard");
      action.focus();
      const pending = action.listeners.click({ stopPropagation() {} });
      if (moved === "search") app.get("search").focus();
      if (moved === "other-row") app.get("tab-body").children[1].querySelector(".btn-goto").focus();
      finishAction();
      await app.settle();
      if (moved === "during-refresh") app.get("search").focus();
      finishRefresh();
      await pending;
      const expected = moved === "search" || moved === "during-refresh" ? app.get("search") :
        app.get("tab-body").children[moved === "other-row" ? 1 : 0].querySelector(moved === "other-row" ? ".btn-goto" : ".btn-more");
      assert.equal(app.run("document.activeElement"), expected);
    });
  }
}

for (const action of [".btn-goto", ".btn-close", ".btn-dedup", ".tab-select"]) {
  it(`restores ${action} or a safe fallback when refresh removes the original control`, async () => {
    const tabs = [1, 2].map((id) => ({ id, windowId: 1, title: "Example", url: "https://example.test" }));
    const app = dashboard(() => ({ ok: true, tabs }));
    await app.settle();
    app.get("tab-body").children[0].querySelector(action).focus();
    if (action === ".btn-dedup") tabs.pop();
    if (action === ".btn-close") tabs.shift();
    await app.run("loadTabs()");
    const expected = action === ".btn-close" ? app.get("search") :
      app.get("tab-body").children[0].querySelector(action === ".btn-dedup" ? ".btn-more" : action);
    assert.equal(app.run("document.activeElement"), expected);
    assert.equal(app.get("tab-body").children.length, tabs.length);
  });
}
