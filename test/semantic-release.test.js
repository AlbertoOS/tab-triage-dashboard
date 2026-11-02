const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("offline semantic release planner integration suite", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "test", "-p", "release_plan_test.py", "-v"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran [1-9][0-9]* tests/);
});
