#!/usr/bin/env node
// Quick smoke test for kitty graphics animation.
// Usage: node scripts/test-kitty-animation.mjs
// Emits a 32x16 image with 8 frames animating left-to-right and runs it as
// a virtual placement anchored to placeholder cells below.

import {
  buildKittyUnicodePlaceholderLines,
  buildPngVirtualPlacementAnimation,
  bufferToBase64,
  stableKittyImageId,
} from "../extensions/kitty-graphics.js";
import { encodeRgbaPng, makeCanvas, fillRect } from "../extensions/pi-graphics/png-renderer.js";

const COLS = 40;
const ROWS = 1;
const CELL_W = 8;
const CELL_H = 16;
const FRAMES = 24;
const DELAY_MS = 42;

function makeFrame(i) {
  const w = COLS * CELL_W;
  const h = ROWS * CELL_H;
  const px = makeCanvas(w, h, [0, 0, 0, 0]);
  // black background bar
  fillRect(px, w, 0, h / 2 - 2, w, 4, [50, 50, 70, 255]);
  // bright moving bump
  const bumpX = Math.round((i / FRAMES) * w);
  const bumpW = Math.max(4, Math.round(w * 0.1));
  fillRect(px, w, Math.max(0, bumpX - bumpW / 2), h / 2 - 4, bumpW, 8, [136, 192, 208, 255]);
  return encodeRgbaPng(px, w, h);
}

const pngs = Array.from({ length: FRAMES }, (_, i) => makeFrame(i));
const imageId = stableKittyImageId(`kitty-anim-smoke-${Date.now()}`);
const placementId = 1;

const transmit = buildPngVirtualPlacementAnimation({
  imageId,
  placementId,
  pngBases: pngs.map((p) => bufferToBase64(p)),
  delaysMs: DELAY_MS,
  columns: COLS,
  rows: ROWS,
  passthrough: process.env.TMUX ? "tmux" : "none",
});

const lines = buildKittyUnicodePlaceholderLines({
  imageId,
  placementId,
  columns: COLS,
  rows: ROWS,
});

process.stdout.write("\n");
process.stdout.write(`${transmit}${lines[0]}\n`);
process.stdout.write("\nIf you see a bright bump sweeping left-to-right across a dim bar above, kitty animation works.\nIf it shows but stays static, kitty isn't auto-playing the frames in this terminal.\n");
await new Promise((r) => setTimeout(r, 8000));
