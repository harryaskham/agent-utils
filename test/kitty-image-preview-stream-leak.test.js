import test from "node:test";
import assert from "node:assert/strict";

import {
  kittyPreviewImageId,
  kittyPreviewItemName,
  kittyPreviewStreamImageId,
  resolveStreamFrameId,
} from "../extensions/kitty-image-preview/id-space.js";
import {
  resolveGraphicsWriter,
  runHeadlessOwnedFree,
} from "../extensions/kitty-image-preview/display-commands.js";

// bd-ded98d element (d): screenshot streams reuse ONE stable kitty image id and
// overwrite it each frame instead of minting a fresh per-frame id (which keyed
// on path+mtime+size, transmitting under a distinct id per frame and leaving a
// superseded resident surface to reclaim).

test("kittyPreviewStreamImageId: stable across calls and equals the stream.latest preview id", () => {
  const a = kittyPreviewStreamImageId();
  const b = kittyPreviewStreamImageId();
  assert.equal(typeof a, "number", "stream image id is a numeric kitty image id");
  assert.ok(a > 0, "stream image id is a positive (non-falsy) kitty id");
  assert.equal(a, b, "the stream image id is stable across calls within a session");
  assert.equal(a, kittyPreviewImageId("stream.latest"), "reuses the namespaced stream.latest id");
});

test("kittyPreviewStreamImageId differs from per-frame item ids (so reuse is a real change)", () => {
  const streamId = kittyPreviewStreamImageId();
  const frameOne = kittyPreviewImageId(kittyPreviewItemName({ absolutePath: "/tmp/frame-a.png", mtimeMs: 1000, size: 10 }));
  const frameTwo = kittyPreviewImageId(kittyPreviewItemName({ absolutePath: "/tmp/frame-b.png", mtimeMs: 2000, size: 20 }));
  assert.notEqual(frameOne, frameTwo, "distinct per-frame inputs would otherwise mint distinct ids");
  assert.notEqual(streamId, frameOne);
  assert.notEqual(streamId, frameTwo);
});

test("resolveStreamFrameId: a stream's stable id wins over the per-frame fallback, every frame", () => {
  const stream = { imageId: kittyPreviewStreamImageId() };
  const frameA = kittyPreviewImageId(kittyPreviewItemName({ absolutePath: "/tmp/frame-a.png", mtimeMs: 1000, size: 10 }));
  const frameB = kittyPreviewImageId(kittyPreviewItemName({ absolutePath: "/tmp/frame-b.png", mtimeMs: 2000, size: 20 }));
  // Successive frames with different fallback ids still resolve to the one id.
  assert.equal(resolveStreamFrameId(stream, frameA), stream.imageId);
  assert.equal(resolveStreamFrameId(stream, frameB), stream.imageId);
});

test("resolveStreamFrameId: falls back to the per-frame id for non-stream / unseeded callers", () => {
  const fallback = 4242;
  assert.equal(resolveStreamFrameId(undefined, fallback), fallback);
  assert.equal(resolveStreamFrameId({}, fallback), fallback);
  assert.equal(resolveStreamFrameId({ imageId: undefined }, fallback), fallback);
});

// bd-ded98d element (e): a headless preview shutdown must still free the owned
// image DATA (d=I) by routing the delete through a non-UI writer, since the
// widget-based flashDeleteWidget path early-returns without a UI.

test("resolveGraphicsWriter: precedence ui.write > ui.terminal.write > terminal.write > null", () => {
  const calls = [];
  const uiWrite = { ui: { write: (c) => calls.push(["ui.write", c]) } };
  assert.equal(typeof resolveGraphicsWriter(uiWrite), "function");
  resolveGraphicsWriter(uiWrite)("x");
  assert.deepEqual(calls.at(-1), ["ui.write", "x"]);

  const uiTerm = { ui: { terminal: { write: (c) => calls.push(["ui.terminal.write", c]) } } };
  resolveGraphicsWriter(uiTerm)("y");
  assert.deepEqual(calls.at(-1), ["ui.terminal.write", "y"]);

  const term = { terminal: { write: (c) => calls.push(["terminal.write", c]) } };
  resolveGraphicsWriter(term)("z");
  assert.deepEqual(calls.at(-1), ["terminal.write", "z"]);

  assert.equal(resolveGraphicsWriter({}), null, "no reachable writer yields null");
  assert.equal(resolveGraphicsWriter(undefined), null);
});

function makeOwnedState(ids) {
  return {
    config: { passthrough: "none" },
    ownedImageIds: new Set(ids),
    transmittedSignatures: new Map(ids.map((id) => [id, "sig"])),
  };
}

test("runHeadlessOwnedFree: emits a d=I free through the non-UI writer and clears owned ids", () => {
  const written = [];
  const ctx = { hasUI: false, terminal: { write: (c) => written.push(c) } };
  const state = makeOwnedState([111, 222]);

  const command = runHeadlessOwnedFree(ctx, state);

  assert.match(command, /,d=I,|d=I/, "frees image DATA with the uppercase delete mode");
  assert.equal(written.length, 1, "routed the free through the headless writer exactly once");
  assert.equal(written[0], command);
  assert.equal(state.ownedImageIds.size, 0, "owned ids are cleared after the free");
  assert.equal(state.transmittedSignatures.has(111), false, "freed ids drop their transmit-once guard");
});

test("runHeadlessOwnedFree: no owned images means no command and no write", () => {
  const written = [];
  const ctx = { hasUI: false, terminal: { write: (c) => written.push(c) } };
  const state = makeOwnedState([]);
  const command = runHeadlessOwnedFree(ctx, state);
  assert.equal(command, "");
  assert.equal(written.length, 0, "nothing owned -> nothing emitted");
});

test("runHeadlessOwnedFree: soft-fails (no throw) when no writer is reachable", () => {
  const state = makeOwnedState([7]);
  let command;
  assert.doesNotThrow(() => {
    command = runHeadlessOwnedFree({ hasUI: false }, state);
  });
  assert.match(command, /d=I/, "still computes the free command even with no writer");
  assert.equal(state.ownedImageIds.size, 0, "still stops tracking the owned ids");
});
