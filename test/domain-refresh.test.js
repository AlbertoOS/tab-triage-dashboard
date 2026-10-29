const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(source.slice(0, source.indexOf("for (const [selector, type]")) + ";dashboard", { require, __dirname, URL, setImmediate });

it("retains only surviving checked domains through production refresh and filters rendered results", async () => {
  const tab = (id, domain) => ({ id, title: domain, url: `https://${domain}/${id}` });
  let tabs = [tab(1, "keep.test"), tab(2, "remove.test"), tab(3, "unchecked.test")];
  const app = dashboard((message) => {
    assert.equal(message.type, "getTabs");
    return { ok: true, tabs };
  });
  const inputs = () => Array.from(app.get("domainList").children, (label) => label.querySelector("input"));
  const selected = () => inputs().filter((input) => input.checked).map((input) => input.value).sort();
  const resultIds = () => Array.from(app.run("getFilteredTabs().map((tab) => tab.id)"));
  await app.settle();
  assert.equal(inputs().length, 3, "initial load must actually populate domain controls");
  assert.deepEqual(selected(), []);
  assert.deepEqual(resultIds(), [1, 2, 3]);
  assert.equal(app.get("tab-body").children.length, 3);
  assert.equal(app.get("domainDropdownBtn").textContent, "All domains (3)");
  const oldInputs = inputs();
  for (const input of inputs()) {
    if (input.value !== "unchecked.test") {
      input.checked = true;
      input.listeners.change();
    }
  }
  assert.deepEqual(selected(), ["keep.test", "remove.test"]);
  assert.deepEqual(Array.from(app.run("getSelectedDomains()")).sort(), selected(), "checked DOM query cannot be a vacuous mock");
  assert.deepEqual(resultIds(), [1, 2]);
  assert.equal(app.get("tab-body").children.length, 2);
  tabs = [tab(1, "keep.test"), tab(3, "unchecked.test"), tab(4, "new.test"), tab(5, "keep.test")];
  await app.get("refresh").listeners.click();
  assert.equal(app.messages.length, 2, "refresh must fetch new browser state");
  assert.ok(inputs().every((input) => !oldInputs.includes(input)), "refresh really rebuilt controls");
  assert.deepEqual(inputs().map((input) => input.value).sort(), ["keep.test", "new.test", "unchecked.test"]);
  assert.deepEqual(selected(), ["keep.test"]);
  assert.deepEqual(resultIds(), [1, 5]);
  assert.equal(app.get("tab-body").children.length, 2);
  assert.equal(app.get("domainDropdownBtn").textContent, "keep.test");
  tabs = [tab(3, "unchecked.test"), tab(4, "new.test")];
  await app.get("refresh").listeners.click();
  assert.deepEqual(selected(), []);
  assert.deepEqual(resultIds(), [3, 4], "no remaining selection means all domains, as initially");
  tabs.push(tab(6, "keep.test"));
  await app.get("refresh").listeners.click();
  assert.deepEqual(selected(), [], "removed selections must not resurrect when a domain returns");
  assert.deepEqual(resultIds(), [3, 4, 6]);
});
