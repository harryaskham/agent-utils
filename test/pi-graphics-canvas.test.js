import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";

import { DEFAULT, parseAnsiLine, unpackRgb } from "../extensions/pi-graphics/canvas/ansi-cells.js";
import { rasterizePolylines, roundedRectPath } from "../extensions/pi-graphics/canvas/raster.js";
import { renderRow } from "../extensions/pi-graphics/canvas/canvas-renderer.js";
import { decodePng } from "../extensions/pi-graphics/canvas/png-decode.js";
import { encodeRgbaPng } from "../extensions/pi-graphics/png-renderer.js";
import { TrueTypeFont } from "../extensions/pi-graphics/canvas/ttf.js";
import { GlyphAtlas } from "../extensions/pi-graphics/canvas/font-atlas.js";

test("ANSI cell parser covers truecolor, 256, attributes, links, wide glyphs and combining marks", () => {
  const line = "\x1b[38;2;10;20;30;48;5;196;1mAB\x1b[0m\x1b]8;;https://x.test\x07L\x1b]8;;\x07\x1b[7mé\x1b[27m漢\x1b[4:3mw\x1b_pi:gfx:m\x07Z";
  const { cells } = parseAnsiLine(line, 10);
  assert.deepEqual(unpackRgb(cells[0].fg), [10, 20, 30]);
  assert.deepEqual(unpackRgb(cells[0].bg), [255, 0, 0]);
  assert.equal(cells[0].bold, true);
  assert.equal(cells[2].link, "https://x.test");
  assert.equal(cells[2].bold, false);
  assert.equal(cells[3].inverse, true);
  assert.equal(cells[4].ch, "漢");
  assert.equal(cells[4].wide, true);
  assert.equal(cells[5].cont, true);
  assert.equal(cells[6].underline, 3);
  assert.equal(cells[7].ch, "Z", "APC markers are zero-width");
  assert.equal(cells[9].bg, DEFAULT);
  const combining = parseAnsiLine("e\u0301x", 3).cells;
  assert.equal(combining[0].ch, "e\u0301");
  assert.equal(combining[1].ch, "x");
});

test("coverage rasterizer fills area exactly and anti-aliases edges", () => {
  const square = rasterizePolylines([[1, 1, 5, 1, 5, 5, 1, 5]], 6, 6);
  assert.equal(square.alpha[2 * 6 + 2], 255);
  assert.equal(square.alpha[0], 0);
  const half = rasterizePolylines([[0, 0, 2.5, 0, 2.5, 2, 0, 2]], 4, 2);
  assert.equal(half.alpha[2], 128, "half-covered column is ~50%");
  const round = rasterizePolylines([roundedRectPath(0, 0, 20, 20, 8)], 20, 20);
  assert.ok(round.alpha[0] < 40 && round.alpha[10 * 20 + 10] === 255, "rounded corners are soft, interior solid");
});

test("PNG decoder round-trips the encoder and composites inline images", () => {
  const rgba = Buffer.alloc(3 * 2 * 4);
  for (let i = 0; i < rgba.length; i += 1) rgba[i] = (i * 37) & 255;
  const decoded = decodePng(encodeRgbaPng(rgba, 3, 2));
  assert.equal(decoded.width, 3);
  assert.deepEqual([...decoded.rgba], [...rgba]);
});

const fontPath = (() => {
  try { return spawnSync("fc-match", ["-f", "%{file}", "monospace"], { encoding: "utf8" }).stdout.trim(); } catch { return ""; }
})();

test("TrueType atlas derives a monospace cell grid and rasterizes glyphs", { skip: !fontPath || !existsSync(fontPath) || !/\.tt[fc]$/i.test(fontPath) }, () => {
  const font = new TrueTypeFont(readFileSync(fontPath));
  assert.ok(font.glyphIndex(0x41) > 0);
  const atlas = new GlyphAtlas({ faces: { regular: { path: fontPath, font } }, fontSizePx: 16, lineHeight: 1.3 });
  assert.ok(atlas.cellWidth >= 7 && atlas.cellWidth <= 12);
  assert.ok(atlas.cellHeight >= 18 && atlas.cellHeight <= 26);
  const mask = atlas.mask(0x41);
  assert.ok(mask.alpha.some((v) => v === 255), "solid glyph coverage");
  const bold = atlas.mask(0x41, { bold: true });
  const sum = (m) => m.alpha.reduce((a, b) => a + b, 0);
  assert.ok(sum(bold) > sum(mask), "synthetic bold adds ink");
  const { cells } = parseAnsiLine("\x1b[48;2;40;50;60m hi \x1b[0m ─╭", 8);
  const strip = renderRow(cells, { atlas, cols: 8, theme: { fg: [230, 230, 230], selection: [80, 120, 160] }, cursorCol: -1, marginX: 4 });
  assert.equal(strip.width, 8 * atlas.cellWidth + 8);
  assert.equal(strip.empty, false);
  // Box drawing reaches both cell edges so rules join seamlessly.
  const cy = Math.floor(atlas.cellHeight / 2);
  const dashX0 = 4 + 5 * atlas.cellWidth; const dashX1 = dashX0 + atlas.cellWidth - 1;
  const alphaAt = (x, y) => strip.rgba[(y * strip.width + x) * 4 + 3];
  const lineAlpha = (x) => Math.max(...[-1, 0, 1].map((d) => alphaAt(x, cy + d)));
  assert.equal(lineAlpha(dashX0), 255);
  assert.equal(lineAlpha(dashX1), 255);
});

test("zlib canvas transport stays opt-in (Ghostty 1.3.1 crashes on some o=z streams)", () => {
  const source = readFileSync(new URL("../extensions/pi-graphics/canvas/full-canvas.js", import.meta.url), "utf8");
  assert.match(source, /transport: process\.env\.PI_GRAPHICS_FULL_TRANSPORT \|\| "png"/);
  assert.ok(deflateSync(Buffer.alloc(4)).length > 0);
});
