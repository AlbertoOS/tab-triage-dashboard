const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const os = require("node:os");
const root = path.resolve(__dirname, "..");

test("store workflows admit only main dispatches and isolate credentials", () => {
  for (const browser of ["firefox", "chrome"]) {
    const file = path.join(root, `.github/workflows/publish-${browser}.yml`);
    assert.ok(fs.existsSync(file), "a main-only publication workflow must exist");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /github.event_name == 'workflow_dispatch'/);
    assert.match(text, /github.ref == 'refs\/heads\/main'/);
    assert.match(text, /github.ref_type == 'branch'/);
    assert.match(text, /persist-credentials: false/);
    assert.match(text, /ref: \$\{\{ github.sha \}\}/);
    assert.match(text, new RegExp(`environment: ${browser}-release`));
    assert.match(text, /verify-release-only/);
    assert.doesNotMatch(text, /pull_request|secrets: inherit|credentials_json/);
  }
});

test("actual job guards reject every non-main dispatch credential context", () => {
  for (const browser of ["firefox", "chrome"]) {
    const text = fs.readFileSync(path.join(root, `.github/workflows/publish-${browser}.yml`), "utf8");
    const guards = [...text.matchAll(/^    if: (.+)$/gm)].map((match) => match[1]);
    assert.equal(guards.length, 2);
    for (const event of ["workflow_dispatch", "pull_request", "pull_request_target", "release", "push"]) {
      for (const ref of ["refs/heads/main", "refs/heads/topic", "refs/tags/main", "refs/tags/v1.0.0"]) {
        for (const type of ["branch", "tag"]) {
          const context = { github: { event_name: event, ref, ref_type: type }, inputs: { operation: "publish" } };
          const admitted = event === "workflow_dispatch" && ref === "refs/heads/main" && type === "branch";
          for (const guard of guards) assert.equal(vm.runInNewContext(guard, context), admitted);
        }
      }
    }
    const context = { github: { event_name: "workflow_dispatch", ref: "refs/heads/main", ref_type: "branch" }, inputs: { operation: "verify-release-only" } };
    assert.equal(vm.runInNewContext(guards[0], context), true);
    assert.equal(vm.runInNewContext(guards[1], context), false);
    const upload = text.indexOf("      - name: Upload verified package");
    assert.ok(upload > 0);
    if (browser === "firefox") {
      assert.doesNotMatch(text.slice(0, upload), /secrets\./);
      assert.doesNotMatch(text, /id-token: write/);
    } else {
      assert.equal((text.match(/id-token: write/g) || []).length, 1);
      const auth = text.indexOf("      - uses: google-github-actions/auth@v3");
      assert.ok(text.indexOf("scripts/store_publish.py prerequisites chrome") < auth);
      assert.match(text, /access_token_scopes: https:\/\/www.googleapis.com\/auth\/chromewebstore/);
      assert.match(text, /create_credentials_file: false/);
      assert.match(text, /export_environment_variables: false/);
      assert.doesNotMatch(text.slice(0, upload), /outputs\.access_token/);
    }
  }
});

test("release coordinator has only dispatch permissions and invokes main, without credentials", () => {
  const text = fs.readFileSync(path.join(root, ".github/workflows/publish-stores.yml"), "utf8");
  assert.match(text, /types: \[published\]/);
  assert.match(text, /actions: write/);
  assert.match(text, /"ref": "main"/);
  assert.doesNotMatch(text, /secrets\.|environment:|id-token:|uses:|checkout/);
  assert.doesNotMatch(text, /contents: write/);
});

test("actual coordinator dispatches both main workflows with safe argv and propagates errors", (t) => {
  const text = fs.readFileSync(path.join(root, ".github/workflows/publish-stores.yml"), "utf8");
  const embedded = text.split("python3 - <<'PY'\n")[1].split("\n          PY")[0].split("\n").map((line) => line.slice(10)).join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-coordinator-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "dispatch.jsonl");
  fs.writeFileSync(path.join(dir, "gh"), `#!${process.execPath}\nconst fs=require('node:fs');const data=fs.readFileSync(0,'utf8');fs.appendFileSync(process.env.DISPATCH_LOG,JSON.stringify({args:process.argv.slice(2),payload:JSON.parse(data)})+'\\n');if(process.env.FAIL_DISPATCH){console.error('synthetic-sensitive-response');process.exit(1);}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: "synthetic-not-a-token", GITHUB_REPOSITORY: "owner/repo", RELEASE_TAG: "v1.0.0", DISPATCH_LOG: log };
  const run = (extra = {}) => spawnSync("python3", ["-B", "-c", embedded], { cwd: dir, encoding: "utf8", env: { ...env, ...extra } });
  const success = run();
  assert.equal(success.status, 0, success.stdout + success.stderr);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  for (const [index, browser] of ["firefox", "chrome"].entries()) {
    assert.deepEqual(calls[index].payload, { ref: "main", inputs: { "release-tag": "v1.0.0", operation: "publish" } });
    assert.ok(calls[index].args.includes(`repos/owner/repo/actions/workflows/publish-${browser}.yml/dispatches`));
    assert.equal(calls[index].args.includes("synthetic-not-a-token"), false);
  }
  fs.unlinkSync(log);
  assert.notEqual(run({ RELEASE_TAG: "v1.0.0;touch PWNED" }).status, 0);
  assert.equal(fs.existsSync(log), false);
  assert.equal(fs.existsSync(path.join(dir, "PWNED")), false);
  const failure = run({ FAIL_DISPATCH: "1" });
  assert.notEqual(failure.status, 0);
  assert.doesNotMatch(failure.stdout + failure.stderr, /synthetic-sensitive-response/);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1);
});

test("offline store publication integration suite", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "test", "-p", "store_publication_test.py", "-v"], {
    cwd: root, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran [1-9][0-9]* tests/);
});
