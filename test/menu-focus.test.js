const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Reuse the dashboard fixture, retaining production scroll/resize handlers.
const fixtureSource = fs.readFileSync(path.join(__dirname, "dashboard-regressions.test.js"), "utf8");
const { createDashboard, createMenu } = vm.runInNewContext(
  fixtureSource.slice(0, fixtureSource.indexOf('describe("fixed row menus"'))
    + ";({ createDashboard, createMenu })",
  { require, __dirname, URL },
);

it("keeps keyboard focus distinct on the enabled fuzzy toggle", () => {
  const css = fs.readFileSync(path.join(__dirname, "../triage.css"), "utf8");
  const rule = css.match(/#fuzzyToggle:focus-visible\s*\{([^}]+)\}/);
  assert.ok(rule, "Fuzzy toggle needs a visible keyboard focus rule");
  assert.match(rule[1], /outline:\s*2px solid #8aadf4/);
  assert.match(rule[1], /outline-offset:\s*2px/);
});

for (const dismissal of ["scroll", "resize"]) {
  it(`returns focus to More when ${dismissal} hides the focused action`, () => {
    const app = createDashboard();
    const { menu, click } = createMenu(app, { top: 20, bottom: 40, right: 100 });
    const trigger = menu.parentElement.querySelector(".btn-more");
    menu.contains = (element) => menu.children.includes(element);
    const focusCalls = [];
    trigger.focus = (options) => {
      focusCalls.push(options);
      app.context.document.activeElement = trigger;
    };
    click();
    app.context.document.activeElement = menu.children[0];
    if (dismissal === "scroll") {
      app.context.document.listeners.scroll({ target: app.context.document });
    } else {
      app.context.window.listeners.resize();
    }
    assert.equal(menu.classList.contains("open"), false);
    assert.equal(app.context.document.activeElement, trigger);
    assert.equal(focusCalls.length, 1);
    assert.equal(focusCalls[0].preventScroll, true);
  });
}

it("does not steal unrelated focus when dismissing a row menu", () => {
  const app = createDashboard();
  const { menu, click } = createMenu(app, { top: 20, bottom: 40, right: 100 });
  menu.contains = (element) => menu.children.includes(element);
  const trigger = menu.parentElement.querySelector(".btn-more");
  trigger.focus = () => assert.fail("unrelated focus must not move");
  click();
  const search = app.elements.get("search");
  app.context.document.activeElement = search;
  app.context.window.listeners.resize();
  assert.equal(app.context.document.activeElement, search);
  assert.equal(menu.classList.contains("open"), false);
});
