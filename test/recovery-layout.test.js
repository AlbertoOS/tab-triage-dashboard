const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

it("bounds recovery to the viewport and shrinks long messages without hiding the action", () => {
  const css = fs.readFileSync(path.join(__dirname, "../triage.css"), "utf8");
  const toast = css.match(/\.undo-toast\s*\{([^}]+)\}/)[1];
  assert.match(toast, /max-width:\s*calc\(100% - 32px\)/);
  assert.match(toast, /flex-wrap:\s*wrap/);
  const message = css.match(/#undo-toast-msg\s*\{([^}]+)\}/)?.[1];
  assert.ok(message, "the message must shrink independently of its unbroken title");
  assert.match(message, /min-width:\s*0/);
  assert.match(message, /overflow:\s*hidden/);
  assert.match(message, /text-overflow:\s*ellipsis/);
});

// Execute production notification/restore handlers, replacing only browser layout and I/O.
const vm = require("node:vm");
const harness = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(harness.slice(0, harness.indexOf("for (const [selector, type]")) + ";dashboard", { require, __dirname, URL, setImmediate });

it("reserves measured toast height, bottom offset and gap without accumulating repeated notices", async () => {
  const app = dashboard(() => ({ ok: true, tabs: [] }));
  await app.settle();
  app.get("undo-toast").offsetHeight = 46;
  for (let i = 0; i < 3; i++) {
    app.run('showUndoToast("Close completed.")');
    assert.equal(app.get("undo-toast-status").style.height, "82px");
  }
  app.get("undo-toast").offsetHeight = 93;
  app.resize();
  assert.equal(app.get("undo-toast-status").style.height, "129px", "wrapping must update the reservation");
  app.get("undo-toast").offsetHeight = 46;
  app.resize();
  assert.equal(app.get("undo-toast-status").style.height, "82px", "widening must shrink the reservation");
  app.run('getComputedStyle = () => ({ bottom: "40px", rowGap: "16px" })');
  app.resize();
  assert.equal(app.get("undo-toast-status").style.height, "102px", "use the effective CSS offset and gap");
  await app.get("undo-toast-btn").listeners.click();
  assert.equal(app.get("undo-toast").hidden, true);
  assert.equal(app.get("undo-toast-status").style.height, "0px");
  app.resize();
  assert.equal(app.get("undo-toast-status").style.height, "0px", "hidden observer deliveries cannot reserve space");
});

it("retains the current reservation through failed and stale restore completion", async () => {
  let finishRestore;
  const app = dashboard((message) => message.type === "getTabs" ? { ok: true, tabs: [] } :
    new Promise((resolve) => { finishRestore = resolve; }));
  await app.settle();
  app.get("undo-toast").offsetHeight = 46;
  app.run('showUndoToast("Old close completed.")');
  const pending = app.get("undo-toast-btn").listeners.click();
  app.get("undo-toast").offsetHeight = 93;
  app.run('showUndoToast("New close completed.")');
  finishRestore({ ok: true });
  await pending;
  assert.equal(app.get("undo-toast").hidden, false);
  assert.equal(app.get("undo-toast-status").style.height, "129px");
  const failed = app.get("undo-toast-btn").listeners.click();
  finishRestore({ ok: false, error: "Restore denied" });
  await failed;
  assert.equal(app.get("undo-toast").hidden, false);
  assert.equal(app.get("undo-toast-status").style.height, "129px");
});
