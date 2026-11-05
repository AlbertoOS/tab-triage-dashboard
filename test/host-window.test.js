const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

for (const namespace of ["browser", "chrome"]) {
  for (const entrypoint of ["toolbar", "goToTab"]) {
    it(`${namespace} ${entrypoint} focuses the activation result's host after a tab moves`, async () => {
      let click;
      let listener;
      const events = [];
      const warnings = [];
      const url = "chrome-extension://fixture/triage.html";
      const api = {
        action: { onClicked: { addListener(fn) { click = fn; } } },
        runtime: {
          getURL: () => url,
          getManifest: () => namespace === "browser" ? { browser_specific_settings: { gecko: {} } } : {},
          onMessage: { addListener(fn) { listener = fn; } },
          sendMessage: async (message) => { events.push(["refresh", message.tabId]); return { ok: true }; },
        },
        tabs: {
          query: async () => [{ id: 4, windowId: 2, url }],
          update: async (id, properties) => {
            events.push(["activate", id, properties.active]);
            // The tab moved after the inventory snapshot, before activation.
            return { id, windowId: 3, url, active: true };
          },
          create: async () => { throw new Error("Must not create a duplicate"); },
        },
        windows: { update: async (id, properties) => {
          events.push(["focus", id, properties.focused]);
          if (id === 2) throw new Error("The old window closed after the move");
        } },
      };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), {
        [namespace]: api, console: { error: (...args) => warnings.push(args) },
      });
      if (entrypoint === "toolbar") {
        await click({ id: 8, windowId: 1 });
        assert.deepEqual(events, [["activate", 4, true], ["focus", 3, true], ["refresh", 4]]);
      } else {
        const response = await new Promise((resolve) => {
          assert.equal(listener({ type: "goToTab", tabId: 4, windowId: 2 }, {}, resolve), true);
        });
        assert.equal(response.ok, true);
        assert.deepEqual(events, [["activate", 4, true], ["focus", 3, true]]);
        const before = events.length;
        listener({ type: "goToTab", tabId: 4, windowId: "2" }, {}, (invalid) => {
          assert.equal(invalid.ok, false);
        });
        assert.equal(events.length, before, "existing window argument validation remains strict");
      }
      assert.deepEqual(warnings, []);
    });
  }
}
