import test from "node:test";
import assert from "node:assert/strict";

import {
  tokenizeConfigArgs,
  parseConfigPatch,
  applyConfigPatch,
  formatConfigSummary,
  configUsageHint,
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
