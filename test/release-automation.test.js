const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
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


function embeddedDispatch(workflow) {
  const text = workflow === "release" ? read(".github/workflows/release.yml").split("  dispatch-stores:\n")[1] : read(".github/workflows/publish-stores.yml");
  return text.split("python3 - <<'PY'\n")[1].split("\n          PY")[0].split("\n").map((line) => line.slice(10)).join("\n");
}

function exerciseDispatch(workflow, outcomes, { tag = "v1.0.0", sink = "normal", source = embeddedDispatch(workflow), replies = [] } = {}) {
  // Run the exact embedded production source, replacing only external subprocess I/O.
  // No PATH lookup, gh execution, checkout, network or ambient credentials are used.
  const harness = `
import contextlib, io, json, os, subprocess, sys
case = json.load(sys.stdin)
os.environ.clear()
os.environ.update(RELEASE_TAG=case["tag"], GITHUB_REPOSITORY="owner/repo")
calls = []
real_run = subprocess.run
def run(argv, **kwargs):
    calls.append({"argv": argv, **kwargs})
    outcome = case["outcomes"][len(calls)-1]
    if outcome == "timeout":
        raise subprocess.TimeoutExpired(argv, 60, output="synthetic-private-reply", stderr="synthetic-private-reply")
    if outcome == "start":
        raise OSError("synthetic-private-path")
    if outcome == "sigkill":
        return real_run([sys.executable, "-B", "-c", "import os, signal; os.kill(os.getpid(), signal.SIGKILL)"], capture_output=True, text=True, timeout=10)
    return subprocess.CompletedProcess(argv, outcome, case["replies"][len(calls)-1] if case["replies"] else "synthetic-private-reply", "synthetic-private-reply")
subprocess.run = run
class Sink(io.StringIO):
    def write(self, value):
        if case["sink"] == "oserror":
            raise OSError("synthetic-private-path")
        if case["sink"] == "closed":
            raise ValueError("I/O operation on closed file")
        return super().write(value)
out, err = io.StringIO(), Sink()
if case["sink"] in ("full", "native"):
    # Keep the real buffered stderr attached through interpreter shutdown.
    assert isinstance(sys.stderr, io.TextIOWrapper)
    assert isinstance(sys.stderr.buffer, io.BufferedWriter)
    # Do not catch SystemExit or redirect stdout in native mode: CPython must
    # handle the real fatal message and shutdown while stderr is still attached.
    try:
        exec(compile(case["source"], "workflow-dispatch", "exec"), {"__name__": "__main__"})
    finally:
        with open(case["report"], "w") as report:
            json.dump({"calls": calls}, report)
    raise SystemExit(0)
else:
    stderr_context = contextlib.redirect_stderr(err)
status = 0
with contextlib.redirect_stdout(out), stderr_context:
    try:
        exec(compile(case["source"], "workflow-dispatch", "exec"), {"__name__": "__main__"})
    except SystemExit as error:
        status = error.code if isinstance(error.code, int) else 1
        if not isinstance(error.code, int):
            try:
                err.write(str(error.code) + "\\n")
            except (OSError, ValueError):
                pass
    except Exception as error:
        status = 99
        out.write(type(error).__name__)
print(json.dumps({"status": status, "stdout": out.getvalue(), "stderr": err.getvalue(), "calls": calls}))
`;
  const scratch = process.env.TMPDIR || os.tmpdir();
  const fixture = fs.mkdtempSync(path.join(scratch, "workflow-diagnostics-"));
  let stderrFd;
  try {
    // Resolve production imports from a minimal fixture, never ambient PYTHONPATH.
    if (source.includes("from scripts.workflow_diagnostics import write_record")) {
      fs.mkdirSync(path.join(fixture, "scripts"));
      fs.copyFileSync(path.join(root, "scripts/workflow_diagnostics.py"), path.join(fixture, "scripts/workflow_diagnostics.py"));
    }
    if (sink === "full") stderrFd = fs.openSync("/dev/full", "w");
    const result = spawnSync("python3", ["-B", "-c", harness], {
      cwd: fixture,
      encoding: "utf8",
      stdio: ["pipe", "pipe", stderrFd ?? "pipe"],
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", TMPDIR: process.env.TMPDIR },
      input: JSON.stringify({ source, outcomes, tag, sink, replies, report: path.join(fixture, "calls.json") }),
    });
    if (sink === "native" || sink === "full") {
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      return { ...JSON.parse(fs.readFileSync(path.join(fixture, "calls.json"), "utf8")), status: result.status, stdout: result.stdout, stderr: result.stderr || "" };
    }
    assert.equal(result.status, 0, `Workflow harness shutdown exit ${result.status}: ${result.stderr || result.stdout}`);
    return JSON.parse(result.stdout);
  } finally {
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function workflowRecords(result) {
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private|owner\/repo|https?:\/\//);
  const lines = result.stderr.trim().split("\n").filter(Boolean);
  const expectedMessages = [
    "Invalid release tag.",
    "Release tag must be stable semver.",
    "Coordinator dispatch failed; inspect existing runs before retrying.",
    "Coordinator dispatch outcome is uncertain; inspect existing runs before retrying.",
    ...["firefox", "chrome", "firefox, chrome"].map((browsers) => `Main store workflow dispatch not confirmed for ${browsers}; inspect runs before retrying the affected workflow manually from main.`),
  ];
  for (const line of lines) {
    assert.ok(line.startsWith("Workflow diagnostic: ") || expectedMessages.includes(line), line);
  }
  return lines.filter((line) => line.startsWith("Workflow diagnostic: ")).map((line) => {
    assert.ok(line.startsWith("Workflow diagnostic: "), line);
    const record = JSON.parse(line.slice("Workflow diagnostic: ".length));
    assert.ok(["release-dispatch", "store-dispatch", "workflow-runtime"].includes(record.component));
    assert.ok(["runtime", "tag-validation", "dispatch"].includes(record.stage));
    assert.ok(["observed", "unavailable", "accepted", "rejected", "started", "succeeded", "failed", "uncertain", "process-start-failed"].includes(record.event));
    assert.ok(Object.keys(record).every((key) => ["component", "stage", "event", "browser", "tag", "exit_code", "python_version", "tool", "version"].includes(key)));
    if ("browser" in record) assert.ok(["firefox", "chrome"].includes(record.browser));
    if ("exit_code" in record) assert.ok(Number.isInteger(record.exit_code) && record.exit_code >= -(2 ** 31) && record.exit_code < 2 ** 31);
    if ("tag" in record) assert.ok(record.tag.length <= 64 && /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(record.tag));
    return record;
  });
}

test("embedded dispatch success emits safe phase records without changing requests or stdout", () => {
  for (const workflow of ["release", "stores"]) {
    const result = exerciseDispatch(workflow, workflow === "release" ? [0] : [0, 0]);
    assert.equal(result.status, 0, result.stdout);
    const records = workflowRecords(result);
    assert.ok(records.some((record) => record.stage === "runtime" && record.event === "observed" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(record.python_version)));
    assert.ok(records.some((record) => record.stage === "tag-validation" && record.event === "accepted" && record.tag === "v1.0.0"));
    const dispatched = records.filter((record) => record.stage === "dispatch" && record.event === "succeeded");
    assert.equal(dispatched.length, result.calls.length);
    assert.ok(dispatched.every((record) => record.exit_code === 0));
    assert.deepEqual(result.calls.map((call) => call.argv[4].split("/").at(-2)), workflow === "release" ? ["publish-stores.yml"] : ["publish-firefox.yml", "publish-chrome.yml"]);
    for (const call of result.calls) {
      assert.deepEqual(call.argv.slice(0, 4), ["gh", "api", "--method", "POST"]);
      assert.deepEqual(call.argv.slice(-2), ["--input", "-"]);
      assert.deepEqual(JSON.parse(call.input), { ref: "main", inputs: { "release-tag": "v1.0.0", ...(workflow === "stores" ? { operation: "publish" } : {}) } });
      assert.equal(call.timeout, 60);
      assert.equal(call.capture_output, true);
      assert.equal(call.text, true);
    }
    assert.equal(result.stdout, workflow === "release" ? "Store coordinator dispatched; this does not establish store submission or public availability.\n" : "Main publication workflows dispatched; inspect their runs for publication results.\n");
  }
});


test("embedded dispatch errors classify failure versus uncertainty and still attempt every browser", () => {
  for (const workflow of ["release", "stores"]) {
    for (const [outcome, event] of [[7, "failed"], ["timeout", "uncertain"], ["start", "process-start-failed"]]) {
      for (const position of workflow === "stores" ? [0, 1] : [0]) {
        const outcomes = workflow === "stores" ? [0, 0] : [0];
        outcomes[position] = outcome;
        const result = exerciseDispatch(workflow, outcomes);
        assert.equal(result.status, 1, result.stdout);
        assert.equal(result.calls.length, outcomes.length);
        const records = workflowRecords(result);
        const final = records.filter((record) => record.stage === "dispatch" && record.event !== "started");
        assert.equal(final.length, outcomes.length);
        assert.equal(final[position].event, event);
        if (outcome === 7) {
          assert.equal(final[position].exit_code, 7);
        } else {
          assert.ok(!("exit_code" in final[position]));
        }
        if (outcome === "timeout") {
          assert.match(result.stderr, /uncertain|not confirmed/);
          assert.doesNotMatch(result.stderr, /dispatch failed/);
        }
      }
    }
  }
});


test("embedded dispatch rejects invalid tags without disclosing them or making requests", () => {
  for (const workflow of ["release", "stores"]) {
    for (const tag of ["synthetic-private-tag\nvalue", "--option", "v01.0.0", "v1.0.0-rc.1"]) {
      const result = exerciseDispatch(workflow, [], { tag });
      assert.equal(result.status, 1);
      assert.equal(result.calls.length, 0);
      const records = workflowRecords(result);
      assert.ok(records.some((record) => record.stage === "tag-validation" && record.event === "rejected"));
      assert.ok(records.every((record) => !("tag" in record)));
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-tag|--option|v01\.0\.0|rc\.1/);
    }
  }
});

test("embedded dispatch diagnostics tolerate unavailable stderr and omit unbounded values", () => {
  for (const workflow of ["release", "stores"]) {
    for (const sink of ["oserror", "closed"]) {
      for (const outcome of [0, 7, "timeout", "start"]) {
        const result = exerciseDispatch(workflow, workflow === "release" ? [outcome] : [outcome, 0], { sink });
        assert.equal(result.status, outcome === 0 ? 0 : 1, result.stdout);
        assert.equal(result.calls.length, workflow === "release" ? 1 : 2);
        assert.equal(result.stderr, "");
        assert.doesNotMatch(result.stdout, /synthetic-private|ValueError|OSError/);
      }
    }
    const result = exerciseDispatch(workflow, workflow === "release" ? [0] : [0, 0], { tag: `v${"1".repeat(80)}.0.0` });
    assert.equal(result.status, 0);
    assert.ok(workflowRecords(result).every((record) => !("tag" in record)));
    const optionalPrefix = exerciseDispatch(workflow, workflow === "release" ? [] : [0, 0], { tag: "1.0.0" });
    assert.equal(optionalPrefix.status, workflow === "release" ? 1 : 0);
  }
});

test("embedded dispatch survives native buffered stderr ENOSPC through shutdown", async (t) => {
  for (const workflow of ["release", "stores"]) {
    await t.test(workflow, () => {
      // /dev/full is an ENOSPC device; no diagnostic data is persisted.
      for (const outcome of [0, 7, "timeout", "start", "sigkill"]) {
        for (const position of workflow === "stores" ? [0, 1] : [0]) {
          const outcomes = workflow === "release" ? [outcome] : [0, 0];
          outcomes[position] = outcome;
          const normal = exerciseDispatch(workflow, outcomes, { sink: "native" });
          assert.equal(normal.status, outcome === 0 ? 0 : 1);
          const records = workflowRecords(normal);
          assert.ok(records.length > 0);
          const final = records.filter((record) => record.stage === "dispatch" && record.event !== "started");
          assert.equal(final.length, outcomes.length);
          assert.equal(final[position].event, outcome === 0 ? "succeeded" : outcome === 7 ? "failed" : outcome === "start" ? "process-start-failed" : "uncertain");
          if (outcome === "sigkill") assert.equal(final[position].exit_code, -9);
          if (outcome === "timeout" || outcome === "start") assert.ok(!("exit_code" in final[position]));
          if (workflow === "stores") assert.equal(final[1 - position].event, "succeeded");
          const messages = normal.stderr.split("\n").filter((line) => line && !line.startsWith("Workflow diagnostic: "));
          const message = workflow === "stores"
            ? `Main store workflow dispatch not confirmed for ${position === 0 ? "firefox" : "chrome"}; inspect runs before retrying the affected workflow manually from main.`
            : outcome === 7
              ? "Coordinator dispatch failed; inspect existing runs before retrying."
              : "Coordinator dispatch outcome is uncertain; inspect existing runs before retrying.";
          assert.deepEqual(messages, outcome === 0 ? [] : [message]);
          assert.equal(normal.stdout, outcome === 0
            ? workflow === "release"
              ? "Store coordinator dispatched; this does not establish store submission or public availability.\n"
              : "Main publication workflows dispatched; inspect their runs for publication results.\n"
            : "");
          assert.equal(normal.calls.length, outcomes.length);
          assert.deepEqual(normal.calls.map((call) => call.argv[4].split("/").at(-2)), workflow === "release" ? ["publish-stores.yml"] : ["publish-firefox.yml", "publish-chrome.yml"]);
          const full = exerciseDispatch(workflow, outcomes, { sink: "full" });
          assert.equal(full.status, normal.status);
          assert.equal(full.stdout, normal.stdout);
          assert.deepEqual(full.calls, normal.calls);
          assert.equal(full.stderr, "");
        }
      }
      for (const tag of ["synthetic-private-tag\nvalue", "--option", "v01.0.0", "v1.0.0-rc.1"]) {
        const normal = exerciseDispatch(workflow, [], { sink: "native", tag });
        assert.equal(normal.status, 1);
        assert.equal(normal.stdout, "");
        assert.deepEqual(normal.calls, []);
        assert.ok(workflowRecords(normal).some((record) => record.event === "rejected"));
        assert.equal(normal.stderr.split("\n").filter((line) => line && !line.startsWith("Workflow diagnostic: ")).join("\n"), workflow === "release" ? "Invalid release tag." : "Release tag must be stable semver.");
        const full = exerciseDispatch(workflow, [], { sink: "full", tag });
        assert.equal(full.status, 1);
        assert.equal(full.stdout, "");
        assert.equal(full.stderr, "");
        assert.deepEqual(full.calls, []);
      }
    });
  }
});

test("workflows name every step and expose relevant installed runtimes before script phases", () => {
  for (const workflow of ["release", "publish-stores", "publish-chrome", "publish-firefox"]) {
    const text = read(`.github/workflows/${workflow}.yml`);
    for (const step of text.split(/^      - /m).slice(1)) {
      assert.match(step, /^(?:name:|[\s\S]*?\n        name:)/);
    }
    if (workflow !== "publish-stores") {
      assert.equal((text.match(/name: Report installed runtimes/g) || []).length, 2);
    }
  }
});


test("runtime visibility executes installed-version probes with bounded safe projection", () => {
  for (const workflow of ["release", "publish-chrome", "publish-firefox"]) {
    const blocks = [...read(`.github/workflows/${workflow}.yml`).matchAll(/      - name: Report installed runtimes\n        run: \|\n          python3 - <<'PY'\n([\s\S]*?)\n          PY/g)];
    assert.equal(blocks.length, 2, `${workflow} runtime steps missing`);
    for (const block of blocks) {
      const source = block[1].split("\n").map((line) => line.slice(10)).join("\n");
      const node = workflow === "release";
      const result = exerciseDispatch("stores", node ? [0, 0] : [], { source, replies: ["v26.13.0\n", "11.6.0\n"] });
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.stdout, "");
      const records = workflowRecords(result);
      assert.deepEqual(records.map((record) => record.tool), node ? ["node", "npm", "python"] : ["python"]);
      assert.ok(records.every((record) => record.stage === "runtime" && record.event === "observed" && /^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(record.version)));
      assert.deepEqual(result.calls.map((call) => call.argv), node ? [["node", "--version"], ["npm", "--version"]] : []);
      if (node) {
        for (const outcomes of [[0, 0], [7, 0], ["timeout", "start"]]) {
          const invalid = exerciseDispatch("stores", outcomes, { source });
          assert.equal(invalid.status, 0, invalid.stdout);
          assert.ok(workflowRecords(invalid).slice(0, 2).every((record) => record.event === "unavailable" && !("version" in record)));
        }
      }
      for (const sink of ["oserror", "closed"]) {
        const unavailableSink = exerciseDispatch("stores", node ? [0, 0] : [], { source, sink, replies: ["v26.13.0\n", "11.6.0\n"] });
        assert.equal(unavailableSink.status, 0, unavailableSink.stdout);
      }
    }
  }
});


