const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts/bootstrap_firefox.py");
const workflowPath = ".github/workflows/bootstrap-firefox.yml";
const release = {
  id: 1, draft: false, prerelease: false, tag_name: "v1.4.0",
  published_at: "2026-01-01T00:00:00Z",
};

function fixture(t, { existing = false, publisher = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "firefox-bootstrap-"));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GH_TOKEN: "synthetic-opaque-token",
  };
  function git(...args) {
    const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function put(name, content) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  function commit() {
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  }
  git("init", "-q", "-b", "main");
  put("seed", "fixture\n");
  if (existing) put(workflowPath, "name: before\n");
  const before = commit();
  put(workflowPath, "name: after\n");
  if (publisher) put(".github/workflows/publish-firefox.yml", "name: publisher\n");
  const after = commit();
  put("release.json", JSON.stringify(release));
  put("bin/gh", `#!/usr/bin/env python3
import json, os, pathlib, sys
p = pathlib.Path(os.environ["HOME"])
with (p / "calls.jsonl").open("a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "stdin": sys.stdin.read()}) + "\\n")
is_dispatch = "POST" in sys.argv
if os.environ.get("FAKE_FAIL") == ("dispatch" if is_dispatch else "api"):
    print("::error::synthetic-opaque-token provider detail", file=sys.stderr)
    print("synthetic-opaque-token raw output")
    sys.exit(1)
if not is_dispatch:
    print((p / "release.json").read_text())
`);
  fs.chmodSync(path.join(dir, "bin/gh"), 0o700);
  Object.assign(env, {
    PATH: `${path.join(dir, "bin")}:${env.PATH}`,
    GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REF_TYPE: "branch",
    GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "fixture-owner/fixture-repo",
    GITHUB_SHA: after, BOOTSTRAP_BEFORE: before, BOOTSTRAP_AFTER: after,
  });
  function run(overrides = {}) {
    return spawnSync("python3", ["-B", script], {
      cwd: dir, env: { ...env, ...overrides }, encoding: "utf8", timeout: 10000,
    });
  }
  function calls() {
    const log = path.join(dir, "calls.jsonl");
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  }
  return { dir, env, git, put, commit, run, calls, before, after };
}

test("first introduction dispatches the latest stable release to Firefox only", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [
    { argv: ["api", "--method", "GET", "repos/fixture-owner/fixture-repo/releases/latest"], stdin: "" },
    {
      argv: ["api", "--method", "POST", "repos/fixture-owner/fixture-repo/actions/workflows/publish-firefox.yml/dispatches", "--input", "-"],
      stdin: JSON.stringify({ ref: "main", inputs: { "release-tag": "v1.4.0", operation: "publish" } }),
    },
  ]);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-opaque-token/);
});

test("later workflow edits skip without calling GitHub", (t) => {
  const f = fixture(t, { existing: true });
  assert.equal(f.run().status, 0);
  assert.deepEqual(f.calls(), []);
});

test("workflow reruns skip without calling GitHub", (t) => {
  const f = fixture(t);
  assert.equal(f.run({ GITHUB_RUN_ATTEMPT: "2" }).status, 0);
  assert.deepEqual(f.calls(), []);
});

test("invalid source context is rejected before GitHub I/O", (t) => {
  const f = fixture(t);
  for (const overrides of [
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REF: "refs/heads/topic" },
    { GITHUB_REF_TYPE: "tag" }, { GITHUB_REPOSITORY: "owner/repo/extra" },
    { GITHUB_REPOSITORY: "--inject/repo" }, { GITHUB_REPOSITORY: "owner/repo\n::error::payload" },
    ...["", "0", "-1", "01", "1.0", "abc"].map((value) => ({ GITHUB_RUN_ATTEMPT: value })),
    { BOOTSTRAP_BEFORE: "" }, { BOOTSTRAP_BEFORE: "0".repeat(40) },
    { BOOTSTRAP_BEFORE: "HEAD" }, { BOOTSTRAP_AFTER: "HEAD" }, { GITHUB_SHA: "HEAD" },
    { BOOTSTRAP_AFTER: f.before },
  ]) {
    const result = f.run(overrides);
    assert.equal(result.status, 1, JSON.stringify(overrides));
    assert.doesNotMatch(result.stdout + result.stderr, /Traceback|payload|synthetic-opaque-token/);
    assert.deepEqual(f.calls(), []);
  }
});

