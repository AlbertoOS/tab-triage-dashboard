const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
const sources = ["background.js", "triage.html", "triage.js", "utils.js", "triage.css"];

function run(command, args, cwd, env = {}, input) {
  return spawnSync(command, args, {
    cwd, input, encoding: "utf8",
    env: { ...process.env, ...env },
  });
}
function ok(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "packaging-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ["build-zip.sh", "release-publish.sh", "release.sh"]) {
    fs.copyFileSync(path.join(root, name), path.join(dir, name));
  }
  for (const name of sources) fs.writeFileSync(path.join(dir, name), `// tagged ${name}\n`);
  fs.mkdirSync(path.join(dir, "icons"));
  fs.writeFileSync(path.join(dir, "icons/icon.svg"), "<svg/>\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.3.2" }));
  for (const browser of ["firefox", "chrome"]) {
    fs.writeFileSync(path.join(dir, `manifest.${browser}.json`), JSON.stringify({ version: "1.3.2", manifest_version: 3, name: browser }));
  }
  const env = {
    HOME: path.join(dir, "home"), TMPDIR: dir,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  fs.mkdirSync(env.HOME);
  const git = (...args) => ok(run(realGit, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], dir, env));
  git("init", "-q"); git("add", "."); git("commit", "-qm", "fix: fixture"); git("tag", "v1.3.2");
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  const log = path.join(dir, "mutations.jsonl");
  // Read-only Git is real; every mutation/network boundary is trapped, never forwarded.
  const stub = `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const path=require('node:path');const args=process.argv.slice(2);const name=path.basename(process.argv[1]);\nif(name==='git' && ['describe','rev-parse','rev-list','log','archive','show','ls-tree','check-ref-format','status','diff'].includes(args[0])) {const r=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status ?? 1);}\nfs.appendFileSync(process.env.MUTATION_LOG,JSON.stringify([name,...args])+'\\n');\nif(name==='git' && args[0]==='push')process.exit(Number(process.env.PUSH_STATUS||0));\nif(name==='gh' && args[0]==='release' && args[1]==='view')process.exit(Number(process.env.RELEASE_VIEW_STATUS||1));\nif(name==='gh' && ['create','upload'].includes(args[1])){fs.mkdirSync(process.env.CAPTURE,{recursive:true});for(const a of args)if(a.endsWith('.zip'))fs.copyFileSync(a,path.join(process.env.CAPTURE,path.basename(a)));}\nif(name==='npm')process.exit(0);\nif(name==='git' && ['add','commit','tag'].includes(args[0])) {const r=cp.spawnSync(${JSON.stringify(realGit)},['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','tag.gpgsign=false',...args],{stdio:'inherit'});process.exit(r.status ?? 1);}\nif(name==='gh')process.exit(0);\nprocess.exit(97);\n`;
  for (const name of ["git", "gh", "npm"]) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, MUTATION_LOG: log, CAPTURE: path.join(dir, "capture") });
  return { dir, env, git, calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [] };
}
function entries(zip) { return ok(run("unzip", ["-Z1", zip], root)).split("\n").filter((name) => !name.endsWith("/")); }
function payload(zip, name) { return ok(run("unzip", ["-p", zip, name], root)); }
function checkBoth(dir, version, js = "// tagged triage.js") {
  for (const browser of ["firefox", "chrome"]) {
    const zip = path.join(dir, `tab-triage-dashboard-${browser}.zip`);
    assert.equal(JSON.parse(payload(zip, "manifest.json")).version, version);
    assert.equal(payload(zip, "triage.js"), js);
    assert.deepEqual(entries(zip).sort(), ["manifest.json", ...sources, "icons/icon.svg"].sort());
  }
}

for (const tag of ["v1.3.3", "v1.3.2.0", "not-a-version", "--help"]) {
  test(`publisher rejects invalid or mismatched release tag ${tag} without mutations`, (t) => {
    const f = fixture(t);
    if (!tag.startsWith("--")) f.git("tag", tag);
    const result = run("bash", ["release-publish.sh", tag], f.dir, f.env);
    assert.notEqual(result.status, 0, "invalid release identity must fail");
    assert.deepEqual(f.calls(), []);
  });
}

