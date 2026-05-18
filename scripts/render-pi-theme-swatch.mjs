#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeRgbaPng, fillRect, makeCanvas, parseColor } from "../extensions/pi-graphics/png-renderer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const themePath = resolve(__dirname, "../themes/kitty-graphics.json");
const out = resolve(process.argv[2] || "./pi-kitty-theme-swatch.png");
const theme = JSON.parse(readFileSync(themePath, "utf8"));

const tokens = [
  "accent", "border", "borderAccent", "text", "muted", "selectedBg",
  "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "mdHeading",
  "mdCode", "syntaxKeyword", "syntaxFunction", "syntaxString", "thinkingHigh", "thinkingXhigh",
];

function resolveColor(token) {
  const raw = theme.colors[token];
  return theme.vars?.[raw] ?? raw;
}

const swatch = 48;
const gap = 8;
const cols = 6;
const rows = Math.ceil(tokens.length / cols);
const width = cols * swatch + (cols + 1) * gap;
const height = rows * swatch + (rows + 1) * gap;
const pixels = makeCanvas(width, height, "#02030bff");

tokens.forEach((token, index) => {
  const col = index % cols;
  const row = Math.floor(index / cols);
  const x = gap + col * (swatch + gap);
  const y = gap + row * (swatch + gap);
  const rgba = parseColor(resolveColor(token));
  fillRect(pixels, width, x, y, swatch, swatch, rgba);
  fillRect(pixels, width, x, y, swatch, 3, "#ffffffff");
  fillRect(pixels, width, x, y + swatch - 3, swatch, 3, "#000000cc");
});

const png = encodeRgbaPng(pixels, width, height);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(JSON.stringify({ out, width, height, tokens: tokens.length, bytes: png.length }, null, 2));
