import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildCurrentDisplayCommand,
  resetTransmissionGuard,
} from "../extensions/kitty-image-preview/display-commands.js";

// A small, syntactically valid base64 string. The command builders only embed
// these bytes into the escape stream (they do not decode the PNG), so any
// non-empty base64 payload exercises the transmit-once path.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeState({ id = 0x01000001 } = {}) {
  return {
    config: {
      placementId: 0x800001,
      passthrough: "tmux",
    },
    currentCommand: {
      itemId: id,
      signature: "sig",
      transport: "memory",
      pngBase64: PNG_BASE64,
      filePath: undefined,
      zIndex: 0,
      passthrough: "tmux",
      chunkSize: undefined,
      rendered: undefined,
    },
  };
}

function makeItem(id = 0x01000001) {
  return { id, label: "img", width: 10, height: 20 };
}

test("cursor mode re-emits the upload command on every repaint (unchanged behavior)", () => {
  const state = makeState();
  const item = makeItem();
  const first = buildCurrentDisplayCommand(state, item, 12, 6, false);
  const second = buildCurrentDisplayCommand(state, item, 12, 6, false);
  assert.match(first, /a=T/, "cursor render uploads and places");
  // The signature memo returns the identical cursor command on repaint.
  assert.equal(second, first, "cursor repaint reuses the memoized command");
});

test("unicode mode transmits the payload exactly once per signature", () => {
  const state = makeState();
  const item = makeItem();

  const first = buildCurrentDisplayCommand(state, item, 12, 6, true);
  assert.match(first, /a=T/, "first unicode render uploads the virtual placement");
  assert.match(first, /U=1/, "first unicode render uses a virtual (U=1) placement");

  const second = buildCurrentDisplayCommand(state, item, 12, 6, true);
  assert.equal(second, "", "repaint at the same signature emits no payload (placement-only)");

  const third = buildCurrentDisplayCommand(state, item, 12, 6, true);
  assert.equal(third, "", "subsequent repaints stay placement-only");
});

test("unicode mode re-transmits when the signature changes (geometry/config)", () => {
  const state = makeState();
  const item = makeItem();

  const first = buildCurrentDisplayCommand(state, item, 12, 6, true);
  assert.match(first, /a=T/);
  // Changing the row count yields a new signature and forces a re-upload.
  const resized = buildCurrentDisplayCommand(state, item, 12, 8, true);
  assert.match(resized, /a=T/, "a new signature re-transmits the payload");
  const resizedRepaint = buildCurrentDisplayCommand(state, item, 12, 8, true);
  assert.equal(resizedRepaint, "", "repaint at the new signature is placement-only again");
});

test("resetTransmissionGuard forces a re-upload on the next unicode render", () => {
  const state = makeState();
  const item = makeItem();

  assert.match(buildCurrentDisplayCommand(state, item, 12, 6, true), /a=T/);
  assert.equal(buildCurrentDisplayCommand(state, item, 12, 6, true), "");

  // Simulate a terminal reattach / session_start restore.
  resetTransmissionGuard(state);
  // The render memo is also cleared by reset semantics; emulate a fresh frame.
  state.currentCommand.rendered = undefined;

  const afterReattach = buildCurrentDisplayCommand(state, item, 12, 6, true);
  assert.match(afterReattach, /a=T/, "reattach re-transmits so the new terminal holds the image");
  assert.equal(buildCurrentDisplayCommand(state, item, 12, 6, true), "", "steady state returns to placement-only");
});

test("a new image id transmits independently of a prior image's guard", () => {
  const state = makeState({ id: 0x01000001 });
  const first = makeItem(0x01000001);
  assert.match(buildCurrentDisplayCommand(state, first, 12, 6, true), /a=T/);
  assert.equal(buildCurrentDisplayCommand(state, first, 12, 6, true), "");

  // Switch the prepared command to a different image id (as prepareCurrentImage
  // would) and render it: it must upload on its own first frame.
  state.currentCommand.itemId = 0x01000002;
  state.currentCommand.rendered = undefined;
  const second = makeItem(0x01000002);
  assert.match(buildCurrentDisplayCommand(state, second, 12, 6, true), /a=T/, "a different image uploads on its first render");
  assert.equal(buildCurrentDisplayCommand(state, second, 12, 6, true), "", "and then stays placement-only");
});

test("kitty-image-preview wires the transmit-once guard to reattach and prepare", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../extensions/kitty-image-preview.js", import.meta.url)),
    "utf8",
  );
  // session_start is a fresh-attach signal: the guard must be reset there so the
  // newly attached terminal re-receives the payload (bd-d6fa1b).
  assert.match(source, /resetTransmissionGuard\(state\)/);
  // Re-preparing the current image (new content/transport) must drop that
  // image's stale guard entry so the next render re-uploads.
  assert.match(source, /state\.transmittedSignatures\?\.delete\?\.\(current\.id\)/);
});
