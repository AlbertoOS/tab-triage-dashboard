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
    offsetHeight: 0,
    dataset: {},
    className: "",
    attributes: {},
    appendChild(child) { this.children.push(child); child.parentElement = this; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(type, callback, options) {
      this.listeners[type] = callback;
      this.listenerOptions ??= {};
      this.listenerOptions[type] = options;
    },
    closest(selector) {
      if (this.className.split(" ").includes(selector.slice(1))) return this;
      return this.parentElement?.closest(selector) ?? null;
    },
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
  const elements = new Map();
  const menus = [];
  const document = Object.assign(createElement(), {
    createElement,
    closest: undefined,
    getElementById: (id) => elements.get(id),
    querySelector: () => createElement(),
    querySelectorAll: (selector) => selector === ".more-menu.open"
      ? menus.filter((menu) => menu.classList.contains("open")) : [],
  });
  const html = fs.readFileSync(path.join(__dirname, "../triage.html"), "utf8");
  for (const [tag, id] of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = createElement();
    for (const [, name, value] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
      element.setAttribute(name, value);
    }
    element.hidden = /\shidden(?:\s|>)/.test(tag);
    elements.set(id, element);
  }
  const context = vm.createContext({
    URL,
    ResizeObserver: class { observe() {} },
    getComputedStyle: () => ({ bottom: "24px", rowGap: "12px" }),
    setTimeout: () => 1,
    clearTimeout() {},
    window: Object.assign(createElement(), { innerWidth: 800, innerHeight: 600 }),
    document,
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
  // Isolate rendering and initial tab I/O, but register real production handlers.
  vm.runInContext("render = () => {}; updateIgnoredPanel = () => {}; loadTabs = async () => {};", context);
  const source = fs.readFileSync(path.join(__dirname, "../triage.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("// --- Event listeners ---")), context);
  return { saved, context, elements, menus, html, run: (code) => vm.runInContext(code, context) };
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
  app.menus.push(menu);
  return { menu, click: () => button.listeners.click({ stopPropagation() {} }) };
}

describe("fixed row menus", () => {
  it("dismisses every open row menu on captured outer scroll, including nested scrollers", () => {
    const app = createDashboard();
    const { document } = app.context;
    const first = createMenu(app, { top: 20, bottom: 40, right: 100 });
    const second = createMenu(app, { top: 60, bottom: 80, right: 100 });
    for (const target of [document, createElement(), app.elements.get("tab-body")]) {
      first.click();
      // Multiple stale menus must all close, not only the first match.
      second.menu.className += " open";
      const capture = document.listenerOptions?.scroll;
      if (capture === true || capture?.capture) document.listeners.scroll({ target, bubbles: false });
      assert.equal(first.menu.classList.contains("open"), false);
      assert.equal(second.menu.classList.contains("open"), false);
    }
  });

  it("preserves scrolling in a menu and its nested contents", () => {
    const app = createDashboard();
    const { menu, click } = createMenu(app, { top: 20, bottom: 40, right: 100 });
    click();
    assert.equal(typeof app.context.document.listeners.scroll, "function");
    for (const target of [menu, menu.children[0]]) {
      app.context.document.listeners.scroll({ target });
      assert.equal(menu.classList.contains("open"), true);
    }
  });

  it("dismisses every open row menu on window resize", () => {
    const app = createDashboard();
    const first = createMenu(app, { top: 20, bottom: 40, right: 100 });
    const second = createMenu(app, { top: 60, bottom: 80, right: 100 });
    first.click();
    second.menu.className += " open";
    app.context.window.listeners.resize?.({ target: app.context.window });
    assert.equal(first.menu.classList.contains("open"), false);
    assert.equal(second.menu.classList.contains("open"), false);
  });

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

describe("fuzzy search accessibility", () => {
  it("initializes the actual HTML toggle as not pressed", () => {
    const app = createDashboard();
    assert.equal(app.run("fuzzySearch"), false);
    assert.equal(app.elements.get("fuzzyToggle").getAttribute("aria-pressed"), "false");
  });

  it("exposes enabled and disabled states through the production click handler", () => {
    const app = createDashboard();
    const button = app.elements.get("fuzzyToggle");
    for (const enabled of [true, false, true]) {
      button.listeners.click();
      assert.equal(app.run("fuzzySearch"), enabled);
      assert.equal(button.getAttribute("aria-pressed"), String(enabled));
      assert.equal(button.classList.contains("active"), enabled);
      assert.equal(app.elements.get("search").placeholder, enabled
        ? "Fuzzy search (match all words in any order)..."
        : "Search tabs (title, URL, domain)...");
    }
  });
});

describe("undo toast accessibility", () => {
  it("keeps a polite status region mounted outside the hidden toast", () => {
    const app = createDashboard();
    const region = app.elements.get("undo-toast-status");
    assert.ok(region, "a persistent status region must exist in the HTML");
    assert.equal(region.getAttribute("role"), "status");
    assert.equal(region.getAttribute("aria-live"), "polite");
    assert.equal(region.hidden, false);
    assert.match(app.html, /<div[^>]*id="undo-toast-status"[^>]*>\s*<div[^>]*id="undo-toast"/);
    assert.equal(app.elements.get("undo-toast").hidden, true);
  });

  it("reveals the undo contents before the real toast handler updates its announcement", () => {
    const app = createDashboard();
    const toast = app.elements.get("undo-toast");
    const button = app.elements.get("undo-toast-btn");
    const messages = [];
    button.cloneNode = () => createElement();
    button.replaceWith = (replacement) => app.elements.set("undo-toast-btn", replacement);
    Object.defineProperty(app.elements.get("undo-toast-msg"), "textContent", {
      set(message) {
        assert.equal(toast.hidden, false, "the message must be exposed before it changes");
        messages.push(message);
      },
    });
    app.run('showUndoToast("Closed example tab. Undo available.", 1)');
    assert.deepEqual(messages, ["Closed example tab. Undo available."]);
    assert.equal(typeof app.elements.get("undo-toast-btn").listeners.click, "function");
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
