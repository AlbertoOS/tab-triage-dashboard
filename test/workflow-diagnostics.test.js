const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("workflow diagnostics project bounded metadata and tolerate failed sinks", () => {
  // Run only this explicit helper test, not another concurrent suite discovery.
  const result = spawnSync("python3", [
    "-B", path.join(__dirname, "workflow_diagnostics_test.py"), "-v",
  ], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran [1-9][0-9]* tests/);
});
