const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Reuse the DOM/browser boundaries, executing both complete production scripts.
const source = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(source.slice(0, source.indexOf("for (const [selector, type]")) + ";dashboard", {
  require, __dirname, URL, setImmediate,
});
const tab = (id, host, windowId = 1) => ({ id, windowId, title: `Tab ${id}`, url: `https://${host}/page-${id}` });
async function fixture(tabs = [tab(1, "alpha.example"), tab(2, "beta.example"), tab(3, "alpha.example", 2), tab(4, "sub.alpha.example")]) {
  const writes = [];
  const app = dashboard((message) => {
    assert.equal(message.type, "getTabs", "filtering must not issue tab commands");
    return { ok: true, tabs };
  }, { set: async (value) => writes.push(value) });
  await app.settle();
  return { ...app, writes };
}
function row(app, id) {
  return app.get("tab-body").children.find((entry) => entry.dataset.tabId === String(id));
}
function visible(app) {
  return Array.from(app.get("tab-body").children).filter((entry) => entry.dataset.tabId !== undefined)
    .map((entry) => Number(entry.dataset.tabId)).sort((a, b) => a - b);
}
function selected(app) {
  return Array.from(app.run("getSelectedDomains()"));
}

it("row Filter domain selects only its domain across windows without tab or preference mutations", async () => {
  const app = await fixture();
  const queriesBefore = app.messages.length;
  const button = row(app, 1).querySelector(".btn-filter-domain");
  assert.ok(button, "the row's existing More actions menu exposes Filter domain");
  assert.equal(button.textContent, "Filter alpha.example");
  let stopped = false;
  button.focus();
  button.listeners.click({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(selected(app), ["alpha.example"]);
  assert.deepEqual(visible(app), [1, 3]);
  assert.equal(app.get("domainDropdownBtn").textContent, "alpha.example");
  assert.equal(app.run("document.activeElement") === app.get("domainDropdownBtn"), true);
  assert.equal(app.messages.length, queriesBefore);
  assert.equal(app.writes.length, 0);
});

it("replaces a domain multiselection while preserving search, age, status, sorting and ignore state", async () => {
  const now = Date.now();
  const app = await fixture([
    { ...tab(1, "alpha.example"), pinned: true, lastAccessed: now },
    { ...tab(2, "beta.example"), pinned: true, lastAccessed: now },
    { ...tab(3, "alpha.example"), lastAccessed: now },
    { ...tab(4, "alpha.example"), pinned: true, lastAccessed: 1 },
  ]);
  app.run(`
    const originalQuery = document.querySelectorAll;
    const ageControl = { value: "1h", checked: true };
    const statusControl = { dataset: { status: "pinned", state: "include" } };
    document.querySelectorAll = (selector) => {
      if (selector === 'input[name="filterAge"]:checked') return [ageControl];
      if (selector === ".status-toggle") return [statusControl];
      return originalQuery(selector);
    };
    document.querySelectorAll('input[name="filterDomain"]').forEach((input) => { input.checked = true; });
    currentSort = [{ key: "title", dir: "asc" }];
    collapsedGroups.add("beta.example");
    showIgnored = true;
    ignoredDomains.add("untouched.example");
    ignoredDomains.add("alpha.example");
    ignoredDomains.add("beta.example");
  `);
  app.get("search").value = "Tab";
  app.run("render()");
  assert.deepEqual(visible(app), [1, 2]);
  row(app, 1).querySelector(".btn-filter-domain").listeners.click({ stopPropagation() {} });
  assert.deepEqual(selected(app), ["alpha.example"]);
  assert.deepEqual(visible(app), [1]);
  assert.equal(app.get("search").value, "Tab");
  assert.equal(app.run("ageControl.checked"), true);
  assert.equal(app.run("statusControl.dataset.state"), "include");
  assert.equal(app.run("JSON.stringify(currentSort)"), '[{"key":"title","dir":"asc"}]');
  assert.equal(app.run('collapsedGroups.has("beta.example") && showIgnored && ignoredDomains.has("untouched.example")'), true);
  assert.equal(app.writes.length, 0);
});

it("retains the chosen domain through refresh and clears it using the existing None control", async () => {
  const app = await fixture();
  row(app, 1).querySelector(".btn-filter-domain").listeners.click({ stopPropagation() {} });
  await app.get("refresh").listeners.click();
  assert.deepEqual(selected(app), ["alpha.example"]);
  assert.deepEqual(visible(app), [1, 3]);
  app.get("domainSelectNone").listeners.click();
  assert.deepEqual(selected(app), []);
  assert.deepEqual(visible(app), [1, 2, 3, 4]);
  assert.equal(app.get("domainDropdownBtn").textContent, "All domains (3)");
});

it("uses the existing www normalization but does not broaden to subdomains", async () => {
  const app = await fixture([tab(1, "www.alpha.example"), tab(2, "alpha.example"), tab(3, "sub.alpha.example")]);
  const button = row(app, 1).querySelector(".btn-filter-domain");
  assert.equal(button.textContent, "Filter alpha.example");
  button.listeners.click({ stopPropagation() {} });
  assert.deepEqual(selected(app), ["alpha.example"]);
  assert.deepEqual(visible(app), [1, 2]);
});

it("disables filtering for tabs without a hostname instead of silently clearing a selection", async () => {
  const app = await fixture([{ id: 1, windowId: 1, title: "Internal", url: "about:blank" }, tab(2, "alpha.example")]);
  const button = row(app, 1).querySelector(".btn-filter-domain");
  assert.equal(button.textContent, "Filter domain");
  assert.equal(button.disabled, true);
  app.run('document.querySelectorAll(\'input[name="filterDomain"]\').forEach((input) => { input.checked = true; })');
  button.listeners.click({ stopPropagation() {} });
  assert.deepEqual(selected(app), ["alpha.example"]);
  assert.equal(app.writes.length, 0);
});

for (const domain of ["__proto__", "constructor"]) {
  it(`filters ${domain} with accurate option and row counts`, async () => {
    const app = await fixture([tab(1, domain), tab(2, domain, 2), tab(3, "other.example")]);
    row(app, 1).querySelector(".btn-filter-domain").listeners.click({ stopPropagation() {} });
    assert.deepEqual(selected(app), [domain]);
    assert.deepEqual(visible(app), [1, 2]);
    const option = app.get("domainList").children.find((label) => label.querySelector("input").value === domain);
    assert.equal(option.querySelector(".domain-item-count").textContent, "2");
    assert.deepEqual(Array.from(app.run("enrichedTabs.map((tab) => tab.domainCount)")), [2, 2, 1]);
    await app.get("refresh").listeners.click();
    assert.deepEqual(selected(app), [domain]);
    assert.deepEqual(visible(app), [1, 2]);
  });
}

it("keeps existing choices when a stale action has no matching domain option", async () => {
  const app = await fixture();
  const button = row(app, 1).querySelector(".btn-filter-domain");
  const list = app.get("domainList");
  list.children = list.children.filter((label) => label.querySelector("input").value !== "alpha.example");
  list.children.forEach((label) => { label.querySelector("input").checked = true; });
  const before = selected(app);
  button.listeners.click({ stopPropagation() {} });
  assert.deepEqual(selected(app), before);
  assert.equal(app.writes.length, 0);
});
