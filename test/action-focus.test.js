const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

for (const selector of [".more-menu button", ".btn-undo"]) {
  it(`provides a visible keyboard outline for borderless ${selector} actions`, () => {
    const css = fs.readFileSync(path.join(__dirname, "../triage.css"), "utf8");
    const rule = css.split(`${selector}:focus-visible {`)[1]?.split("}")[0];
    assert.ok(rule, `${selector} needs focus-visible styling`);
    assert.match(rule, /outline:\s*2px solid #cad3f5/);
    assert.match(rule, /outline-offset:\s*-?\d+px/);
  });
}
