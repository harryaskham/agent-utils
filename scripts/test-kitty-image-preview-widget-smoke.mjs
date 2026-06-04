#!/usr/bin/env node
// Deterministic widget-level smoke for the kitty image preview transmit-once
// path (bd-c75d9e). The existing pi-graphics tmux smoke
// (scripts/test-pi-graphics-tmux-smoke.mjs) exercises the runtime placement
// path (buildPlacement/renderToText). This complements it by driving the actual
// preview widget render — KittyImagePreviewWidget.render -> renderCurrentImageLines
// -> buildCurrentDisplayCommand — twice in unicode-placeholder mode and
// asserting the bd-d6fa1b invariants at the widget boundary:
//   firstUpload=true       the first frame transmits the PNG payload (a=T, U=1)
//   redrawUpload=false     repaints at the same signature are placement-only
//   reattachReupload=true  a session_start-style guard reset re-transmits
//
// It needs no live kitty terminal: it inspects the escape stream the widget
// emits on its first rendered line. It deliberately imports the extracted
// schema-free widget module (kitty-image-preview/widget.js) so the harness does
// not pull in the schema.js (@sinclair/typebox) / pi-ai command-registration
// imports of the top-level extension.

import assert from "node:assert/strict";

import {
  KittyImagePreviewWidget,
} from "../extensions/kitty-image-preview/widget.js";
import { resetTransmissionGuard } from "../extensions/kitty-image-preview/display-commands.js";
import { stableKittyImageId } from "../extensions/kitty-graphics.js";

// A small, syntactically valid base64 PNG payload. The command builders only
// embed these bytes into the escape stream (they do not decode the PNG), so any
// non-empty base64 payload exercises the transmit-once path.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const IMAGE_ID = stableKittyImageId("agent-utils-kitty-image-preview-widget-smoke-image");
const PLACEMENT_ID = stableKittyImageId("agent-utils-kitty-image-preview-widget-smoke-placement");

function makeItem() {
  return { id: IMAGE_ID, label: "widget-smoke", width: 64, height: 64, path: "/tmp/widget-smoke.png" };
}

// Build a preview state mirroring the canonical initial state in
// kitty-image-preview.js, already "prepared" (as prepareCurrentImage would leave
// it) for an in-memory transport so the payload base64 is embedded directly.
function makePreparedState() {
  const item = makeItem();
  return {
    visible: true,
    index: 0,
    items: [item],
    lastDeleteCommand: "",
    ownedImageIds: new Set([item.id]),
    transmittedSignatures: new Map(),
    config: {
      columns: 40,
      rows: undefined,
      minRows: 4,
      maxRows: 24,
      zIndex: 0,
      background: false,
      showCaption: true,
      clearPrevious: true,
      placement: "auto",
      placementId: PLACEMENT_ID,
      transferMode: "memory",
      passthrough: "tmux",
      placementMode: "auto",
      chunkSize: 4096,
    },
    currentCommand: {
      itemId: item.id,
      signature: `${item.id}:memory:0:tmux:4096`,
      transport: "memory",
      pngBase64: PNG_BASE64,
      filePath: undefined,
      zIndex: 0,
      passthrough: "tmux",
      chunkSize: 4096,
      rendered: undefined,
    },
  };
}

// forceUnicodePlaceholders short-circuits shouldRenderUnicodePlaceholders to the
// anchored/virtual-placement path regardless of env, so the smoke is
// deterministic on any host (no real tmux/kitty required).
const widgetOptions = { forceUnicodePlaceholders: true, forceSideOverlay: false };
const WIDTH = 48;

const state = makePreparedState();
const widget = new KittyImagePreviewWidget(state, widgetOptions);

const firstLines = widget.render(WIDTH);
const firstText = firstLines.join("\n");

const secondLines = widget.render(WIDTH);
const secondText = secondLines.join("\n");

const thirdLines = widget.render(WIDTH);
const thirdText = thirdLines.join("\n");

// Simulate a terminal (re)attach / session_start restore: the guard is reset and
// the prepared command's render memo is cleared, exactly as the extension's
// session_start handler does before re-rendering (bd-d6fa1b).
resetTransmissionGuard(state);
state.currentCommand.rendered = undefined;

const reattachLines = widget.render(WIDTH);
const reattachText = reattachLines.join("\n");

const steadyLines = widget.render(WIDTH);
const steadyText = steadyLines.join("\n");

// --- Invariants -----------------------------------------------------------

// First frame transmits the payload via a virtual (U=1) placement.
assert.match(firstText, /a=T/, "first widget render uploads the image payload");
assert.match(firstText, /U=1/, "first widget render uses a virtual (unicode) placement");

// The widget reserves a stable framed layout every frame (hline / header /
// image rows / hline). The frame must not collapse or duplicate between frames.
assert.ok(firstLines.length >= 4, "framed unicode render reserves hline/header/image/hline rows");
assert.equal(
  secondLines.length,
  firstLines.length,
  "repaint reserves the same row count (no duplicate placeholder rows)",
);
assert.equal(reattachLines.length, firstLines.length, "reattach reserves the same row count");

// Repaints at the same signature are placement-only: no re-upload.
assert.doesNotMatch(secondText, /a=T/, "repaint must not re-upload the payload");
assert.doesNotMatch(thirdText, /a=T/, "subsequent repaints stay placement-only");

// The placeholder cells still carry the placement on every frame (the image
// stays visible across repaints even though the payload is not re-sent).
assert.match(secondText, /\u{10EEEE}/u, "repaint still emits unicode placeholder cells");
assert.match(thirdText, /\u{10EEEE}/u, "subsequent repaints still emit placeholder cells");

// A reattach re-transmits so the freshly attached terminal holds the image,
// then steady state returns to placement-only.
assert.match(reattachText, /a=T/, "reattach re-transmits the payload for the new terminal");
assert.doesNotMatch(steadyText, /a=T/, "steady state after reattach returns to placement-only");

// The escape/transmit command must ride on the first emitted line only, so the
// rest of the frame is plain placeholder rows (kitty receives the upload once).
assert.match(firstLines[0], /a=T/, "the upload command rides on the first rendered line");
assert.ok(
  firstLines.slice(1).every((line) => !/a=T/.test(line)),
  "no non-first line repeats the upload command",
);

const result = {
  ok: true,
  imageId: IMAGE_ID,
  placementId: PLACEMENT_ID,
  rows: firstLines.length,
  firstUpload: /a=T/.test(firstText),
  redrawUpload: /a=T/.test(secondText),
  reattachReupload: /a=T/.test(reattachText),
  steadyAfterReattachPlacementOnly: !/a=T/.test(steadyText),
};
console.log(JSON.stringify(result, null, 2));
