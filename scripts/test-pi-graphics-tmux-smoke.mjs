#!/usr/bin/env node
// Deterministic tmux/caco smoke harness for Pi kitty graphics placement.
// It does not require a live kitty terminal: it validates the escape stream shape
// that Pi emits inside tmux so repeated redraws re-create the same virtual
// placement without re-uploading image data or adding duplicate placeholder rows.

import assert from "node:assert/strict";

import { buildScopedDeleteCommand } from "../extensions/kitty-graphics.js";
import { renderPromptEnclosure } from "../extensions/pi-graphics/affordances.js";
import { buildPlacement, makeState, renderToText } from "../extensions/pi-graphics/runtime.js";

const ESC = "\x1b";
const TMUX_DCS_START = `${ESC}Ptmux;`;

const state = makeState();
state.config.passthrough = "tmux";
const rendered = renderPromptEnclosure({ columns: 12, variant: "gradient" });

const first = buildPlacement(state, {
  name: "tmux-caco-redraw-smoke",
  png: rendered.png,
  columns: rendered.columns,
  rows: rendered.rows,
  zIndex: -1073741825,
});
const second = buildPlacement(state, {
  name: "tmux-caco-redraw-smoke",
  png: rendered.png,
  columns: rendered.columns,
  rows: rendered.rows,
  zIndex: -1073741825,
});

const firstText = renderToText(first);
const secondText = renderToText(second);
const cleanup = buildScopedDeleteCommand({
  ownedImageIds: state.ownedImageIds,
  placementId: first.placementId,
  passthrough: "tmux",
});

assert.equal(first.imageId, second.imageId, "redraw should reuse the image id");
assert.equal(first.placementId, second.placementId, "redraw should reuse the placement id");
assert.equal(firstText.split("\n").length, rendered.rows, "first render should reserve only the intended row count");
assert.equal(secondText.split("\n").length, rendered.rows, "redraw should not add duplicate placeholder rows");
assert.match(firstText, new RegExp(`${ESC}Ptmux;`), "first render should use tmux DCS passthrough");
assert.match(firstText, /a=T/, "first render uploads and creates the virtual placement");
assert.match(firstText, /U=1/, "first render should use Unicode placeholder placement");
assert.doesNotMatch(secondText, /a=T/, "redraw must not re-upload image data");
assert.doesNotMatch(secondText, /a=p/, "redraw must reuse the existing virtual placement without re-emitting placement commands");
assert.match(cleanup, /a=d,d=i/, "cleanup must delete owned images by id");
assert.doesNotMatch(cleanup, /d=A/, "cleanup must never delete all terminal images");
assert.ok(firstText.startsWith(TMUX_DCS_START), "transmit should be prefixed before placeholder cells");

console.log(JSON.stringify({
  ok: true,
  imageId: first.imageId,
  placementId: first.placementId,
  rows: rendered.rows,
  firstUpload: /a=T/.test(firstText),
  redrawUpload: /a=T/.test(secondText),
  redrawReusesPlacement: !/a=p/.test(secondText),
  scopedCleanup: /a=d,d=i/.test(cleanup) && !/d=A/.test(cleanup),
}, null, 2));
