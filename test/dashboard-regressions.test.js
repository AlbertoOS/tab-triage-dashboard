const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function createElement() {
  const element = {
    children: [],
    listeners: {},
    style: {},
    dataset: {},
    className: "",
    appendChild(child) { this.children.push(child); },
    setAttribute() {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    querySelector(selector) {
      for (const child of this.children) {
        if (child.className.split(" ").includes(selector.slice(1))) return child;
        const match = child.querySelector(selector);
        if (match) return match;
      }
      return null;
    },
  };
  element.classList = {
    contains: (name) => element.className.split(" ").includes(name),
    remove(name) { element.className = element.className.split(" ").filter((item) => item !== name).join(" "); },
    toggle(name) {
      if (this.contains(name)) this.remove(name);
      else element.className += ` ${name}`;
      return this.contains(name);
    },
  };
  return element;
}

function createDashboard(saved = {}) {
  const context = vm.createContext({
    URL,
    window: { innerWidth: 800, innerHeight: 600 },
    document: { createElement, querySelectorAll: () => [] },
    browser: {
      runtime: { getURL: () => "moz-extension://test/triage.html" },
      storage: {
        local: {
          get: async () => saved,
          set: async (value) => { Object.assign(saved, value); },
        },
      },
    },
  });
  for (const file of ["utils.js", "triage.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    vm.runInContext(source.split("// --- Event listeners ---")[0], context);
  }
  // Ignore-list tests isolate unrelated rendering, not persistence or matching.
  vm.runInContext("render = () => {}; updateIgnoredPanel = () => {};", context);
  return { saved, context, run: (code) => vm.runInContext(code, context) };
}

function createMenu(app, rect, size = { width: 160, height: 100 }) {
  const row = app.run('createTabRow({ id: 1, url: "https://example.com", statusList: [] })');
  const button = row.querySelector(".btn-more");
  const menu = row.querySelector(".more-menu");
  button.getBoundingClientRect = () => rect;
  // Supply layout measurements only; positioning runs in the production handler.
  menu.getBoundingClientRect = () => {
    assert.equal(menu.classList.contains("open"), true, "measure the visible menu");
    return {
      width: Math.min(size.width, parseFloat(menu.style.maxWidth) || Infinity),
      height: Math.min(size.height, parseFloat(menu.style.maxHeight) || Infinity),
    };
  };
  return { menu, click: () => button.listeners.click({ stopPropagation() {} }) };
}

describe("fixed row menus", () => {
  it("constrains oversized menus to the viewport with scrollable contents", () => {
    const app = createDashboard();
    const { menu, click } = createMenu(app,
      { top: 20, bottom: 40, right: 100 }, { width: 1000, height: 900 });
    app.context.window.innerWidth = 120;
    app.context.window.innerHeight = 90;
    click();
    assert.equal(menu.style.maxWidth, "104px");
    assert.equal(menu.style.maxHeight, "74px");
    assert.equal(menu.style.minWidth, "0px");
    assert.equal(menu.style.overflow, "auto");
    assert.equal(menu.style.left, "8px");
    assert.equal(menu.style.top, "8px");
    click();
    app.context.window.innerWidth = 1200;
    app.context.window.innerHeight = 1100;
    click();
    assert.equal(menu.style.maxWidth, "1184px");
    assert.equal(menu.style.maxHeight, "1084px");
    assert.equal(menu.style.top, "44px");
  });

  it("flips above the bottom row and clamps both horizontal viewport edges", () => {
    const app = createDashboard();
    for (const [rect, expectedLeft] of [
      [{ top: 560, bottom: 590, right: 790 }, 630],
      [{ top: 560, bottom: 590, right: 70 }, 8],
      [{ top: 560, bottom: 590, right: 900 }, 632],
    ]) {
      const { menu, click } = createMenu(app, rect);
      click();
      assert.equal(menu.style.top, "456px");
      assert.equal(menu.style.left, `${expectedLeft}px`);
      assert.ok(!menu.style.transform || menu.style.transform === "none");
      assert.equal(menu.classList.contains("open"), true);
      click();
      assert.equal(menu.classList.contains("open"), false);
    }
  });
});

describe("persisted URL ignores", () => {
  it("saves legacy keys, reloads across fragments and removes the persisted key", async () => {
    const app = createDashboard();
    for (const url of [
      "https://example.com/path/?q=1#one/",
      "https://example.com/path/?q=1#two",
      "https://example.com/query?q=/#route",
      "https://example.com/plain///#route",
      "not-a-url",
      "",
    ]) {
      app.context.url = url;
      await app.run("ignoreUrl(url)");
    }
    assert.deepEqual(Array.from(app.saved.ignoredUrls), [
      "https://example.com/path/?q=1",
      "https://example.com/query?q=",
      "https://example.com/plain",
      "not-a-url",
    ]);
    await app.run("ignoredUrls.clear(); loadIgnoreLists()");
    assert.equal(app.run('isIgnored({ url: "https://example.com/path/?q=1#three" })'), true);
    await app.run('unignoreUrl("https://example.com/path/?q=1")');
    assert.equal(app.run('isIgnored({ url: "https://example.com/path/?q=1#three" })'), false);
    assert.equal(app.saved.ignoredUrls.includes("https://example.com/path/?q=1"), false);
  });

  it("matches legacy keys across fragments without changing their query/path semantics", async () => {
    const app = createDashboard({
      ignoredUrls: ["https://example.com/path/?q=1", "https://example.com/query?q=", "https://example.com/plain"],
      ignoredDomains: ["ignored.example"],
    });
    await app.run("loadIgnoreLists()");
    for (const url of [
      "https://example.com/path/?q=1#one",
      "https://example.com/path/?q=1#two/",
      "https://example.com/query?q=/#route",
      "https://example.com/plain///#route",
    ]) {
      app.context.tab = { url, domain: "example.com" };
      assert.equal(app.run("isIgnored(tab)"), true, url);
    }
    app.context.tab = { url: "https://example.com/path?q=1#one", domain: "example.com" };
    assert.equal(app.run("isIgnored(tab)"), false);
    assert.equal(app.run('isIgnored({ domain: "ignored.example" })'), true);
    assert.equal(app.saved.ignoredUrls.length, 3);
  });
});
