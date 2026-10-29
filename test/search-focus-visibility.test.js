const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(source.slice(0, source.indexOf("for (const [selector, type]")) + ";dashboard", { require, __dirname, URL, setImmediate });

function observeFocus(element) {
  const calls = [];
  const original = element.focus;
  element.focus = function(options) {
    calls.push(options);
    original.call(this, options);
  };
  return calls;
}

it("allows search fallback to scroll into view after a focused row disappears", async () => {
  let tabs = [{ id: 1, title: "Fixture", url: "https://example.test" }];
  const app = dashboard(() => ({ ok: true, tabs }));
  await app.settle();
  app.get("tab-body").children[0].querySelector(".btn-close").focus();
  const calls = observeFocus(app.get("search"));
  tabs = [];
  await app.run("loadTabs()");
  assert.equal(app.run("document.activeElement"), app.get("search"));
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0]?.preventScroll, true);
});

it("allows search fallback to scroll into view after focused recovery succeeds", async () => {
  const app = dashboard((message) => message.type === "getTabs" ? { ok: true, tabs: [] } : { ok: true });
  await app.settle();
  app.run('showUndoToast("Fixture closed")');
  const button = app.get("undo-toast-btn");
  button.focus();
  const calls = observeFocus(app.get("search"));
  await button.listeners.click();
  assert.equal(app.run("document.activeElement"), app.get("search"));
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0]?.preventScroll, true);
});
