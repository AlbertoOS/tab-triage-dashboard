const { it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

it("executes Firefox's real module-loaded helpers and retries an import failure", () => {
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const vm = require("node:vm");
    let listener;
    let imports = 0;
    let queries = 0;
    const context = vm.createContext({ URL, browser: {
      action: { onClicked: { addListener() {} } },
      runtime: { getURL: () => "moz-extension://fixture/triage.html",
        onMessage: { addListener(fn) { listener = fn; } } },
      tabs: { query: async () => { queries++; return [
        { id: 1, windowId: 1, index: 0, url: "chrome://settings/", active: true },
        { id: 2, windowId: 1, index: 1, url: "chrome://settings/", active: false },
        { id: 3, windowId: 1, index: 2, url: "chrome://extensions/", active: false },
      ]; } },
    } });
    vm.runInContext(fs.readFileSync("background.js", "utf8"), context, {
      importModuleDynamically: async (specifier) => {
        assert.equal(specifier, "./utils.js");
        if (++imports === 1) throw new Error("Import denied");
        const module = new vm.SourceTextModule(fs.readFileSync("utils.js", "utf8"), { context });
        await module.link(() => assert.fail("Unexpected nested import"));
        await module.evaluate();
        return module;
      },
    });
    const send = () => new Promise((resolve) => listener({ type: "previewDuplicates" }, {}, resolve));
    (async () => {
      assert.equal((await send()).ok, false);
      assert.equal(queries, 0);
      const result = await send();
      assert.equal(result.ok, true);
      assert.deepEqual(Array.from(result.plan.groups[0].candidates, (tab) => tab.id), [2]);
      assert.equal(imports, 2);
      assert.equal((await send()).ok, true);
      assert.equal(imports, 2);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "-e", script], {
    cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});
