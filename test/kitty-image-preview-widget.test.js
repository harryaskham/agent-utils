import test from "node:test";
import assert from "node:assert/strict";

import { KittyImagePreviewWidget } from "../extensions/kitty-image-preview/widget.js";
import { resetTransmissionGuard } from "../extensions/kitty-image-preview/display-commands.js";
import { shouldRenderUnicodePlaceholders } from "../extensions/kitty-image-preview/placement.js";
import { stableKittyImageId } from "../extensions/kitty-graphics.js";

// Widget-level coverage for the bd-d6fa1b transmit-once / placement-only path,
// driving KittyImagePreviewWidget.render (not buildCurrentDisplayCommand
// directly) so the contract is guarded at the widget boundary. The runnable
// counterpart is scripts/test-kitty-image-preview-widget-smoke.mjs (bd-c75d9e).

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeState() {
  const id = stableKittyImageId("agent-utils-kitty-image-preview-widget-test-image");
  const item = { id, label: "widget-test", width: 64, height: 64, path: "/tmp/widget-test.png" };
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
      placementId: stableKittyImageId("agent-utils-kitty-image-preview-widget-test-placement"),
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

// forceUnicodePlaceholders short-circuits the placement decision to the virtual
// (U=1) path regardless of env, so these tests are deterministic off-tmux.
const OPTIONS = { forceUnicodePlaceholders: true, forceSideOverlay: false };
const WIDTH = 48;

test("widget render uploads on the first frame and is placement-only on repaint", () => {
  const state = makeState();
  const widget = new KittyImagePreviewWidget(state, OPTIONS);

  const first = widget.render(WIDTH);
  const firstText = first.join("\n");
  assert.match(firstText, /a=T/, "first frame uploads the payload");
  assert.match(firstText, /U=1/, "first frame uses a virtual (unicode) placement");
  assert.match(first[0], /a=T/, "the upload rides on the first rendered line");
  assert.ok(first.slice(1).every((line) => !/a=T/.test(line)), "no later line repeats the upload");

  const second = widget.render(WIDTH);
  assert.doesNotMatch(second.join("\n"), /a=T/, "repaint must not re-upload");
  assert.equal(second.length, first.length, "repaint reserves the same row count");
  assert.match(second.join("\n"), /\u{10EEEE}/u, "repaint still emits placeholder cells");

  const third = widget.render(WIDTH);
  assert.doesNotMatch(third.join("\n"), /a=T/, "subsequent repaints stay placement-only");
});

test("a reattach (guard reset) re-transmits, then returns to placement-only", () => {
  const state = makeState();
  const widget = new KittyImagePreviewWidget(state, OPTIONS);

  assert.match(widget.render(WIDTH).join("\n"), /a=T/);
  assert.doesNotMatch(widget.render(WIDTH).join("\n"), /a=T/);

  // session_start restore: reset the guard and clear the render memo, exactly as
  // the extension's session_start handler does before re-rendering.
  resetTransmissionGuard(state);
  state.currentCommand.rendered = undefined;

  assert.match(widget.render(WIDTH).join("\n"), /a=T/, "reattach re-transmits for the new terminal");
  assert.doesNotMatch(widget.render(WIDTH).join("\n"), /a=T/, "steady state returns to placement-only");
});

test("hidden or empty widget renders nothing", () => {
  const hidden = makeState();
  hidden.visible = false;
  assert.deepEqual(new KittyImagePreviewWidget(hidden, OPTIONS).render(WIDTH), []);

  const empty = makeState();
  empty.items = [];
  assert.deepEqual(new KittyImagePreviewWidget(empty, OPTIONS).render(WIDTH), []);
});

test("stream widget locks image row count across changing frame dimensions", () => {
  const state = makeState();
  state.config.showCaption = false;
  state.stream = { running: true };
  const widget = new KittyImagePreviewWidget(state, OPTIONS);

  const first = widget.render(WIDTH);
  const lockedRows = state.stream.lockedImageRows;
  assert.ok(Number.isInteger(lockedRows) && lockedRows >= 1, "first stream render records the image row budget");

  state.items[0] = { ...state.items[0], width: 64, height: 512, label: "tall-frame" };
  state.currentCommand = { ...state.currentCommand, itemId: state.items[0].id, rendered: undefined };
  const second = widget.render(WIDTH);

  assert.equal(state.stream.lockedImageRows, lockedRows, "subsequent frames keep the original image row budget");
  assert.equal(second.length, first.length, "stream repaint reserves the same number of widget rows");
});

test("auto placement defaults to cursor on no-passthrough native Ghostty", () => {
  const state = makeState();
  state.config.passthrough = "auto";
  state.config.placementMode = "auto";
  assert.equal(shouldRenderUnicodePlaceholders(state, {
    env: { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" },
    placement: "aboveEditor",
    forceSideOverlay: false,
  }), false);
  assert.equal(shouldRenderUnicodePlaceholders(state, {
    env: { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" },
    placement: "rightOverlay",
    forceSideOverlay: true,
  }), false);
  assert.equal(shouldRenderUnicodePlaceholders(state, {
    env: { TMUX: "/tmp/tmux-1000/default,1,0", TERM: "screen-256color" },
    placement: "aboveEditor",
    forceSideOverlay: false,
  }), true);
  assert.equal(shouldRenderUnicodePlaceholders(state, {
    env: { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" },
    placement: "aboveEditor",
    forceSideOverlay: false,
    forceUnicodePlaceholders: true,
  }), true);
});