test("every runtime probe survives native buffered stderr ENOSPC through shutdown", async (t) => {
  for (const workflow of ["release", "publish-chrome", "publish-firefox"]) {
    const blocks = [...read(`.github/workflows/${workflow}.yml`).matchAll(/      - name: Report installed runtimes\n        run: \|\n          python3 - <<'PY'\n([\s\S]*?)\n          PY/g)];
    assert.equal(blocks.length, 2);
    for (const [index, block] of blocks.entries()) {
      await t.test(`${workflow} probe ${index + 1}`, () => {
        const source = block[1].split("\n").map((line) => line.slice(10)).join("\n");
        for (const outcomes of workflow === "release" ? [[0, 0], ["timeout", "start"], ["sigkill", 7]] : [[]]) {
          const options = { source, replies: ["v26.13.0\n", "11.6.0\n"] };
          const normal = exerciseDispatch("stores", outcomes, { ...options, sink: "native" });
          assert.ok(workflowRecords(normal).length > 0);
          const full = exerciseDispatch("stores", outcomes, { ...options, sink: "full" });
          assert.equal(full.status, 0);
          assert.equal(full.stdout, normal.stdout);
          assert.deepEqual(full.calls, normal.calls);
          assert.equal(full.stderr, "");
        }
      });
    }
  }
});

