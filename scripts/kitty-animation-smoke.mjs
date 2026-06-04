#!/usr/bin/env node
// Quick smoke test for kitty graphics animation.
// Usage:
//   node scripts/kitty-animation-smoke.mjs              # validate-only (no escapes)
//   KITTY_ANIMATION_SMOKE_RENDER=1 node scripts/...     # live terminal preview
//
// Emits a 40x1-cell image with frames moving left-to-right. By default it uses
// explicit a=a,c=<frame> advancement, because APNG/native s=3 loops have not
// reliably repainted in Pi/tmux sessions. Set KITTY_ANIMATION_MODE=native to
// test terminal-driven looping.
//
// By default this script does NOT write kitty APC/DCS escape sequences to
// stdout: under `npm test`, CI, or an agent terminal that would pollute the
// operator/agent screen and interact badly with concurrent kitty graphics
// content. Instead it builds the same serialized commands, asserts they are
// well-formed, and prints an escape-free summary. Set
// KITTY_ANIMATION_SMOKE_RENDER=1 (or pass --render) to opt into live rendering.

import assert from "node:assert";
import {
  buildAnimationFrameCommand,
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

function envFlagEnabled(value) {
  if (value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

const renderLive =
  process.argv.includes("--render") || envFlagEnabled(process.env.KITTY_ANIMATION_SMOKE_RENDER);

const pngs = Array.from({ length: FRAMES }, (_, i) => makeFrame(i));
const imageId = stableKittyImageId(`kitty-anim-smoke-${Date.now()}`);
const placementId = 1;

const passthrough = process.env.TMUX ? "tmux" : "none";
const nativeMode = String(process.env.KITTY_ANIMATION_MODE || "manual").toLowerCase() === "native";
const transmit = buildPngVirtualPlacementAnimation({
  imageId,
  placementId,
  pngBases: pngs.map((p) => bufferToBase64(p)),
  delaysMs: DELAY_MS,
  columns: COLS,
  rows: ROWS,
  passthrough,
  autoLoop: nativeMode,
});

const lines = buildKittyUnicodePlaceholderLines({
  imageId,
  placementId,
  columns: COLS,
  rows: ROWS,
});

const frameCommands = Array.from({ length: FRAMES }, (_, i) =>
  buildAnimationFrameCommand({ imageId, frame: i + 1, passthrough }),
);

const modeLabel = nativeMode ? "native s=3 loop" : "manual a=a,c=<frame> advancement";

if (!renderLive) {
  // Validate-only mode: assert the serialized commands are well-formed without
  // writing any escape sequences to stdout.
  assert.ok(transmit.length > 0, "transmit command should be non-empty");
  assert.match(transmit, /_G/, "transmit should contain a kitty graphics APC payload");
  assert.ok(lines.length >= ROWS, "placeholder lines should cover every image row");
  assert.ok(lines[0].length > 0, "placeholder line should be non-empty");
  assert.equal(frameCommands.length, FRAMES, "every animation frame should serialize a command");
  assert.ok(
    frameCommands.every((cmd) => cmd.length > 0),
    "each frame advancement command should be non-empty",
  );

  // Escape-free summary; safe under npm test / CI / agent terminals.
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: modeLabel,
        nativeMode,
        passthrough,
        columns: COLS,
        rows: ROWS,
        frames: FRAMES,
        delayMs: DELAY_MS,
        imageId,
        placementId,
        transmitBytes: transmit.length,
        placeholderLineBytes: lines[0].length,
        frameCommandBytes: frameCommands[1]?.length ?? 0,
        hint: "Set KITTY_ANIMATION_SMOKE_RENDER=1 (or pass --render) for a live terminal preview.",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// Live render mode: opt-in only. Writes real kitty escape sequences to stdout.
process.stdout.write("\n");
process.stdout.write(`${transmit}${lines[0]}\n`);
process.stdout.write(`\nAnimation mode: ${modeLabel}.\n`);
process.stdout.write("If you see a bright bump sweeping left-to-right across a dim bar above, the selected animation mode works.\n");
let timer;
if (!nativeMode) {
  let frame = 1;
  timer = setInterval(() => {
    frame = frame >= FRAMES ? 1 : frame + 1;
    process.stdout.write(buildAnimationFrameCommand({ imageId, frame, passthrough }));
  }, DELAY_MS);
}
await new Promise((r) => setTimeout(r, 8000));
if (timer) clearInterval(timer);
