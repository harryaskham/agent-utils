import test from "node:test";
import assert from "node:assert/strict";

import {
  tokenizeConfigArgs,
  parseConfigPatch,
  applyConfigPatch,
  formatConfigSummary,
  configUsageHint,
  parseWidthRatioValue,
  formatWidthRatio,
  widthUsageHint,
  CONFIG_FIELD_NAMES,
} from "../extensions/kitty-image-preview/config-command.js";

function baseConfig() {
  return {
    placement: "auto",
    placementMode: "auto",
    transferMode: "auto",
    passthrough: "auto",
    zIndex: 0,
    columns: 48,
    rows: undefined,
    maxRows: 24,
    minRows: 4,
    background: false,
    showCaption: true,
    clearPrevious: true,
  };
}

test("tokenizeConfigArgs accepts arrays, strings, and splits whitespace", () => {
  assert.deepEqual(tokenizeConfigArgs(["zIndex=0", "transfer=memory"]), ["zIndex=0", "transfer=memory"]);
  assert.deepEqual(tokenizeConfigArgs("zIndex=0 transfer=memory"), ["zIndex=0", "transfer=memory"]);
  assert.deepEqual(tokenizeConfigArgs(["zIndex=0 transfer=memory"]), ["zIndex=0", "transfer=memory"]);
  assert.deepEqual(tokenizeConfigArgs(undefined), []);
  assert.deepEqual(tokenizeConfigArgs(""), []);
});

test("parseConfigPatch handles enums, ints, bools, and aliases", () => {
  const { patch } = parseConfigPatch([
    "placement=rightOverlay",
    "graphicsPlacement=unicode",
    "transfer=memory",
    "z=-5",
    "caption=off",
  ]);
  assert.equal(patch.placement, "rightOverlay");
  assert.equal(patch.placementMode, "unicode");
  assert.equal(patch.transferMode, "memory");
  assert.equal(patch.zIndex, -5);
  assert.equal(patch.showCaption, false);
});

test("parseConfigPatch rejects unknown keys and invalid values", () => {
  assert.throws(() => parseConfigPatch(["bogus=1"]), /unknown config key/);
  assert.throws(() => parseConfigPatch(["transfer=satellite"]), /must be one of/);
  assert.throws(() => parseConfigPatch(["zIndex=abc"]), /expected an integer/);
  assert.throws(() => parseConfigPatch(["columns=0"]), /between 1 and 4096/);
  assert.throws(() => parseConfigPatch(["showCaption=maybe"]), /boolean/);
  assert.throws(() => parseConfigPatch(["zIndex"]), /expected key=value/);
});

test("parseConfigPatch treats rows=auto as an explicit reset to undefined", () => {
  const { patch, resets } = parseConfigPatch(["rows=auto"]);
  assert.equal(patch.rows, undefined);
  assert.ok(resets.has("rows"));
});

test("applyConfigPatch reports only real changes", () => {
  const config = baseConfig();
  const changes = applyConfigPatch(config, { zIndex: 0, transferMode: "memory" });
  assert.equal(config.transferMode, "memory");
  assert.equal(config.zIndex, 0);
  // zIndex was already 0, so only transferMode is reported as changed.
  assert.deepEqual(changes, [{ key: "transferMode", from: "auto", to: "memory" }]);
});

test("formatConfigSummary and usage hint cover every settable field", () => {
  const summary = formatConfigSummary(baseConfig());
  for (const key of CONFIG_FIELD_NAMES) assert.match(summary, new RegExp(`${key}=`));
  // undefined rows renders as auto.
  assert.match(summary, /rows=auto/);
  const hint = configUsageHint();
  assert.match(hint, /Usage: \/image-config/);
  assert.match(hint, /graphicsPlacement/);
});

// /image-width side-rail width parsing (image-preview sidebar width work).
test("parseWidthRatioValue accepts percent, fraction, and bare-percent forms", () => {
  assert.equal(parseWidthRatioValue("25%"), 0.25);
  assert.equal(parseWidthRatioValue(" 50 % ".replace(/\s+%/, "%").trim()), 0.5);
  assert.equal(parseWidthRatioValue("0.25"), 0.25);
  assert.equal(parseWidthRatioValue(".4"), 0.4);
  // A bare number above 1 is read as a percentage, not a fraction.
  assert.equal(parseWidthRatioValue("25"), 0.25);
  // 1 is still a fraction (full width) and clamps to the max allowed share.
  assert.equal(parseWidthRatioValue("1"), 0.9);
});

test("parseWidthRatioValue treats auto/reset words as a default restore", () => {
  for (const word of ["", "auto", "default", "reset", "none", "null", "AUTO"]) {
    assert.equal(parseWidthRatioValue(word), undefined, word);
  }
});

test("parseWidthRatioValue clamps out-of-band values instead of rejecting", () => {
  assert.equal(parseWidthRatioValue("99%"), 0.9);
  assert.equal(parseWidthRatioValue("1%"), 0.05);
});

test("parseWidthRatioValue rejects unparseable input", () => {
  assert.throws(() => parseWidthRatioValue("wide"), /expected a width/);
  assert.throws(() => parseWidthRatioValue("-10%"), /expected a width/);
});

test("widthRatio is settable through /image-config and renders as a percentage", () => {
  const { patch } = parseConfigPatch(["widthRatio=25%"]);
  assert.equal(patch.widthRatio, 0.25);
  // the friendlier aliases resolve to the same canonical field.
  assert.equal(parseConfigPatch(["width=0.3"]).patch.widthRatio, 0.3);
  const config = baseConfig();
  applyConfigPatch(config, patch);
  assert.match(formatConfigSummary(config), /widthRatio=25%/);
  // unset renders as auto (the built-in 50% default).
  assert.equal(formatWidthRatio(undefined), "auto");
  assert.equal(formatWidthRatio(0.5), "50%");
  assert.match(widthUsageHint(), /Usage: \/image-width/);
});
