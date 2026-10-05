const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const dashboardUrl = "moz-extension://test/triage.html";

function createElement() {
  return {
    children: [],
    listeners: {},
    className: "",
    dataset: {},
    classList: { toggle() {}, remove() {}, add() {} },
    appendChild(child) { this.children.push(child); },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute() {},
    remove() {},
    querySelector(selector) {
      const className = selector.slice(1);
      for (const child of this.children) {
        if (child.className === className) return child;
        const match = child.querySelector(selector);
        if (match) return match;
      }
      return null;
    },
    set innerHTML(value) { this.children = []; },
  };
}

function createDashboard(tabs) {
  const elements = new Map();
  const messages = [];
  const downloads = [];
  const blobs = [];
  const cleanupCallbacks = [];
  const revokedUrls = [];
  const context = vm.createContext({
    Blob,
    URL: {
      createObjectURL(blob) {
        blobs.push(blob);
        return `blob:test/${blobs.length}`;
      },
      revokeObjectURL(url) { revokedUrls.push(url); },
    },
    setTimeout(callback) { cleanupCallbacks.push(callback); },
    browser: {
      runtime: {
        getURL: () => dashboardUrl,
        sendMessage: async (message) => {
          messages.push(message);
          return { ok: true };
        },
      },
    },
    document: {
      body: createElement(),
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, createElement());
        return elements.get(id);
      },
      createElement: (tag) => {
        const element = createElement();
        if (tag === "a") element.click = () => downloads.push({ href: element.href, filename: element.download });
        return element;
      },
      querySelectorAll: () => [],
    },
    fixtureTabs: tabs.map((tab) => ({
      title: "Example",
      url: "https://example.com",
      domain: "example.com",
      statusList: [],
      ...tab,
    })),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../utils.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(__dirname, "../triage.js"), "utf8");
  vm.runInContext(source.split("// --- Event listeners ---")[0], context);
  vm.runInContext(`
    enrichedTabs = fixtureTabs;
    getFilteredTabs = () => fixtureTabs;
    loadTabs = async () => {};
    document.getElementById("groupBy").value = "none";
  `, context);
  return {
    context, elements, messages, downloads, blobs, cleanupCallbacks, revokedUrls,
    run: (code) => vm.runInContext(code, context),
  };
}

describe("link export", () => {
  it("exports selected links in sort order, preserves duplicates and selection", async () => {
    const app = createDashboard([
      { id: 1, title: "Z", url: "https://example.com/z" },
      { id: 2, title: "A", url: "https://example.com/a?q=%C3%A9#section" },
      { id: 3, title: "B", url: "https://example.com/a?q=%C3%A9#section" },
      { id: 4, title: "Not selected" },
    ]);
    app.run(`selectedTabIds = new Set([1, 2, 3]);
      currentSort = [{ key: "title", dir: "asc" }]; exportLinks(true);`);
    assert.equal(await app.blobs[0].text(),
      "https://example.com/a?q=%C3%A9#section\nhttps://example.com/a?q=%C3%A9#section\nhttps://example.com/z\n");
    assert.equal(app.blobs[0].type, "text/plain;charset=utf-8");
    assert.equal(app.downloads[0].filename, "tab-links-selected.txt");
    assert.deepEqual(Array.from(app.run("selectedTabIds")), [1, 2, 3]);
    assert.equal(app.messages.length, 0);
    assert.equal(app.revokedUrls.length, 0);
    app.cleanupCallbacks[0]();
    assert.deepEqual(app.revokedUrls, [app.downloads[0].href]);
  });

  it("exports all open links regardless of filters, excluding dashboards and empty URLs", async () => {
    const app = createDashboard([
      { id: 1, url: "https://visible.com" },
      { id: 2, url: "https://hidden.com" },
      { id: 3, url: `${dashboardUrl}#top` },
      { id: 4, url: "" },
      { id: 5, url: undefined },
    ]);
    app.run("fixtureTabs = fixtureTabs.slice(0, 1); exportLinks(false);");
    assert.equal(await app.blobs[0].text(), "https://visible.com\nhttps://hidden.com\n");
    assert.equal(app.downloads[0].filename, "tab-links-all.txt");
  });

  it("does not export hidden selections or create an empty download", () => {
    const app = createDashboard([{ id: 1 }, { id: 2 }]);
    app.run("selectedTabIds.add(2); fixtureTabs = fixtureTabs.slice(0, 1); exportLinks(true);");
    assert.equal(app.downloads.length, 0);
    assert.equal(app.elements.get("exportSelected").disabled, true);
    assert.equal(app.elements.get("exportAll").disabled, false);
    assert.equal(app.elements.get("exportStatus").textContent, "No links to export.");
  });

  it("reports download preparation errors without changing the selection", () => {
    const app = createDashboard([{ id: 1 }]);
    app.run(`selectedTabIds.add(1);
      URL.createObjectURL = () => { throw new Error("Download unavailable"); };
      exportLinks(true);`);
    assert.match(app.elements.get("exportStatus").textContent, /Download unavailable/);
    assert.deepEqual(Array.from(app.run("selectedTabIds")), [1]);
    assert.equal(app.downloads.length, 0);
  });
});

