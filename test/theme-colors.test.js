import test from "node:test";
import assert from "node:assert/strict";

import {
  parseAnsiTruecolorRgb,
  rgbToHex,
  getThemeColorRgb,
} from "../extensions/pi-graphics/theme-colors.js";

test("parseAnsiTruecolorRgb decodes 38;2;R;G;B", () => {
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[38;2;136;192;208m"), [136, 192, 208]);
});

test("parseAnsiTruecolorRgb decodes 256-color palette", () => {
  const rgb = parseAnsiTruecolorRgb("\x1b[38;5;15m");
  assert.ok(Array.isArray(rgb));
  assert.equal(rgb.length, 3);
});

test("rgbToHex pads and clamps", () => {
  assert.equal(rgbToHex([0, 0, 0]), "#000000");
  assert.equal(rgbToHex([255, 255, 255]), "#ffffff");
  assert.equal(rgbToHex([300, -5, 17]), "#ff0011");
});

test("getThemeColorRgb falls back when theme has no token", () => {
  const rgb = getThemeColorRgb(null, "accent", "#88c0d0");
  assert.deepEqual(rgb, [136, 192, 208]);
});

test("getThemeColorRgb extracts truecolor from a theme.getFgAnsi stub", () => {
  const theme = { getFgAnsi: () => "\x1b[38;2;180;142;173m" };
  assert.deepEqual(getThemeColorRgb(theme, "accent"), [180, 142, 173]);
});