test("signal-terminated dispatch is uncertain and preserves independent browser attempts", () => {
  for (const workflow of ["release", "stores"]) {
    for (const outcome of ["sigkill", -9]) {
      for (const position of workflow === "stores" ? [0, 1] : [0]) {
        const outcomes = workflow === "stores" ? [0, 0] : [0];
        outcomes[position] = outcome;
        const result = exerciseDispatch(workflow, outcomes);
        assert.equal(result.status, 1);
        assert.equal(result.calls.length, outcomes.length);
        const final = workflowRecords(result).filter((record) => record.stage === "dispatch" && record.event !== "started");
        assert.equal(final[position].event, "uncertain");
        assert.equal(final[position].exit_code, -9);
        assert.match(result.stderr, /uncertain|not confirmed/);
        assert.doesNotMatch(result.stderr, /dispatch failed/);
        if (workflow === "stores") {
          assert.equal(final[1 - position].event, "succeeded");
          assert.deepEqual(result.calls.map((call) => call.argv[4].split("/").at(-2)), ["publish-firefox.yml", "publish-chrome.yml"]);
        }
      }
    }
  }
});

test("embedded dispatch projects only numeric exit codes and preserves independent mixed failures", () => {
  for (const workflow of ["release", "stores"]) {
    for (const outcome of [2 ** 40, true, "synthetic-private-exit"]) {
      const result = exerciseDispatch(workflow, workflow === "release" ? [outcome] : [outcome, 0]);
      assert.equal(result.status, 1);
      const failure = workflowRecords(result).find((record) => record.event === "failed");
      assert.ok(failure);
      assert.ok(!("exit_code" in failure));
    }
  }
  for (const outcomes of [[7, 7], ["timeout", "start"], ["start", "timeout"]]) {
    const result = exerciseDispatch("stores", outcomes);
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 2);
    assert.equal(workflowRecords(result).filter((record) => record.stage === "dispatch" && record.event !== "started").length, 2);
  }
});
