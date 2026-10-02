// `/gfx full`: an experimental full pixel canvas over the same Pi session.
//
// Pi keeps composing its fullscreen screen exactly as usual — transcript,
// overlays, selection, search, flashes, editor, footer — but at a *virtual*
// cell grid derived from a chosen font size, independent of the real
// terminal's cells. Instead of writing that frame as text, the compositor hook
// hands it to this controller, which rasterizes each row into a transparent
// pixel strip (real TrueType glyphs, vector box drawing, rounded panels,
// inline images) and places the strips as Kitty images over a gradient
// background layer. An animated caret replaces the reverse-video cursor.
//
// Usability is retained because Pi still owns the state machine:
//   * keyboard / paste / IME: untouched; the real hardware cursor is parked on
//     the real cell under the virtual caret for IME candidate placement;
//   * mouse, wheel, drag-select, links, scrollbar: SGR mouse reports are
//     remapped from real pixels (SGR-Pixels, mode 1016) or real cells to
//     virtual cells before Pi's own handlers see them, so selection and copy
//     work at canvas resolution;
//   * efficiency: strips are content-keyed and position independent, so
//     scrolling mostly re-places cached strips; only changed rows are
//     re-rasterized, zlib-compressed raw RGBA (f=32,o=z) is uploaded, and each
//     frame is one synchronized update.

import { deflateSync } from "node:zlib";

import { DEFAULT, parseAnsiLine, unpackRgb } from "./ansi-cells.js";
import { renderRow } from "./canvas-renderer.js";
import { GlyphAtlas, resolveFontFaces } from "./font-atlas.js";
import { decodePng, drawScaledImage } from "./png-decode.js";
import { addRadialGlow, encodeRgbaPng } from "../png-renderer.js";
import { fillPaths, strokeArcPath } from "./raster.js";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
const SELECTION_SENTINEL = -2;
const CHUNK = 4096;

