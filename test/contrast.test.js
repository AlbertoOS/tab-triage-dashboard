const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function luminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map((value) => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

it("keeps enabled unpressed fuzzy text above the normal-text contrast minimum", () => {
  const css = fs.readFileSync(path.join(__dirname, "../triage.css"), "utf8");
  const button = css.match(/\.btn-toggle\s*\{([^}]+)\}/)[1];
  assert.match(button, /background:\s*transparent/);
  const foreground = button.match(/(?:^|;)\s*color:\s*(#[a-f\d]{6})/i)[1];
  const background = css.match(/body\s*\{[^}]*background:\s*(#[a-f\d]{6})/i)[1];
  const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
  const ratio = (values[1] + 0.05) / (values[0] + 0.05);
  assert.ok(ratio >= 4.5, `Unpressed fuzzy text contrast ${ratio.toFixed(4)}:1 must be at least 4.5:1`);
});