describe("bulk tab selection", () => {
  it("selects every filtered tab in collapsed groups and excludes dashboards", () => {
    const app = createDashboard([{ id: 1 }, { id: 2 }, { id: 3, url: `${dashboardUrl}#top` }]);
    app.run(`document.getElementById("groupBy").value = "domain";
      collapsedGroups.add("example.com"); selectFilteredTabs(true);`);
    assert.deepEqual(Array.from(app.run("selectedTabIds")), [1, 2]);
    assert.equal(app.elements.get("selectAllTabs").checked, true);
    assert.equal(app.elements.get("tab-body").children.length, 1);
    assert.equal(app.elements.get("tab-body").children[0].children[0].colSpan, 10);
  });

  it("keeps selection through sorting, removes hidden tabs and does not select new results", () => {
    const app = createDashboard([{ id: 1 }, { id: 2 }]);
    app.run("selectFilteredTabs(true); currentSort = [{ key: 'id', dir: 'desc' }]; render();");
    assert.deepEqual(Array.from(app.run("selectedTabIds")), [1, 2]);
    app.run("fixtureTabs = fixtureTabs.filter((tab) => tab.id === 2); render();");
    assert.deepEqual(Array.from(app.run("selectedTabIds")), [2]);
    app.run("fixtureTabs.push({ ...fixtureTabs[0], id: 4 }); render();");
    assert.equal(app.elements.get("selectAllTabs").indeterminate, true);
    app.run("selectFilteredTabs(false);");
    assert.equal(app.elements.get("closeSelected").disabled, true);
  });

  it("supports individual row selection and partial header state", () => {
    const app = createDashboard([{ id: 1 }, { id: 2 }]);
    app.run("render();");
    const checkbox = app.elements.get("tab-body").children[0].children[0].children[0];
    checkbox.checked = true;
    checkbox.listeners.change();
    assert.deepEqual(Array.from(app.run("selectedTabIds")), [1]);
    assert.equal(app.elements.get("selectAllTabs").indeterminate, true);
    assert.equal(app.elements.get("closeSelected").textContent, "Close selected (1)");
  });

  it("sends one batch, prevents overlapping requests and clears selection on success", async () => {
    const app = createDashboard(Array.from({ length: 1200 }, (_, id) => ({ id })));
    app.run("selectFilteredTabs(true);");
    await app.run("Promise.all([closeSelectedTabs(), closeSelectedTabs()])");
    assert.equal(app.messages.length, 1);
    assert.equal(app.messages[0].type, "closeTabs");
    assert.equal(app.messages[0].tabIds.length, 1200);
    assert.equal(app.run("selectedTabIds.size"), 0);
    assert.equal(app.elements.get("closeSelected").disabled, true);
  });

  it("refreshes after failure, retains surviving selection and allows retry", async () => {
    const app = createDashboard([{ id: 1 }, { id: 2 }]);
    app.run(`selectFilteredTabs(true);
      api.runtime.sendMessage = async () => ({ ok: false, error: "Tab unavailable" });
      loadTabs = async () => { fixtureTabs = fixtureTabs.filter((tab) => tab.id === 2); };
    `);
    await app.run("closeSelectedTabs()");
    assert.deepEqual(Array.from(app.run("selectedTabIds")), [2]);
    assert.match(app.elements.get("bulkError").textContent, /Tab unavailable/);
    assert.equal(app.elements.get("closeSelected").disabled, false);
    assert.equal(app.run("closingSelected"), false);
  });
});

async function closeInBackground(tabs, tabIds, remove) {
  let listener;
  const context = vm.createContext({
    browser: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        getURL: () => dashboardUrl,
        onMessage: { addListener(callback) { listener = callback; } },
      },
      tabs: { query: async () => tabs, remove },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  return new Promise((resolve) => {
    assert.equal(listener({ type: "closeTabs", tabIds }, {}, resolve), true);
  });
}

describe("background bulk closing", () => {
  it("closes only requested live tabs and protects dashboards", async () => {
    const removed = [];
    const response = await closeInBackground([
      { id: 1, url: "https://example.com" },
      { id: 2, url: `${dashboardUrl}?view=all` },
      { id: 3, url: "https://other.com" },
    ], [1, 2, 4, 1], async (ids) => removed.push(...ids));
    assert.deepEqual(removed, [1]);
    assert.equal(response.ok, true);
  });

  it("succeeds when all requested tabs are already closed", async () => {
    const response = await closeInBackground([], [1], async () => assert.fail("Unexpected removal"));
    assert.equal(response.ok, true);
  });

  it("returns removal errors to the dashboard", async () => {
    const response = await closeInBackground([{ id: 1 }], [1], async () => {
      throw new Error("Removal failed");
    });
    assert.equal(response.ok, false);
    assert.equal(response.error, "Removal failed");
  });
});