test("build-only exports tag-bound artifacts and a hash receipt without Git/gh writes or historical scripts", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "build-zip.sh"), "#!/bin/bash\nexit 88 # never execute the old tag build\n");
  f.git("add", "build-zip.sh"); f.git("commit", "-qm", "fix: old builder");
  f.git("tag", "-a", "v1.3.2", "-f", "-m", "annotated release");
  fs.copyFileSync(path.join(root, "build-zip.sh"), path.join(f.dir, "build-zip.sh"));
  const output = path.join(f.dir, "output"); fs.mkdirSync(output);
  ok(run("bash", ["release-publish.sh", "v1.3.2", "--build-only", output], f.dir, f.env));
  checkBoth(output, "1.3.2");
  const receipt = JSON.parse(fs.readFileSync(path.join(output, "provenance.json"), "utf8"));
  assert.equal(receipt.tag, "v1.3.2");
  assert.equal(receipt.tagObject, f.git("rev-parse", "refs/tags/v1.3.2"));
  assert.equal(receipt.commit, f.git("rev-parse", "v1.3.2^{commit}"));
  assert.equal(receipt.version, "1.3.2");
  const crypto = require("node:crypto");
  for (const [file, hash] of Object.entries(receipt.sha256)) {
    assert.equal(hash, crypto.createHash("sha256").update(fs.readFileSync(path.join(output, file))).digest("hex"));
  }
  assert.equal(Object.keys(receipt.sha256).length, 2);
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(fs.readdirSync(f.dir).filter((name) => name.startsWith("tab-triage-release.") || name.startsWith("tab-triage-build.")), []);
});

for (const variant of ["symlink", "export-subst"]) {
  test(`publisher rejects ${variant} content that cannot prove exact regular tag blobs`, (t) => {
    const f = fixture(t);
    if (variant === "symlink") {
      fs.unlinkSync(path.join(f.dir, "triage.js"));
      fs.symlinkSync("/etc/hostname", path.join(f.dir, "triage.js"));
    } else {
      fs.writeFileSync(path.join(f.dir, "triage.js"), "// $Format:%H$\n");
      fs.writeFileSync(path.join(f.dir, ".gitattributes"), "triage.js export-subst\n");
    }
    f.git("add", "."); f.git("commit", "-qm", "fix: unsafe export"); f.git("tag", "-f", "v1.3.2");
    const result = run("bash", ["release-publish.sh", "v1.3.2"], f.dir, f.env);
    assert.notEqual(result.status, 0, "unproven tag bytes must not publish");
    assert.deepEqual(f.calls(), []);
  });
}

test("normal release attaches both freshly built tagged payloads and pushes only its selected tag", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "triage.js"), "// release candidate\n");
  f.git("add", "triage.js"); f.git("commit", "-qm", "fix: candidate payload");
  for (const browser of ["firefox", "chrome"]) fs.writeFileSync(path.join(f.dir, `tab-triage-dashboard-${browser}.zip`), "stale ZIP");
  ok(run("bash", ["release.sh"], f.dir, f.env, "y\n"));
  checkBoth(f.env.CAPTURE, "1.3.3", "// release candidate");
  const pushes = f.calls().filter((call) => call[0] === "git" && call[1] === "push");
  assert.ok(pushes.length > 0);
  assert.ok(pushes.every((call) => call.includes("--no-follow-tags") && !call.includes("--tags")));
  assert.ok(pushes.some((call) => call.at(-1) === `${f.git("rev-parse", "refs/tags/v1.3.3")}:refs/tags/v1.3.3`));
});

