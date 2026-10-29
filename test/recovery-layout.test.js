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
