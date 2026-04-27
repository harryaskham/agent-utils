import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  KITTY_UNICODE_PLACEHOLDER,
  buildKittyUnicodePlaceholderCell,
  buildKittyUnicodePlaceholderLines,
  buildPngVirtualPlacementCommand,
  serializeKittyGraphicsCommand,
  shouldUseUnicodePlaceholders,
} from "../extensions/kitty-graphics.js";

const ESC = "\x1b";
const D0 = "\u0305";
const D1 = "\u030d";
const D2 = "\u030e";

test("tmux passthrough wraps APC and doubles inner escape bytes", () => {
  const serialized = serializeKittyGraphicsCommand(
    { a: "p", i: 42, q: 2 },
    "",
    { passthrough: "auto", env: { TMUX: "/tmp/tmux-1000/default,1,0" } },
  );

  assert.equal(serialized, `${ESC}Ptmux;${ESC}${ESC}_Ga=p,i=42,q=2${ESC}${ESC}\\${ESC}\\`);
});

test("virtual placement command transmits PNG data without cursor placement", () => {
  const serialized = buildPngVirtualPlacementCommand({
    imageId: 42,
    placementId: 9,
    pngBase64: "YWJj",
    columns: 2,
    rows: 3,
    passthrough: "none",
  });

  assert.equal(serialized, `${ESC}_Ga=T,f=100,t=d,i=42,p=9,U=1,c=2,r=3,q=2;YWJj${ESC}\\`);
  assert.doesNotMatch(serialized, /z=/);
});

test("Unicode placeholder lines encode image id, placement id, rows, and scrollable cells", () => {
  const lines = buildKittyUnicodePlaceholderLines({
    imageId: 42,
    placementId: 9,
    columns: 2,
    rows: 2,
    width: 5,
    caption: "hi",
  });

  assert.deepEqual(lines, [
    `${ESC}[38;2;0;0;42m${ESC}[58;2;0;0;9m${KITTY_UNICODE_PLACEHOLDER}${D0}${KITTY_UNICODE_PLACEHOLDER}${ESC}[39;59m hi`,
    `${ESC}[38;2;0;0;42m${ESC}[58;2;0;0;9m${KITTY_UNICODE_PLACEHOLDER}${D1}${KITTY_UNICODE_PLACEHOLDER}${ESC}[39;59m   `,
  ]);
});

test("placeholder cells include the high image-id byte when ids exceed truecolor", () => {
  assert.equal(
    buildKittyUnicodePlaceholderCell({ imageId: 0x0200002a, row: 0, column: 0, includeColumn: false }),
    `${KITTY_UNICODE_PLACEHOLDER}${D0}${D0}${D2}`,
  );
});

test("auto placement mode uses Unicode placeholders only for tmux passthrough", () => {
  assert.equal(shouldUseUnicodePlaceholders({ env: { TMUX: "1" } }), true);
  assert.equal(shouldUseUnicodePlaceholders({ env: {} }), false);
  assert.equal(shouldUseUnicodePlaceholders({ placementMode: "unicode", env: {} }), true);
  assert.equal(shouldUseUnicodePlaceholders({ placementMode: "cursor", env: { TMUX: "1" } }), false);
});

test("forced anchoring overrides cursor placement for side overlays", () => {
  assert.equal(shouldUseUnicodePlaceholders({ placementMode: "cursor", env: {}, forceAnchored: true }), true);
});

test("kitty image preview advertises a fixed right-side panel with tmux inline fallback", async () => {
  const source = await readFile(new URL("../extensions/kitty-image-preview.js", import.meta.url), "utf8");

  assert.match(source, /SIDE_OVERLAY_PLACEMENT = "rightOverlay"/);
  assert.match(source, /PREVIEW_PLACEMENTS = \[AUTO_PLACEMENT, \.\.\.WIDGET_PLACEMENTS, SIDE_OVERLAY_PLACEMENT\]/);
  assert.match(source, /SIDE_PANEL_MAX_WIDTH_RATIO = 0\.5/);
  assert.match(source, /function renderTuiWithSidePanel/);
  assert.match(source, /function shouldUseInlineRightPlacement/);
  assert.match(source, /function resolvePlacement/);
  assert.match(source, /rightOverlay is inline inside tmux passthrough/);
  assert.match(source, /nonCapturing: true/);
  assert.match(source, /options\.forceSideOverlay !== false && isSideOverlayPlacement\(placement\)/);
});