test("tag push failure is fatal before any gh operation and cleans private scratch", (t) => {
  const f = fixture(t);
  const result = run("bash", ["release-publish.sh", "v1.3.2"], f.dir, { ...f.env, PUSH_STATUS: "43" });
  assert.equal(result.status, 43);
  assert.equal(f.calls().filter((call) => call[0] === "gh").length, 0);
  assert.equal(f.calls().filter((call) => call[0] === "git" && call[1] === "push").length, 1);
  assert.deepEqual(fs.readdirSync(f.dir).filter((name) => name.startsWith("tab-triage-release.") || name.startsWith("tab-triage-build.")), []);
});

test("legacy no-argument publishing safely rebuilds both assets for an existing release", (t) => {
  const f = fixture(t);
  ok(run("bash", [path.join(f.dir, "release-publish.sh")], f.env.HOME, { ...f.env, RELEASE_VIEW_STATUS: "0" }));
  checkBoth(f.env.CAPTURE, "1.3.2");
  assert.ok(f.calls().some((call) => call[0] === "gh" && call[2] === "upload" && call[3] === "v1.3.2"));
  assert.equal(f.calls().filter((call) => call[0] === "npm").length, 0);
});

test("missing selected tags fail without mutations", (t) => {
  const f = fixture(t);
  assert.notEqual(run("bash", ["release-publish.sh", "v4.5.6"], f.dir, f.env).status, 0);
  assert.deepEqual(f.calls(), []);
});

test("publisher rebuilds both assets from the explicit older tag, ignoring stale ZIPs and dirty HEAD", (t) => {
  const f = fixture(t);
  const commit = f.git("rev-parse", "v1.3.2^{commit}");
  fs.writeFileSync(path.join(f.dir, "triage.js"), "// same-version newer HEAD\n");
  f.git("add", "triage.js"); f.git("commit", "-qm", "fix: same version new payload");
  f.git("tag", "v9.9.9");
  fs.writeFileSync(path.join(f.dir, "triage.js"), "// dirty contamination\n");
  fs.writeFileSync(path.join(f.dir, "icons/untracked-secret.svg"), "secret");
  for (const browser of ["firefox", "chrome"]) fs.writeFileSync(path.join(f.dir, `tab-triage-dashboard-${browser}.zip`), "stale ZIP");
  ok(run("bash", ["release-publish.sh", "v1.3.2"], f.dir, f.env));
  checkBoth(f.env.CAPTURE, "1.3.2");
  assert.deepEqual(f.calls().filter((call) => call[0] === "git"), [["git", "push", "--no-follow-tags", "origin", `${f.git("rev-parse", "refs/tags/v1.3.2")}:refs/tags/v1.3.2`]]);
  assert.ok(f.calls().some((call) => call[0] === "gh" && call[1] === "release" && call[2] === "create" && call[3] === "v1.3.2" && call.includes("--verify-tag")));
  assert.equal(fs.readFileSync(path.join(f.dir, "triage.js"), "utf8"), "// dirty contamination\n");
  assert.equal(f.git("rev-parse", "v1.3.2^{commit}"), commit);
});

for (const file of ["manifest.firefox.json", "manifest.chrome.json", "package.json"]) {
  test(`version drift in ${file} is rejected before either archive is written`, (t) => {
    const f = fixture(t);
    const name = path.join(f.dir, file);
    fs.writeFileSync(name, JSON.stringify({ ...JSON.parse(fs.readFileSync(name)), version: "1.3.3" }));
    const result = run("bash", ["build-zip.sh", "all"], f.dir, f.env);
    assert.notEqual(result.status, 0, "version mismatch must fail");
    assert.match(result.stderr, /version/i);
    for (const browser of ["firefox", "chrome"]) assert.equal(fs.existsSync(path.join(f.dir, `tab-triage-dashboard-${browser}.zip`)), false);
  });
}

test("packages preserve synchronized source versions without Git suffixes", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "untracked-secret.txt"), "never package");
  ok(run("bash", ["build-zip.sh", "all"], f.dir, f.env));
  checkBoth(f.dir, "1.3.2");
});
