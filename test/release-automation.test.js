const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("automatic release recovery exercises passive real archives and fake remote failures", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "test", "-p", "release_publication_test.py", "-v"], {
    cwd: root, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran [1-9][0-9]* tests/);
});

test("release write guards reject every PR, tag and non-main context", () => {
  const text = read(".github/workflows/release.yml");
  const guard = text.match(/^    if: github.ref ==.*$/m)[0].trim().slice(4);
  for (const event of ["push", "workflow_dispatch", "pull_request", "pull_request_target", "release"]) {
    for (const ref of ["refs/heads/main", "refs/heads/topic", "refs/tags/main"]) {
      for (const type of ["branch", "tag"]) {
        const allowed = ref === "refs/heads/main" && type === "branch" && ["push", "workflow_dispatch"].includes(event);
        assert.equal(vm.runInNewContext(guard, { github: { event_name: event, ref, ref_type: type } }), allowed);
      }
    }
  }
  const validation = text.split("  validate:\n")[1].split("\n  publish:\n")[0];
  const publisher = text.split("  publish:\n")[1].split("\n  dispatch-stores:\n")[0];
  const dispatch = text.split("  dispatch-stores:\n")[1];
  assert.match(validation, /contents: read/);
  assert.doesNotMatch(validation, /contents: write|actions: write|secrets\.|id-token:|environment:/);
  assert.match(publisher, /needs: validate/);
  assert.match(publisher, /contents: write/);
  assert.doesNotMatch(publisher, /actions: write|secrets\.|id-token:|environment:|npm ci/);
  assert.match(dispatch, /actions: write/);
  assert.doesNotMatch(dispatch, /contents: write|secrets\.|id-token:|environment:|uses:/);
  assert.match(text, /if: always\(\)/);
  assert.match(text, /cancel-in-progress: false/);
  assert.match(text, /--base refs\/remotes\/origin\/main/);
  assert.match(text, /--pr-title "\$PR_TITLE"/);
  assert.doesNotMatch(text, /run:.*\$\{\{ github\.event\.pull_request\.title/);
});

test("Node setup uses the shared selector when it exists without overriding it", () => {
  const text = read(".github/workflows/release.yml");
  const version = text.match(/node-version: \$\{\{ (.*?) \}\}/)[1];
  const file = text.match(/node-version-file: \$\{\{ (.*?) \}\}/)[1];
  for (const exists of [true, false]) {
    const context = { hashFiles: () => exists ? "fixture-hash" : "" };
    assert.equal(vm.runInNewContext(version, context), exists ? "" : "24");
    assert.equal(vm.runInNewContext(file, context), exists ? ".node-version" : "");
  }
});

test("store coordinator admits published stable events and exact main dispatches only", () => {
  const text = read(".github/workflows/publish-stores.yml");
  const guard = text.match(/^    if: (.+)$/m)[1];
  for (const event of ["release", "workflow_dispatch", "pull_request", "push"]) {
    for (const ref of ["refs/heads/main", "refs/heads/topic", "refs/tags/v1.0.0"]) {
      for (const draft of [true, false]) {
        const context = { github: { event_name: event, ref, ref_type: ref.startsWith("refs/tags/") ? "tag" : "branch", event: { action: "published", release: { draft, prerelease: false } } } };
        assert.equal(vm.runInNewContext(guard, context), event === "release" && !draft || event === "workflow_dispatch" && ref === "refs/heads/main");
      }
    }
  }
  for (const browser of ["firefox", "chrome"]) {
    const workflow = read(`.github/workflows/publish-${browser}.yml`);
    assert.match(workflow, /queue: max/);
    assert.match(workflow, /cancel-in-progress: false/);
  }
});