function hexToRgb(hex, fallback = [46, 52, 64]) {
  const match = /^#?([0-9a-f]{6})/i.exec(String(hex || ""));
  if (!match) return fallback;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

function luminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function createFullCanvas({
  getTui,
  write,
  serialize,
  allocateImageId,
  z,
  themeColor,
  pixelGeometry,
  getRegions = () => ({}),
  trace = () => {},
  onStateChange = () => {},
} = {}) {
  const state = {
    active: false,
    config: { fontSizePx: 0, zoom: 1, lineHeight: 1.3, padding: 14, font: "", family: "", pixelMouse: "auto", caret: "glow", transport: process.env.PI_GRAPHICS_FULL_TRANSPORT || "png" },
    atlas: null,
    faces: null,
    terminal: null,
    untapInput: null,
    real: { cols: 80, rows: 24, cellW: 10, cellH: 20 },
    virt: { cols: 80, rows: 24 },
    stripCache: new Map(), // key -> { imageId, width, height } | null
    parseCache: new Map(), // line -> cells
    slots: new Map(), // row -> { key, imageId }
    ownedImages: new Set(),
    backgroundId: null,
    backgroundKey: "",
    caret: { id: null, key: "", from: null, to: null, start: 0, timer: null, shown: null },
    images: new Map(), // pi inline image id -> decoded
    stats: { frames: 0, uploads: 0, uploadBytes: 0, rasterMs: 0, lastFrameMs: 0 },
    theme: null,
    pixelMouse: false,
    termBg: null,
  };

  function realGeometry() {
    const terminal = state.terminal;
    const cols = Math.max(1, Number(process.stdout.columns) || Number(terminal?.__piGraphicsRealColumns) || 80);
    const rows = Math.max(1, Number(process.stdout.rows) || 24);
    const g = pixelGeometry?.geometry || {};
    const cellW = g.cellWidthPx || 10;
    const cellH = g.cellHeightPx || 20;
    return { cols, rows, cellW, cellH, width: cols * cellW, height: rows * cellH };
  }

  function computeVirtual() {
    const real = realGeometry();
    state.real = real;
    const atlas = state.atlas;
    const pad = state.config.padding;
    const cols = Math.max(20, Math.floor((real.width - pad * 2) / atlas.cellWidth));
    const rows = Math.max(6, Math.floor((real.height - pad * 2) / atlas.cellHeight));
    // Centre the grid in the canvas.
    const padX = Math.floor((real.width - cols * atlas.cellWidth) / 2);
    const padY = Math.floor((real.height - rows * atlas.cellHeight) / 2);
    const marginX = Math.max(0, Math.min(padX, Math.round(atlas.cellWidth * 1.2)));
    state.virt = { cols, rows, padX, padY, marginX };
    return state.virt;
  }

  function resolveTheme() {
    const bg = state.termBg || hexToRgb(themeColor("background") || themeColor("editorBg"), [46, 52, 64]);
    const fg = hexToRgb(themeColor("text"), luminance(bg) > 0.5 ? [40, 44, 52] : [229, 233, 240]);
    const accent = hexToRgb(themeColor("accent"), [136, 192, 208]);
    const accent2 = hexToRgb(themeColor("borderAccent"), [180, 142, 173]);
    const warm = hexToRgb(themeColor("thinkingXhigh"), [180, 142, 173]);
    const dark = luminance(bg) < 0.5;
    state.theme = {
      bg, fg, accent, accent2, warm,
      selection: mix(accent, bg, 0.35),
      surface: mix(bg, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.07 : 0.05),
      bgTop: mix(bg, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.04 : 0.02),
      bgBottom: mix(bg, [0, 0, 0], dark ? 0.28 : 0.06),
    };
    return state.theme;
  }

  // ---------------------------------------------------------------- output
  // Transport: PNG (f=100) by default. Raw RGBA + zlib (f=32,o=z) is ~15%
  // smaller and skips PNG framing, but Ghostty 1.3.1 crashes on some valid
  // zlib streams (reproduced in the Xvfb lab), so it is opt-in (transport=zlib).
  function transmitRgba(imageId, rgba, width, height) {
    const zlib = state.config.transport === "zlib";
    const payload = zlib
      ? deflateSync(rgba, { level: 1 }).toString("base64")
      : encodeRgbaPng(rgba, width, height, { level: 1 }).toString("base64");
    let out = "";
    for (let offset = 0; offset < payload.length; offset += CHUNK) {
      const more = offset + CHUNK < payload.length ? 1 : 0;
      const control = offset === 0
        ? (zlib ? { a: "t", f: 32, o: "z", s: width, v: height, i: imageId, q: 2, m: more } : { a: "t", f: 100, i: imageId, q: 2, m: more })
        : { m: more };
      out += serialize(control, payload.slice(offset, offset + CHUNK));
    }
    state.stats.uploads += 1;
    state.stats.uploadBytes += payload.length;
    state.ownedImages.add(imageId);
    return out;
  }

  function freeImage(imageId) {
    if (imageId == null) return "";
    state.ownedImages.delete(imageId);
    return serialize({ a: "d", d: "I", i: imageId, q: 2 });
  }

  function placeAtPixel(imageId, placementId, px, py, extra = {}) {
    const { cellW, cellH } = state.real;
    const col = Math.max(0, Math.floor(px / cellW));
    const row = Math.max(0, Math.floor(py / cellH));
    const X = Math.max(0, Math.round(px - col * cellW));
    const Y = Math.max(0, Math.round(py - row * cellH));
    return `\x1b[${row + 1};${col + 1}H${serialize({ a: "p", i: imageId, p: placementId, X, Y, C: 1, q: 2, ...extra })}`;
  }

  // ------------------------------------------------------------ background
  function backgroundCommands(force = false) {
    const { width, height, cols, rows } = state.real;
    const key = `${width}x${height}:${state.theme.bg.join(",")}:${state.theme.accent.join(",")}`;
    if (!force && key === state.backgroundKey && state.backgroundId != null) return "";
    let out = "";
    if (state.backgroundId != null) out += freeImage(state.backgroundId);
    // Low-resolution painterly background, scaled by the terminal (c/r).
    const bw = Math.max(16, Math.round(width / 6));
    const bh = Math.max(16, Math.round(height / 6));
    const fb = Buffer.alloc(bw * bh * 4);
    const { bgTop, bgBottom, accent, accent2 } = state.theme;
    for (let y = 0; y < bh; y += 1) {
      const c = mix(bgTop, bgBottom, y / Math.max(1, bh - 1));
      for (let x = 0; x < bw; x += 1) {
        const o = (y * bw + x) * 4;
        fb[o] = c[0]; fb[o + 1] = c[1]; fb[o + 2] = c[2]; fb[o + 3] = 255;
      }
    }
    addRadialGlow(fb, bw, bw * 0.12, bh * 0.08, Math.max(bw, bh) * 0.55, [...accent, 34], 1);
    addRadialGlow(fb, bw, bw * 0.92, bh * 0.95, Math.max(bw, bh) * 0.6, [...accent2, 30], 1);
    // Vignette.
    for (let y = 0; y < bh; y += 1) {
      for (let x = 0; x < bw; x += 1) {
        const dx = (x / bw - 0.5) * 2; const dy = (y / bh - 0.5) * 2;
        const v = Math.max(0, Math.hypot(dx * 0.85, dy) - 0.55) * 0.35;
        const o = (y * bw + x) * 4;
        fb[o] *= 1 - v; fb[o + 1] *= 1 - v; fb[o + 2] *= 1 - v;
      }
    }
    state.backgroundId = allocateImageId("background");
    state.backgroundKey = key;
    out += transmitRgba(state.backgroundId, fb, bw, bh);
    out += `\x1b[1;1H${serialize({ a: "p", i: state.backgroundId, p: 1, c: cols, r: rows, C: 1, q: 2, z: z.background })}`;
    return out;
  }

  // ------------------------------------------------------------------ caret
  function caretImage() {
    const atlas = state.atlas;
    const key = `${atlas.cellWidth}x${atlas.cellHeight}:${state.theme.accent.join(",")}:${state.config.caret}`;
    if (state.caret.key === key && state.caret.id != null) return "";
    let out = state.caret.id != null ? freeImage(state.caret.id) : "";
    const w = atlas.cellWidth * 3; const h = Math.round(atlas.cellHeight * 1.8);
    const fb = Buffer.alloc(w * h * 4);
    const cx = atlas.cellWidth; const cy = h / 2;
    if (state.config.caret !== "beam") {
      addRadialGlow(fb, w, cx + 1, cy, atlas.cellHeight * 0.95, [...state.theme.accent, 70], 1);
      addRadialGlow(fb, w, cx + 1, cy, atlas.cellHeight * 0.45, [...state.theme.accent, 90], 1);
    }
    const beamW = Math.max(2, Math.round(atlas.cellWidth * 0.2));
    const top = Math.round(cy - atlas.cellHeight * 0.46); const bottom = Math.round(cy + atlas.cellHeight * 0.46);
    fillPaths(fb, w, h, [[cx, top + 1, cx + beamW, top + 1, cx + beamW, bottom - 1, cx, bottom - 1]], ...mix(state.theme.accent, [255, 255, 255], 0.55), 255);
    fillPaths(fb, w, h, [strokeArcPath(cx + beamW / 2, top + 1, beamW / 2, Math.PI, Math.PI * 2, beamW)], ...mix(state.theme.accent, [255, 255, 255], 0.55), 255);
    state.caret.id = allocateImageId("caret");
    state.caret.key = key;
    state.caret.shown = null;
    out += transmitRgba(state.caret.id, fb, w, h);
    return out;
  }

  function caretPixel(pos) {
    const atlas = state.atlas;
    return {
      x: state.virt.padX + pos.col * atlas.cellWidth - atlas.cellWidth,
      y: state.virt.padY + pos.row * atlas.cellHeight - Math.round((atlas.cellHeight * 1.8 - atlas.cellHeight) / 2),
    };
  }

  function caretCommand(pixel) {
    if (state.caret.id == null) return "";
    if (!pixel) {
      if (!state.caret.shown) return "";
      state.caret.shown = null;
      return serialize({ a: "d", d: "i", i: state.caret.id, p: 1, q: 2 });
    }
    const rounded = { x: Math.round(pixel.x), y: Math.round(pixel.y) };
    if (state.caret.shown && state.caret.shown.x === rounded.x && state.caret.shown.y === rounded.y) return "";
    state.caret.shown = rounded;
    return placeAtPixel(state.caret.id, 1, Math.max(0, rounded.x), Math.max(0, rounded.y), { z: z.caret });
  }

  function animateCaretTo(target) {
    const caret = state.caret;
    const to = target ? caretPixel(target) : null;
    if (!to) { caret.from = null; caret.to = null; return caretCommand(null); }
    const current = caret.shown || to;
    const distance = Math.hypot(to.x - current.x, to.y - current.y);
    if (!caret.shown || distance > state.atlas.cellHeight * 6) {
      caret.from = to; caret.to = to;
      return caretCommand(to);
    }
    caret.from = { ...current }; caret.to = to; caret.start = Date.now();
    if (!caret.timer) {
      caret.timer = setInterval(() => {
        if (!state.active || !caret.to) { clearInterval(caret.timer); caret.timer = null; return; }
        const t = Math.min(1, (Date.now() - caret.start) / 90);
        const e = 1 - (1 - t) ** 3;
        const px = { x: caret.from.x + (caret.to.x - caret.from.x) * e, y: caret.from.y + (caret.to.y - caret.from.y) * e };
        const cmd = caretCommand(px);
        if (cmd) write(`\x1b7${cmd}\x1b8`);
        if (t >= 1) { clearInterval(caret.timer); caret.timer = null; }
      }, 16);
      caret.timer.unref?.();
    }
    return "";
  }

  // ------------------------------------------------------------------- rows
  function parsedRow(line) {
    const key = `${state.virt.cols}\u0000${line}`;
    let hit = state.parseCache.get(key);
    if (!hit) {
      hit = parseAnsiLine(line, state.virt.cols);
      state.parseCache.set(key, hit);
      if (state.parseCache.size > 2048) state.parseCache.delete(state.parseCache.keys().next().value);
    }
    return hit;
  }

  function bgSignature(cells, cursorCol) {
    const out = new Int32Array(cells.length);
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      out[i] = cell.inverse && i !== cursorCol ? SELECTION_SENTINEL : cell.bg;
    }
    return out;
  }

  function rawBg(cells) {
    const out = new Int32Array(cells.length);
    for (let i = 0; i < cells.length; i += 1) out[i] = cells[i].bg;
    return out;
  }

  function sigKey(arr) {
    if (!arr) return "";
    let out = ""; let prev = DEFAULT; let start = 0;
    for (let i = 0; i <= arr.length; i += 1) {
      const v = i < arr.length ? arr[i] : DEFAULT;
      if (v !== prev) { if (prev !== DEFAULT) out += `${start}-${i}:${prev};`; prev = v; start = i; }
    }
    return out;
  }

  function decodedInlineImage(image) {
    const id = image.controls.i;
    if (id && state.images.has(id)) return state.images.get(id);
    if (!image.payload) return null;
    try {
      const decoded = decodePng(Buffer.from(image.payload, "base64"));
      if (id) {
        state.images.set(id, decoded);
        if (state.images.size > 16) state.images.delete(state.images.keys().next().value);
      }
      return decoded;
    } catch { return null; }
  }

  function renderStrip(rowIndex, rows, parsed, cursor, panels, imageSlices) {
    const { cells } = parsed[rowIndex];
    const cursorCol = cursor && cursor.row === rowIndex ? cursor.col : -1;
    const colFor = (r) => (cursor && cursor.row === r ? cursor.col : -1);
    // Neighbour runs only matter (for corner rounding) when this row has its
    // own background runs; otherwise they would needlessly invalidate the row.
    const own = bgSignature(cells, cursorCol);
    const hasRuns = own.some((v) => v !== DEFAULT);
    // (bgSignature marks selection as -2 so selection runs round their
    // corners against neighbouring selected rows.)
    const above = hasRuns && rowIndex > 0 ? bgSignature(parsed[rowIndex - 1].cells, colFor(rowIndex - 1)) : null;
    const below = hasRuns && rowIndex < rows - 1 ? bgSignature(parsed[rowIndex + 1].cells, colFor(rowIndex + 1)) : null;
    const rowPanels = panels.filter((p) => rowIndex >= p.row0 && rowIndex <= p.row1).map((p) => ({
      start: p.col0, end: p.col1, fill: p.fill, alpha: p.alpha, border: p.border, borderAlpha: p.borderAlpha,
      top: rowIndex === p.row0, bottom: rowIndex === p.row1, suppressRules: p.suppressRules && (rowIndex === p.row0 || rowIndex === p.row1),
    }));
    const slice = imageSlices.get(rowIndex);
    const key = [
      state.virt.cols, parsed[rowIndex].line, cursorCol, sigKey(above), sigKey(below),
      rowPanels.map((p) => `${p.start}-${p.end}:${p.top ? 1 : 0}${p.bottom ? 1 : 0}${p.fill}:${p.alpha}`).join("|"),
      slice ? `${slice.id}:${slice.index}` : "",
    ].join("\u0001");
    const cached = state.stripCache.get(key);
    if (cached !== undefined) {
      state.stripCache.delete(key); state.stripCache.set(key, cached);
      return { key, entry: cached, upload: "" };
    }
    const started = performance.now();
    let renderCells = cells;
    if (rowPanels.some((p) => p.suppressRules)) {
      renderCells = cells.map((cell) => (cell.cp >= 0x2500 && cell.cp <= 0x257f ? { ...cell, cp: 32, ch: " " } : cell));
    }
    const strip = renderRow(renderCells, {
      atlas: state.atlas, cols: state.virt.cols, theme: state.theme, cursorCol,
      panels: rowPanels, bgAbove: above, bgBelow: below, marginX: state.virt.marginX,
      bgAboveRaw: above ? rawBg(parsed[rowIndex - 1].cells) : null,
      bgBelowRaw: below ? rawBg(parsed[rowIndex + 1].cells) : null,
    });
    if (slice) {
      const { decoded, cols, rows: imageRows, index, col } = slice;
      const cw = state.atlas.cellWidth; const ch = state.atlas.cellHeight;
      const srcH = decoded.height / imageRows;
      drawScaledImage(strip.rgba, strip.width, strip.height, decoded, state.virt.marginX + col * cw, 0, cols * cw, ch, { srcY: index * srcH, srcH });
      strip.empty = false;
    }
    state.stats.rasterMs += performance.now() - started;
    let entry = null; let upload = "";
    if (!strip.empty) {
      entry = { imageId: allocateImageId(`row-${state.stats.uploads}`), width: strip.width, height: strip.height };
      upload = transmitRgba(entry.imageId, strip.rgba, strip.width, strip.height);
    }
    state.stripCache.set(key, entry);
    return { key, entry, upload };
  }

  function evictStrips(liveKeys) {
    let out = "";
    const limit = Math.max(96, state.virt.rows * 4);
    for (const [key, entry] of state.stripCache) {
      if (state.stripCache.size <= limit) break;
      if (liveKeys.has(key)) continue;
      state.stripCache.delete(key);
      if (entry) out += freeImage(entry.imageId);
    }
    return out;
  }

  // ------------------------------------------------------------------ frame
  function onFrame(frame, { renderer }) {
    const started = performance.now();
    if (!state.active) return {};
    const rows = state.virt.rows; const cols = state.virt.cols;
    const screen = Array.isArray(renderer?.previousScreen) ? renderer.previousScreen : [];
    const cursor = frame.cursor && frame.cursor.row < rows ? frame.cursor : null;
    let out = "";
    if (frame.cleared || state.slots.size === 0) out += backgroundCommands();
    out += caretImage();
    const parsed = [];
    const imageSlices = new Map();
    for (let r = 0; r < rows; r += 1) {
      const line = screen[r] ?? "";
      const result = parsedRow(line);
      parsed.push({ line, cells: result.cells });
      if (result.image && (result.image.controls.a === "T" || result.image.controls.a === "p")) {
        const decoded = decodedInlineImage(result.image);
        const imageCols = Number(result.image.controls.c) || Math.min(cols, 40);
        const imageRows = Number(result.image.controls.r) || 8;
        if (decoded) {
          for (let k = 0; k < imageRows && r + k < rows; k += 1) {
            imageSlices.set(r + k, { decoded, id: result.image.controls.i || "anon", index: k, cols: imageCols, rows: imageRows, col: result.image.col });
          }
        }
      }
    }
    const panels = buildPanels(renderer);
    const live = new Set();
    for (let r = 0; r < rows; r += 1) {
      const { key, entry, upload } = renderStrip(r, rows, parsed, cursor, panels, imageSlices);
      live.add(key);
      out += upload;
      const slot = state.slots.get(r);
      if (slot && slot.key === key && !frame.forcePlace) continue;
      if (slot?.imageId != null && slot.imageId !== entry?.imageId) out += serialize({ a: "d", d: "i", i: slot.imageId, p: r + 1, q: 2 });
      if (entry) out += placeAtPixel(entry.imageId, r + 1, state.virt.padX - state.virt.marginX, state.virt.padY + r * state.atlas.cellHeight, { z: z.rows });
      state.slots.set(r, { key, imageId: entry?.imageId ?? null });
    }
    for (const [r, slot] of state.slots) {
      if (r < rows) continue;
      if (slot.imageId != null) out += serialize({ a: "d", d: "i", i: slot.imageId, p: r + 1, q: 2 });
      state.slots.delete(r);
    }
    out += evictStrips(live);
    out += animateCaretTo(cursor);
    // Park the real (hidden) cursor under the virtual caret for IME.
    const realCursor = cursor
      ? `\x1b[${Math.floor((state.virt.padY + cursor.row * state.atlas.cellHeight) / state.real.cellH) + 1};${Math.floor((state.virt.padX + cursor.col * state.atlas.cellWidth) / state.real.cellW) + 1}H`
      : "";
    state.stats.frames += 1;
    state.stats.lastFrameMs = performance.now() - started;
    if (out.length) trace(`canvas frame ${state.stats.frames} ms=${state.stats.lastFrameMs.toFixed(1)} bytes=${out.length} uploads=${state.stats.uploads}`);
    return { replace: out ? `${BSU}${out}${realCursor}\x1b[?25l${ESU}` : `${realCursor}` };
  }

  function buildPanels(renderer) {
    const regions = getRegions(renderer) || {};
    const panels = [];
    const theme = state.theme;
    if (regions.editor) {
      const r = regions.editor;
      panels.push({ row0: r.y, row1: r.y + r.height - 1, col0: r.x, col1: r.x + r.width, fill: theme.surface, alpha: 0.92, border: theme.accent, borderAlpha: 0.55, suppressRules: true });
    }
    if (regions.footer) {
      const r = regions.footer;
      panels.push({ row0: r.y, row1: r.y + r.height - 1, col0: r.x, col1: r.x + r.width, fill: mix(theme.surface, theme.accent, 0.08), alpha: 0.55, border: null });
    }
    return panels;
  }

  // ------------------------------------------------------------------ input
  const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
  function remapInput(data) {
    if (!state.active || typeof data !== "string") return undefined;
    const match = SGR_MOUSE_RE.exec(data);
    if (!match) return undefined;
    const atlas = state.atlas;
    let px; let py;
    if (state.pixelMouse) { px = Number(match[2]) - 1; py = Number(match[3]) - 1; }
    else { px = (Number(match[2]) - 0.5) * state.real.cellW; py = (Number(match[3]) - 0.5) * state.real.cellH; }
    const vx = Math.max(0, Math.min(state.virt.cols - 1, Math.floor((px - state.virt.padX) / atlas.cellWidth)));
    const vy = Math.max(0, Math.min(state.virt.rows - 1, Math.floor((py - state.virt.padY) / atlas.cellHeight)));
    return `\x1b[<${match[1]};${vx + 1};${vy + 1}${match[4]}`;
  }

  // -------------------------------------------------------------- lifecycle
  async function start(options = {}) {
    const tui = getTui();
    if (!tui) throw new Error("Pi TUI is not available yet");
    if (tui.mode !== "fullscreen") throw new Error("full canvas needs Pi's fullscreen TUI mode (/settings → TUI mode, or --tui-mode fullscreen)");
    if ((process.env.TMUX || /^(screen|tmux)/.test(process.env.TERM || "")) && process.env.PI_GRAPHICS_FULL_TMUX !== "1") {
      throw new Error("full canvas is disabled inside tmux (set PI_GRAPHICS_FULL_TMUX=1 to force)");
    }
    Object.assign(state.config, Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== "")));
    if (!pixelGeometry) throw new Error("pixel geometry tracker unavailable");
    const terminalWrite = (data) => write(data);
    const explicitCell = String(state.config.cell || "").match(/^(\d+)\s*[x×,]\s*(\d+)$/);
    if (explicitCell) pixelGeometry.assume(Number(explicitCell[1]), Number(explicitCell[2]));
    const geometryResult = await pixelGeometry.ensure({ write: terminalWrite, columns: process.stdout.columns, rows: process.stdout.rows });
    trace(`full canvas geometry ${JSON.stringify(geometryResult)} ${JSON.stringify(pixelGeometry.geometry)}`);
    if (!geometryResult.known) {
      const kitty = await pixelGeometry.probeKittyGraphics({ write: terminalWrite });
      const where = [process.env.TERM_PROGRAM, process.env.TERM].filter(Boolean).join(" / ") || "this terminal";
      if (!kitty.supported) {
        throw new Error(`${where} did not answer the Kitty graphics probe${kitty.reply ? ` (${kitty.reply})` : ""}, so it cannot display the canvas (needs Kitty, Ghostty or WezTerm graphics; Termux has none)`);
      }
      throw new Error(`${where} supports Kitty graphics but did not report its cell size (CSI 16 t / 14 t). Set it explicitly: /gfx full cell <width>x<height> (pixels), e.g. /gfx full cell 10x22`);
    }
    state.faces = resolveFontFaces({ family: state.config.family, regular: state.config.font || undefined });
    // DPI-independent default: size the canvas font from the terminal's real
    // (physical-pixel) cell height, then apply zoom. Explicit sizes win.
    const realCellH = pixelGeometry.geometry.cellHeightPx || 20;
    const zoom = Number(state.config.zoom) > 0 ? Number(state.config.zoom) : 1;
    const fontSizePx = Number(state.config.fontSizePx) > 0 ? Number(state.config.fontSizePx) : Math.max(8, Math.round(realCellH * 0.6 * zoom));
    state.atlas = new GlyphAtlas({ faces: state.faces, fontSizePx, lineHeight: state.config.lineHeight });
    try {
      const bg = await tui.queryTerminalBackgroundColor?.({ timeoutMs: 150 });
      if (bg && typeof bg === "object") state.termBg = [bg.r, bg.g, bg.b].map((v) => (v > 255 ? v >> 8 : v));
    } catch {}
    resolveTheme();
    const terminal = tui.terminal;
    state.terminal = terminal;
    state.active = true;
    computeVirtual();
    Object.defineProperty(terminal, "columns", { configurable: true, get: () => (state.active ? (computeVirtual(), state.virt.cols) : process.stdout.columns || 80) });
    Object.defineProperty(terminal, "rows", { configurable: true, get: () => (state.active ? state.virt.rows : process.stdout.rows || 24) });
    const termProgram = String(process.env.TERM_PROGRAM || "").toLowerCase();
    state.pixelMouse = state.config.pixelMouse === "on" || (state.config.pixelMouse === "auto"
      && (Boolean(process.env.KITTY_WINDOW_ID) || termProgram === "ghostty" || termProgram === "wezterm" || /kitty|ghostty/.test(process.env.TERM || "")));
    state.untapInput = options.tapInput?.(remapInput) || null;
    write(`${state.pixelMouse ? "\x1b[?1016h" : ""}\x1b[?25l\x1b[2J`);
    state.slots.clear();
    trace(`full canvas start real=${JSON.stringify(state.real)} virt=${JSON.stringify(state.virt)} cell=${state.atlas.cellWidth}x${state.atlas.cellHeight} font=${state.faces.regular.path} pixelMouse=${state.pixelMouse}`);
    onStateChange(true);
    try { tui.invalidate?.(); } catch {}
    try { tui.requestRender?.(true); } catch {}
    return status();
  }

  async function stop({ reason = "user" } = {}) {
    if (!state.active) return status();
    state.active = false;
    if (state.caret.timer) { clearInterval(state.caret.timer); state.caret.timer = null; }
    let out = "";
    for (const id of state.ownedImages) out += serialize({ a: "d", d: "I", i: id, q: 2 });
    state.ownedImages.clear();
    state.stripCache.clear();
    state.parseCache.clear();
    state.slots.clear();
    state.images.clear();
    state.backgroundId = null; state.backgroundKey = "";
    state.caret = { id: null, key: "", from: null, to: null, start: 0, timer: null, shown: null };
    try { state.untapInput?.(); } catch {}
    state.untapInput = null;
    const terminal = state.terminal;
    if (terminal) { delete terminal.columns; delete terminal.rows; }
    write(`${BSU}${out}${state.pixelMouse ? "\x1b[?1016l" : ""}\x1b[2J${ESU}`);
    state.pixelMouse = false;
    trace(`full canvas stop (${reason})`);
    onStateChange(false);
    const tui = getTui();
    if (reason !== "shutdown") {
      try { tui?.invalidate?.(); } catch {}
      try { tui?.requestRender?.(true); } catch {}
    }
    return status();
  }

  function onGeometry() {
    if (!state.active) return;
    state.stripCache.clear();
    state.slots.clear();
    state.backgroundKey = "";
    try { getTui()?.requestRender?.(true); } catch {}
  }

  function status() {
    return {
      active: state.active,
      font: state.faces?.regular?.path || null,
      fontSizePx: state.atlas?.fontSizePx ?? state.config.fontSizePx,
      cell: state.atlas ? `${state.atlas.cellWidth}x${state.atlas.cellHeight}` : null,
      real: state.real,
      virt: state.virt,
      pixelMouse: state.pixelMouse,
      cachedStrips: state.stripCache.size,
      stats: { ...state.stats, rasterMs: Math.round(state.stats.rasterMs), lastFrameMs: Math.round(state.stats.lastFrameMs * 10) / 10 },
    };
  }

  return {
    get active() { return state.active; },
    start,
    stop,
    onFrame,
    onGeometry,
    status,
    remapInput,
  };
}