test("checkout admission rejects unavailable commits and mismatched HEAD", (t) => {
  const f = fixture(t);
  for (const overrides of [
    { BOOTSTRAP_BEFORE: "f".repeat(40) },
    { BOOTSTRAP_BEFORE: f.git("rev-parse", `${f.before}^{tree}`) },
    { BOOTSTRAP_AFTER: f.before, GITHUB_SHA: f.before },
  ]) {
    const result = f.run(overrides);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /Traceback|fatal:|f{40}/);
    assert.deepEqual(f.calls(), []);
  }
});

test("introduction requires a regular tracked bootstrap file after the push", (t) => {
  for (const kind of ["absent", "symlink", "directory"]) {
    const f = fixture(t);
    fs.rmSync(path.join(f.dir, workflowPath));
    if (kind === "symlink") fs.symlinkSync("../../seed", path.join(f.dir, workflowPath));
    if (kind === "directory") f.put(`${workflowPath}/child`, "fixture");
    const after = f.commit();
    const result = f.run({ BOOTSTRAP_AFTER: after, GITHUB_SHA: after });
    assert.equal(result.status, 1, kind);
    assert.deepEqual(f.calls(), []);
  }
});

test("publisher prerequisite must exist in the checked-out tree", (t) => {
  for (const kind of ["absent", "symlink", "untracked", "deleted"]) {
    const f = fixture(t, { publisher: false });
    const name = ".github/workflows/publish-firefox.yml";
    if (kind === "symlink") fs.symlinkSync("../../seed", path.join(f.dir, name));
    if (kind === "untracked" || kind === "deleted") f.put(name, "name: fixture");
    let after = f.after;
    if (kind === "symlink" || kind === "deleted") after = f.commit();
    if (kind === "deleted") fs.rmSync(path.join(f.dir, name));
    const result = f.run({ BOOTSTRAP_AFTER: after, GITHUB_SHA: after });
    assert.equal(result.status, 1, kind);
    assert.deepEqual(f.calls(), []);
  }
});

test("latest release metadata must be a published stable semantic version", (t) => {
  const f = fixture(t);
  for (const metadata of [
    {}, [], null,
    ...[true, "false", 0, null].map((draft) => ({ ...release, draft })),
    ...[true, "false", 0, null].map((prerelease) => ({ ...release, prerelease })),
    ...[null, "", "not-a-date", "2026-02-30T00:00:00Z"].map((published_at) => ({ ...release, published_at })),
    ...["--help", "v1.4.0\n::error::payload", "v01.4.0", "v1.4.0-rc.1", "v1.4.0+build", "1.4.0", 140].map((tag_name) => ({ ...release, tag_name })),
  ]) {
    f.put("release.json", JSON.stringify(metadata));
    const result = f.run();
    assert.equal(result.status, 1, JSON.stringify(metadata));
    assert.doesNotMatch(result.stdout + result.stderr, /Traceback|payload|synthetic-opaque-token/);
  }
  assert.ok(f.calls().every((call) => !call.argv.includes("POST")));
});

test("provider failures are sanitized and dispatch failure is uncertain", (t) => {
  for (const stage of ["api", "dispatch"]) {
    const f = fixture(t);
    const result = f.run({ FAKE_FAIL: stage });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /Traceback|synthetic-opaque-token|provider detail|raw output/);
    assert.equal(f.calls().length, stage === "api" ? 1 : 2);
    if (stage === "dispatch") assert.match(result.stdout, /uncertain.*inspect.*runs.*manual retry/i);
  }
});

