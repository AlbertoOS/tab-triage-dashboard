const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

it("pins the shared Node selector to the declared engine minimum", () => {
  const { engines } = JSON.parse(read("package.json"));
  const minimum = engines.node.match(/^>=(\d+\.\d+\.\d+)\s/);
  assert.ok(minimum, "Declare an explicit minimum Node version");
  assert.equal(read(".node-version").trim(), minimum[1], "Avoid selecting a cached Node release below the engine minimum");
  assert.match(read(".github/workflows/lint.yml"), /^\s+node-version-file: \.node-version\s*$/m);
});
