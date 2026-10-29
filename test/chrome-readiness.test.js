const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

it("limits Chrome permissions without changing Firefox host access", () => {
  const chrome = JSON.parse(read("manifest.chrome.json"));
  const firefox = JSON.parse(read("manifest.firefox.json"));
  assert.deepEqual(chrome.permissions, ["tabs", "storage", "sessions"]);
  assert.equal(chrome.host_permissions, undefined);
  assert.deepEqual(firefox.host_permissions, ["<all_urls>"]);
});

it("defines every palette variable used by the toast", () => {
  const css = read("triage.css");
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
  for (const [, name] of css.matchAll(/var\((--[\w-]+)\)/g)) {
    assert.ok(defined.has(name), `Undefined CSS variable: ${name}`);
  }
});