test("bounded subprocess timeouts are sanitized through the actual main boundary", (t) => {
  const cases = ["api", "dispatch", "git"].flatMap((stage) => ["timeout", "oserror"].map((failure) => [stage, failure]));
  for (const [stage, failure] of cases) {
    const f = fixture(t);
    const probe = `import importlib.util, subprocess, sys
spec = importlib.util.spec_from_file_location("bootstrap", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
real = m.subprocess.run
calls = []
def boundary(argv, **kwargs):
    assert kwargs.get("timeout") == 30
    assert kwargs.get("capture_output") is True
    assert kwargs.get("check") is True
    if argv[0] == "gh":
        calls.append(argv)
    matches = (argv[0] == "git" if sys.argv[2] == "git" else
               argv[0] == "gh" and ("POST" in argv) == (sys.argv[2] == "dispatch"))
    if matches:
        if sys.argv[3] == "oserror":
            raise OSError("synthetic-opaque-token provider detail")
        raise subprocess.TimeoutExpired("synthetic-opaque-token", 30,
                                        output="provider detail", stderr="::error::payload")
    return real(argv, **kwargs)
m.subprocess.run = boundary
status = m.main()
assert len(calls) == {"git": 0, "api": 1, "dispatch": 2}[sys.argv[2]]
sys.exit(status)
`;
    const result = spawnSync("python3", ["-B", "-c", probe, script, stage, failure], {
      cwd: f.dir, env: f.env, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /Traceback|synthetic-opaque-token|provider detail|payload/);
    if (stage === "dispatch") assert.match(result.stdout, /uncertain.*inspect.*runs.*manual retry/i);
  }
});

test("actual bootstrap YAML wires only a first-attempt main push with minimal authority", () => {
  const file = path.join(root, workflowPath);
  assert.ok(fs.existsSync(file), "bootstrap workflow must exist");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /on:\n  push:\n    branches: \[main\]\n    paths: \[\"\.github\/workflows\/bootstrap-firefox\.yml\"\]/);
  assert.match(text, /permissions: \{\}/);
  assert.match(text, /    permissions:\n      contents: read\n      actions: write/);
  assert.equal((text.match(/uses:/g) || []).length, 1);
  assert.match(text, /uses: actions\/checkout@v7/);
  assert.match(text, /ref: \$\{\{ github.sha \}\}/);
  assert.match(text, /fetch-depth: 0/);
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /run: python3 -B scripts\/bootstrap_firefox.py/);
  assert.match(text, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(text, /BOOTSTRAP_BEFORE: \$\{\{ github.event.before \}\}/);
  assert.match(text, /BOOTSTRAP_AFTER: \$\{\{ github.event.after \}\}/);
  assert.doesNotMatch(text, /secrets\.|environment:|id-token:|contents: write|workflow_dispatch:|release:|chrome|cancel-in-progress/);
  const guards = [...text.matchAll(/^    if: (.+)$/gm)].map((match) => match[1]);
  assert.equal(guards.length, 1);
  for (const event of ["push", "workflow_dispatch", "pull_request", "pull_request_target", "release", undefined]) {
    for (const ref of ["refs/heads/main", "refs/heads/topic", "refs/tags/main", undefined]) {
      for (const type of ["branch", "tag", undefined]) {
        for (const attempt of [1, 2, 0, -1, undefined]) {
          const github = { event_name: event, ref, ref_type: type, run_attempt: attempt };
          assert.equal(vm.runInNewContext(guards[0], { github }),
            event === "push" && ref === "refs/heads/main" && type === "branch" && attempt === 1);
        }
      }
    }
  }
});

test("ambiguous or malformed API JSON never dispatches", (t) => {
  const f = fixture(t);
  for (const body of [
    JSON.stringify(release).replace('"draft":false', '"draft":true,"draft":false'),
    "::error::synthetic-opaque-token", "[".repeat(2000),
    JSON.stringify({ ...release, id: 0 }), JSON.stringify({ ...release, id: true }),
  ]) {
    f.put("release.json", body);
    const result = f.run();
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /Traceback|synthetic-opaque-token/);
  }
  assert.ok(f.calls().every((call) => !call.argv.includes("POST")));
});

test("missing shallow history fails closed and deliberate reintroduction rearms", (t) => {
  const f = fixture(t);
  const shallow = path.join(f.dir, "shallow");
  f.git("clone", "-q", "--depth", "1", `file://${f.dir}`, shallow);
  const result = spawnSync("python3", ["-B", script], {
    cwd: shallow, env: f.env, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.deepEqual(f.calls(), []);
  fs.rmSync(path.join(f.dir, workflowPath));
  const before = f.commit();
  f.put(workflowPath, "name: reintroduced");
  const after = f.commit();
  assert.equal(f.run({ BOOTSTRAP_BEFORE: before, BOOTSTRAP_AFTER: after, GITHUB_SHA: after }).status, 0);
  assert.equal(f.calls().length, 2);
});
