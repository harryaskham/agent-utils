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

test("semantic provenance tags rows per block and line, inert when inactive", async () => {
  const { tagLines, tapSemanticClass, parseSemanticMarker, SEMANTIC_PREFIX } = await import("../extensions/pi-graphics/canvas/semantics.js");
  let active = true;
  class Markdown { constructor(lines, style) { this.lines = lines; this.defaultTextStyle = style; } render() { return this.lines; } }
  class Container { constructor() { this.children = []; } render(w) { return this.children.flatMap((c) => c.render(w)); } }
  class AssistantMessageComponent extends Container {
    constructor() { super(); this.contentContainer = new Container(); this.children.push(this.contentContainer); this.isStreaming = true; }
  }
  assert.equal(tapSemanticClass("AssistantMessageComponent", AssistantMessageComponent, () => active), true);
  const msg = new AssistantMessageComponent();
  msg.contentContainer.children.push(new Markdown(["think a", "think b"], { italic: true }), new Markdown(["answer"], {}));
  const lines = msg.render(40);
  const markers = lines.map(parseSemanticMarker);
  assert.deepEqual(markers.map((m) => [m.role, m.line, m.streaming]), [["thinking", 0, true], ["thinking", 1, true], ["assistant", 0, true]]);
  assert.notEqual(markers[0].block, markers[2].block);
  assert.equal(lines[0].endsWith("think a"), true);
  // Child instances are recreated while streaming: block ids stay stable by position.
  msg.contentContainer.children = [new Markdown(["think a", "think b", "think c"], { italic: true })];
  assert.equal(parseSemanticMarker(msg.render(40)[0]).block, markers[0].block);
  active = false;
  assert.deepEqual(new AssistantMessageComponent().render(40), []);
  assert.equal(tagLines(["x"], "user", "1")[0].startsWith(SEMANTIC_PREFIX), true);
});

test("effects render bounded images: heat bloom widens, glow states differ, background edges fade out", async () => {
  const { renderCaret, renderEditorGlow, renderBackground } = await import("../extensions/pi-graphics/canvas/effects.js");
  const colors = { accent: [136, 192, 208], warm: [208, 135, 112], thinking: [180, 142, 173], speech: [163, 190, 140], top: [40, 44, 52], bottom: [20, 22, 28], edge: [25, 28, 34], accent2: [180, 142, 173] };
  const ink = (img) => { let n = 0; for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] > 8) n += 1; return n; };
  const cool = renderCaret({ style: "bloom", cellWidth: 9, cellHeight: 22, heat: 0, colors });
  const hot = renderCaret({ style: "bloom", cellWidth: 9, cellHeight: 22, heat: 1, colors });
  assert.equal(cool.width, hot.width, "heat buckets share one anchor box");
  assert.ok(ink(hot) > ink(cool) * 1.5, "typing heat blooms wider");
  const idle = renderEditorGlow({ width: 200, height: 40, margin: 20, radius: 12, state: "idle", colors });
  const working = renderEditorGlow({ width: 200, height: 40, margin: 20, radius: 12, state: "working", phase: 0.25, colors });
  assert.notDeepEqual(idle.rgba, working.rgba);
  const bg = renderBackground({ width: 40, height: 30, colors, animated: true, frame: 3, frames: 24 });
  assert.equal(bg.rgba[3], 0, "corner is transparent so terminal padding shows through");
  assert.equal(bg.rgba[(15 * 40 + 20) * 4 + 3], 255);
});

test("in-band resize reports carry font-size changes into the geometry tracker", async () => {
  const { parsePixelGeometryReply } = await import("../extensions/pi-graphics/terminal-io.js");
  assert.deepEqual(parsePixelGeometryReply("\x1b[48;29;100;812;1100t"), { kind: "resize", rows: 29, cols: 100, heightPx: 812, widthPx: 1100, cellWidthPx: 11, cellHeightPx: 812 / 29 });
});

test("semantic markers carry tool kind and status flags", async () => {
  const { semanticMarker, parseSemanticMarker } = await import("../extensions/pi-graphics/canvas/semantics.js");
  const { parseAnsiLine } = await import("../extensions/pi-graphics/canvas/ansi-cells.js");
  const marker = semanticMarker("tool", "7", 2, { kind: "bash", streaming: true, error: true });
  assert.deepEqual(parseSemanticMarker(marker), { role: "tool", kind: "bash", block: "7", line: 2, streaming: true, error: true });
  assert.deepEqual(parseSemanticMarker(semanticMarker("assistant", "3.1", 0, true)), { role: "assistant", kind: "", block: "3.1", line: 0, streaming: true, error: false });
  const { cells } = parseAnsiLine(`${marker}$ ls`, 8);
  assert.equal(cells[0].sem.kind, "bash");
  assert.equal(cells[0].sem.error, true);
});

test("overlay markers expose the overlay span and detach overlay cells from the block below", async () => {
  const { semanticMarker } = await import("../extensions/pi-graphics/canvas/semantics.js");
  const { parseAnsiLine } = await import("../extensions/pi-graphics/canvas/ansi-cells.js");
  const line = `\x1b_pi:gfx:ov:4:6\x07${semanticMarker("thinking", "9", 0, false)}abcdSETTINGxyz`;
  const parsed = parseAnsiLine(line, 16);
  assert.deepEqual(parsed.overlay, { col: 4, width: 6 });
  assert.equal(parsed.cells[0].sem.role, "thinking");
  assert.equal(parsed.cells[5].sem, null, "dialog text is not thinking text");
  assert.equal(parsed.cells[11].sem.role, "thinking");
});

