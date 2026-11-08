const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function sourceManifest(browser) {
  return JSON.parse(fs.readFileSync(path.join(root, `manifest.${browser}.json`), "utf8"));
}

function archivedManifest(archive) {
  const result = spawnSync("unzip", ["-p", archive, "manifest.json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Firefox declares its supported minimum without removing the no-data declaration", () => {
  const { gecko, gecko_android: geckoAndroid } = sourceManifest("firefox").browser_specific_settings;
  assert.equal(gecko.strict_min_version, "140.0");
  assert.deepEqual(gecko.data_collection_permissions, { required: ["none"] });
  assert.deepEqual(geckoAndroid, { strict_min_version: "142.0" });
});

test("browser archives retain their exact target-specific compatibility metadata", (t) => {
  const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "browser-compatibility-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const build = spawnSync("bash", [path.join(root, "build-zip.sh"), "all", root, output], {
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr);
  for (const browser of ["firefox", "chrome"]) {
    const embedded = archivedManifest(path.join(output, `tab-triage-dashboard-${browser}.zip`));
    assert.deepEqual(embedded, sourceManifest(browser));
    if (browser === "firefox") {
      assert.equal(embedded.browser_specific_settings.gecko.strict_min_version, "140.0");
      assert.deepEqual(embedded.browser_specific_settings.gecko.data_collection_permissions, { required: ["none"] });
      assert.deepEqual(embedded.browser_specific_settings.gecko_android, { strict_min_version: "142.0" });
    } else {
      assert.equal(embedded.browser_specific_settings, undefined);
    }
  }
});
