const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "dashboard-regressions.test.js"), "utf8");
const { createDashboard, createMenu } = vm.runInNewContext(
  source.slice(0, source.indexOf('describe("fixed row menus"'))
    .replace("ResizeObserver: class { observe() {} }", "ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() {} }")
    + ";({ createDashboard, createMenu })",
  { require, __dirname, URL },
);

it("flips lower-row actions above visible recovery instead of the viewport bottom", () => {
  const app = createDashboard();
  const toast = app.elements.get("undo-toast");
  app.context.window.innerHeight = 720;
  toast.hidden = false;
  toast.getBoundingClientRect = () => ({ top: 650 });
  const { menu, click } = createMenu(app, { top: 587, bottom: 611, right: 1185 },
    { width: 160, height: 86 });
  click();
  assert.equal(menu.style.top, "497px");
  assert.equal(menu.style.maxHeight, "634px");
  assert.ok(parseFloat(menu.style.top) + 86 <= 642);
});

for (const [toastTop, expectedHeight] of [[70, 54], [800, 584]]) {
  it(`clamps oversized actions to recovery/viewport boundary ${toastTop}`, () => {
    const app = createDashboard();
    const toast = app.elements.get("undo-toast");
    toast.hidden = false;
    toast.getBoundingClientRect = () => ({ top: toastTop });
    const { menu, click } = createMenu(app, { top: 510, bottom: 530, right: 900 },
      { width: 1000, height: 900 });
    click();
    assert.equal(menu.style.top, "8px");
    assert.equal(menu.style.left, "8px");
    assert.equal(menu.style.maxHeight, `${expectedHeight}px`);
    assert.equal(menu.style.overflow, "auto");
  });
}

for (const boundary of ["replacement", "observer"]) {
  for (const focused of [true, false]) {
    it(`safely dismisses open actions on recovery ${boundary}, focused=${focused}`, () => {
      const app = createDashboard();
      const { menu, click } = createMenu(app, { top: 510, bottom: 530, right: 790 });
      const trigger = menu.parentElement.querySelector(".btn-more");
      menu.contains = (element) => menu.children.includes(element);
      trigger.focus = (options) => {
        assert.equal(options.preventScroll, true);
        app.context.document.activeElement = trigger;
      };
      const search = app.elements.get("search");
      const button = app.elements.get("undo-toast-btn");
      button.cloneNode = () => ({ setAttribute() {}, addEventListener() {} });
      button.replaceWith = (next) => app.elements.set("undo-toast-btn", next);
      click();
      app.context.document.activeElement = focused ? menu.children[1] : search;
      if (boundary === "replacement") app.run('showUndoToast("New close completed.")');
      else app.run("undoToastObserver.callback()");
      assert.equal(menu.classList.contains("open"), false);
      assert.equal(app.context.document.activeElement, focused ? trigger : search);
    });
  }
}