test("every background type loops seamlessly and renders within a frame budget", async () => {
  const { BACKGROUNDS, BACKGROUND_SCALE, renderBackground, renderActivityTint } = await import("../extensions/pi-graphics/canvas/effects.js");
  const colors = { top: [46, 52, 64], bottom: [36, 41, 51], edge: [33, 38, 46], accent: [136, 192, 208], accent2: [180, 142, 173], speech: [163, 190, 140], thinking: [180, 142, 173] };
  for (const type of BACKGROUNDS.filter((t) => t !== "transparent" && t !== "none")) {
    const scale = BACKGROUND_SCALE[type];
    const width = Math.round(1100 / scale); const height = Math.round(816 / scale);
    const a = renderBackground({ width, height, type, phase: 0, colors });
    const b = renderBackground({ width, height, type, phase: 1, colors });
    assert.equal(Buffer.compare(a.rgba, b.rgba), 0, `${type} loops`);
    const mid = renderBackground({ width, height, type, phase: 0.37, colors });
    if (type !== "static") assert.notEqual(Buffer.compare(a.rgba, mid.rgba), 0, `${type} animates`);
    assert.equal(a.rgba[3], 0, `${type} corner is transparent`);
    const started = performance.now();
    renderBackground({ width, height, type, phase: 0.5, colors });
    assert.ok(performance.now() - started < 60, `${type} frame renders quickly`);
  }
  const tint = renderActivityTint({ width: 100, height: 80, color: [180, 142, 173], level: 1 });
  let max = 0; for (let i = 3; i < tint.rgba.length; i += 4) max = Math.max(max, tint.rgba[i]);
  assert.ok(max > 10 && max < 60, `tint stays subtle (${max})`);
});

test("editor glow frames reuse cached band geometry and differ by state", async () => {
  const { renderEditorGlow } = await import("../extensions/pi-graphics/canvas/effects.js");
  const colors = { accent: [136, 192, 208], warm: [208, 135, 112], thinking: [180, 142, 173], speech: [163, 190, 140] };
  const args = { width: 400, height: 40, margin: 18, radius: 12, colors };
  const working = renderEditorGlow({ ...args, state: "working", phase: 0.2 });
  const working2 = renderEditorGlow({ ...args, state: "working", phase: 0.6 });
  const flare = renderEditorGlow({ ...args, state: "flare" });
  assert.notEqual(Buffer.compare(working.rgba, working2.rgba), 0, "travelling highlight moves");
  assert.notEqual(Buffer.compare(working.rgba, flare.rgba), 0);
  assert.equal(working.width, 400 + 36);
  const started = performance.now();
  for (let i = 0; i < 10; i += 1) renderEditorGlow({ ...args, state: "speaking", phase: i / 10 });
  assert.ok((performance.now() - started) / 10 < 8, "glow frames are cheap once the band is cached");
});

test("panel middle slices take the per-column fast path with identical pixels", async () => {
  const { renderRow } = await import("../extensions/pi-graphics/canvas/canvas-renderer.js");
  const { GlyphAtlas, resolveFontFaces } = await import("../extensions/pi-graphics/canvas/font-atlas.js");
  const { parseAnsiLine } = await import("../extensions/pi-graphics/canvas/ansi-cells.js");
  const atlas = new GlyphAtlas({ faces: resolveFontFaces({}), fontSizePx: 14, lineHeight: 1.3 });
  const theme = { fg: [229, 233, 240], bg: [46, 52, 64], accent: [136, 192, 208], selection: [90, 110, 130] };
  const { cells } = parseAnsiLine("  some text inside a translucent pane", 40);
  const panel = { start: 1, end: 39, fill: [20, 22, 28], alpha: 0.72, border: [136, 192, 208], border2: [180, 142, 173], borderAlpha: 0.85, sheen: 0.05, shadow: 0.6, stripe: [163, 190, 140], relTop: -3, relBottom: 3 };
  const ctx = { atlas, cols: 40, theme, cursorCol: -1, marginX: 9 };
  const fast = renderRow(cells, { ...ctx, panels: [panel] });
  const exact = renderRow(cells, { ...ctx, panels: [{ ...panel, exact: true }] });
  let maxDiff = 0;
  for (let i = 0; i < fast.rgba.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(fast.rgba[i] - exact.rgba[i]));
  assert.ok(maxDiff <= 2, `fast path matches the exact signed-distance render (max channel diff ${maxDiff})`);
});

test("render worker returns PNG-encoded background frames off the main thread", async () => {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(new URL("../extensions/pi-graphics/canvas/render-worker.js", import.meta.url));
  const colors = { top: [46, 52, 64], bottom: [36, 41, 51], edge: [33, 38, 46], accent: [136, 192, 208], accent2: [180, 142, 173], speech: [163, 190, 140], thinking: [180, 142, 173] };
  const reply = await new Promise((resolve, reject) => {
    worker.once("message", resolve); worker.once("error", reject);
    worker.postMessage({ id: 7, kind: "background", args: { width: 40, height: 30, type: "aurora", phase: 0.25, colors } });
  });
  await worker.terminate();
  assert.equal(reply.id, 7);
  assert.equal(reply.ok, true);
  assert.equal(reply.width, 40);
  assert.equal(Buffer.from(reply.base64, "base64").subarray(1, 4).toString(), "PNG");
});
