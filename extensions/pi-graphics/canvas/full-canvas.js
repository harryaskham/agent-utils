// `/gfx full`: an experimental full pixel canvas over the same Pi session.
//
// Pi keeps composing its fullscreen screen exactly as usual — transcript,
// overlays, selection, search, flashes, editor, footer — but at a *virtual*
// cell grid derived from a chosen font size, independent of the real
// terminal's cells. The frame compositor hands that screen to this controller,
// which rasterizes rows into pixel strips (TrueType per-role fonts, vector box
// drawing, rounded panels, inline images) and places them as Kitty images
// over an (optionally animated) background, with an effects layer on top:
// a heat-driven blooming caret, keystroke impulses, an editor-card glow that
// reacts to typing / thinking / working / speech, and stream-in animation of
// newly arriving assistant / thinking glyphs.
//
// Usability is retained because Pi still owns the state machine:
//   * keyboard / paste / IME: untouched; the hidden hardware cursor is parked
//     on the real cell under the caret for IME candidate placement;
//   * mouse, wheel, drag-select, links, scrollbar: SGR mouse reports are
//     remapped from real pixels (SGR-Pixels 1016) or real cells to virtual
//     cells before Pi's handlers, so selection works at canvas resolution;
//   * semantic provenance markers (semantics.js) tell the canvas which rows
//     are thinking / user / tool / assistant text.
//
// Efficiency: row strips are content-keyed and position independent, so
// scrolling re-places cached strips; only changed rows are rasterized; each
// pass is one synchronized update; effects animate by re-placing small
// precomputed images rather than re-uploading.

import { deflateSync } from "node:zlib";

import { DEFAULT, parseAnsiLine } from "./ansi-cells.js";
import { renderRow } from "./canvas-renderer.js";
import { FontSet } from "./font-atlas.js";
import { decodePng, drawScaledImage } from "./png-decode.js";
import { addRadialGlow, encodeRgbaPng } from "../png-renderer.js";
import { blendMask } from "./raster.js";
import { mixRgb, renderBackground, renderCaret, renderEditorGlow, renderImpulse } from "./effects.js";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
const SELECTION_SENTINEL = -2;
const CHUNK = 4096;
const HEAT_BUCKETS = 8;
const GLOW_FRAMES = 16;
const BACKGROUND_FRAMES = 24;
const IMPULSE_FRAMES = 6;

export const FULL_CANVAS_DEFAULTS = Object.freeze({
  fontSizePx: 0, // 0 = auto from the real cell height
  zoom: 1,
  lineHeight: 1.3,
  padding: 14,
  fonts: {},
  resolution: 1, // supersample factor (2 = HiDPI cell-box placement)
  gamma: 1.35,
  caretStyle: "bloom",
  caretBloom: 1,
  impulse: true,
  trail: true,
  streamIn: "float",
  streamInMs: 420,
  streamRise: 2,
  streamRoles: "thinking,assistant",
  background: "aurora",
  backgroundFps: 8,
  edgeBlend: true,
  editorGlow: true,
  glowIntensity: 1,
  panels: true,
  pixelMouse: "auto",
  transport: process.env.PI_GRAPHICS_FULL_TRANSPORT || "png",
  cell: "",
  fps: 30,
});

function hexToRgb(hex, fallback = [46, 52, 64]) {
  const match = /^#?([0-9a-f]{6})/i.exec(String(hex || ""));
  if (!match) return fallback;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const pack = ([r, g, b]) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const bool = (v, fallback) => (v === undefined || v === null || v === "" ? fallback : !/^(0|false|off|no)$/i.test(String(v)));

export function createFullCanvas({
  getTui,
  write,
  serialize,
  allocateImageId,
  z,
  themeColor,
  pixelGeometry,
  getRegions = () => ({}),
  getHeat = () => 0,
  getImpulseAt = () => 0,
  getActivity = () => "idle",
  semanticTick = () => {},
  trace = () => {},
  onStateChange = () => {},
} = {}) {
  const state = {
    active: false,
    config: { ...FULL_CANVAS_DEFAULTS },
    fonts: null,
    terminal: null,
    untapInput: null,
    real: { cols: 80, rows: 24, cellW: 10, cellH: 20, width: 800, height: 480 },
    virt: { cols: 80, rows: 24, padX: 0, padY: 0, marginX: 0 },
    stripCache: new Map(),
    parseCache: new Map(),
    slots: new Map(),
    ownedImages: new Set(),
    frame: null,
    images: new Map(),
    theme: null,
    pixelMouse: false,
    termBg: null,
    edgeColorSet: false,
    background: { ids: [], key: "", index: -1, last: 0 },
    caret: { ids: new Map(), key: "", target: null, shown: null, from: null, to: null, start: 0, bucket: -1, imageId: null, anchor: null },
    impulses: [],
    impulseIds: new Map(),
    lastImpulseAt: 0,
    glow: { key: "", ids: [], index: -1, last: 0, rect: null, placed: null, state: "idle" },
    stream: { seen: new Map(), overlays: new Map(), armedAt: 0 },
    ticker: null,
    stats: { frames: 0, uploads: 0, uploadBytes: 0, rasterMs: 0, lastFrameMs: 0, ticks: 0 },
  };
  const cfg = () => state.config;
  const S = () => Math.max(1, Math.min(3, Math.trunc(Number(cfg().resolution) || 1)));

  // ------------------------------------------------------------ geometry
  function realGeometry() {
    const g = pixelGeometry?.geometry || {};
    const cols = Math.max(1, Number(process.stdout.columns) || Number(g.columns) || 80);
    const rows = Math.max(1, Number(process.stdout.rows) || Number(g.rows) || 24);
    const cellW = g.cellWidthPx || 10; const cellH = g.cellHeightPx || 20;
    return { cols, rows, cellW, cellH, width: cols * cellW, height: rows * cellH };
  }

  function computeVirtual() {
    const real = realGeometry();
    state.real = real;
    const fonts = state.fonts;
    const pad = Number(cfg().padding) || 0;
    const cols = Math.max(20, Math.floor((real.width - pad * 2) / fonts.cellWidth));
    const rows = Math.max(6, Math.floor((real.height - pad * 2) / fonts.cellHeight));
    const padX = Math.floor((real.width - cols * fonts.cellWidth) / 2);
    const padY = S() > 1
      ? Math.floor((real.rows - rows) / 2) * real.cellH // row-aligned for HiDPI boxes
      : Math.floor((real.height - rows * fonts.cellHeight) / 2);
    const marginX = Math.max(0, Math.min(padX, Math.round(fonts.cellWidth * 1.2)));
    state.virt = { cols, rows, padX, padY, marginX };
    return state.virt;
  }

  function buildFonts() {
    const realCellH = pixelGeometry?.geometry?.cellHeightPx || 20;
    const zoom = Number(cfg().zoom) > 0 ? Number(cfg().zoom) : 1;
    const fontSizePx = Number(cfg().fontSizePx) > 0 ? Number(cfg().fontSizePx) : Math.max(8, Math.round(realCellH * 0.6 * zoom));
    const fonts = { ...(cfg().fonts || {}) };
    if (cfg().font && !fonts.default) fonts.default = [cfg().font, "FiraCode Nerd Font Mono", "monospace"];
    // HiDPI (resolution > 1) places strips as cell-aligned scaled boxes. Snap
    // the line pitch to the terminal rows so every strip fills exactly one
    // row: Ghostty corrupts overlapping scaled placements, and aligned rows
    // keep strips position-independent (cacheable on scroll).
    const snap = S() > 1 ? realCellH : 0;
    state.fonts = new FontSet({ fonts, fontSizePx, lineHeight: cfg().lineHeight, gamma: cfg().gamma, supersample: S(), cellHeight: snap });
  }

  function resolveTheme() {
    const bg = state.termBg || hexToRgb(themeColor("background") || themeColor("editorBg"), [46, 52, 64]);
    const dark = luminance(bg) < 0.5;
    const fg = hexToRgb(themeColor("text"), dark ? [229, 233, 240] : [40, 44, 52]);
    const accent = hexToRgb(themeColor("accent"), [136, 192, 208]);
    const accent2 = hexToRgb(themeColor("borderAccent"), [180, 142, 173]);
    const warm = hexToRgb(themeColor("thinkingXhigh"), [208, 135, 112]);
    const thinking = hexToRgb(themeColor("thinkingText"), [180, 142, 173]);
    const speech = hexToRgb(themeColor("success"), [163, 190, 140]);
    const bottom = mixRgb(bg, [0, 0, 0], dark ? 0.28 : 0.06);
    state.theme = {
      bg, fg, accent, accent2, warm, thinking, speech,
      selection: mixRgb(accent, bg, 0.35),
      surface: mixRgb(bg, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.07 : 0.05),
      top: mixRgb(bg, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.04 : 0.02),
      bottom,
      edge: mixRgb(bg, [0, 0, 0], dark ? 0.18 : 0.04),
      headingPacked: themeColor("mdHeading") ? pack(hexToRgb(themeColor("mdHeading"))) : undefined,
      codePacked: themeColor("mdCode") ? pack(hexToRgb(themeColor("mdCode"))) : undefined,
      codeBlockPacked: themeColor("mdCodeBlock") ? pack(hexToRgb(themeColor("mdCodeBlock"))) : undefined,
    };
    return state.theme;
  }

  // -------------------------------------------------------------- output
  function transmit(imageId, rgba, width, height, { place = null } = {}) {
    const zlib = cfg().transport === "zlib";
    const payload = zlib
      ? deflateSync(rgba, { level: 1 }).toString("base64")
      : encodeRgbaPng(rgba, width, height, { level: 1 }).toString("base64");
    let out = "";
    for (let offset = 0; offset < payload.length; offset += CHUNK) {
      const more = offset + CHUNK < payload.length ? 1 : 0;
      const first = zlib ? { a: place ? "T" : "t", f: 32, o: "z", s: width, v: height } : { a: place ? "T" : "t", f: 100 };
      const control = offset === 0 ? { ...first, i: imageId, ...(place || {}), q: 2, m: more } : { m: more };
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

  function deletePlacement(imageId, placementId) {
    return imageId == null ? "" : serialize({ a: "d", d: "i", i: imageId, p: placementId, q: 2 });
  }

  function cellAt(px, py) {
    const { cellW, cellH } = state.real;
    const col = Math.max(0, Math.floor(px / cellW)); const row = Math.max(0, Math.floor(py / cellH));
    return { col, row, X: Math.max(0, Math.round(px - col * cellW)), Y: Math.max(0, Math.round(py - row * cellH)) };
  }

  /** Natural-size placement with sub-cell pixel offsets (portable at S=1). */
  function placeNatural(imageId, placementId, px, py, zIndex) {
    const at = cellAt(Math.max(0, px), Math.max(0, py));
    return `\x1b[${at.row + 1};${at.col + 1}H${serialize({ a: "p", i: imageId, p: placementId, X: at.X, Y: at.Y, C: 1, q: 2, z: zIndex })}`;
  }

  /** Cell-aligned box for HiDPI images; offsets are baked into the image. */
  function cellBox(lx, ly, lw, lh) {
    const { cellW, cellH } = state.real;
    const col0 = Math.max(0, Math.floor(lx / cellW)); const row0 = Math.max(0, Math.floor(ly / cellH));
    const offX = lx - col0 * cellW; const offY = ly - row0 * cellH;
    return { col0, row0, offX, offY, c: Math.ceil((offX + lw) / cellW), r: Math.ceil((offY + lh) / cellH) };
  }

  function boxed(rgba, width, height, box, scale) {
    const { cellW, cellH } = state.real;
    const bw = Math.round(box.c * cellW * scale); const bh = Math.round(box.r * cellH * scale);
    const out = Buffer.alloc(bw * bh * 4);
    const ox = Math.round(box.offX * scale); const oy = Math.round(box.offY * scale);
    for (let y = 0; y < height && y + oy < bh; y += 1) {
      const srcStart = y * width * 4; const len = Math.min(width, bw - ox) * 4;
      if (len > 0) rgba.copy(out, ((y + oy) * bw + ox) * 4, srcStart, srcStart + len);
    }
    return { rgba: out, width: bw, height: bh };
  }

  // ---------------------------------------------------------- background
  function backgroundCommands({ force = false } = {}) {
    const mode = cfg().background;
    if (mode === "none" || mode === "transparent") {
      if (!state.background.ids.length) return "";
      let out = "";
      for (const id of state.background.ids) out += freeImage(id);
      state.background = { ids: [], key: "", index: -1, last: 0 };
      return out;
    }
    const { width, height } = state.real;
    const animated = mode === "aurora";
    const key = `${mode}:${width}x${height}:${state.theme.bg}:${state.theme.accent}`;
    if (!force && key === state.background.key) return "";
    let out = "";
    for (const id of state.background.ids) out += freeImage(id);
    state.background = { ids: [], key, index: -1, last: 0, frames: animated ? BACKGROUND_FRAMES : 1 };
    return out + backgroundFrameCommand(0);
  }

  function backgroundFrameCommand(index) {
    const bg = state.background;
    if (!bg.key) return "";
    const { width, height, cols, rows } = state.real;
    let out = "";
    let id = bg.ids[index];
    if (id == null) {
      const bw = Math.max(16, Math.round(width / 4)); const bh = Math.max(16, Math.round(height / 4));
      const frame = renderBackground({ width: bw, height: bh, frame: index, frames: bg.frames, animated: bg.frames > 1, colors: state.theme });
      id = allocateImageId(`background-${index}`);
      bg.ids[index] = id;
      out += transmit(id, frame.rgba, frame.width, frame.height);
    }
    if (bg.index >= 0 && bg.ids[bg.index] != null && bg.index !== index) out += deletePlacement(bg.ids[bg.index], 1);
    out += `\x1b[1;1H${serialize({ a: "p", i: id, p: 1, c: cols, r: rows, C: 1, q: 2, z: z.background })}`;
    bg.index = index;
    bg.last = Date.now();
    return out;
  }

  function edgeBlendCommand() {
    if (!bool(cfg().edgeBlend, true) || cfg().background === "transparent" || cfg().background === "none") return "";
    const [r, g, b] = state.theme.edge;
    const hex = (v) => v.toString(16).padStart(2, "0");
    state.edgeColorSet = true;
    return `\x1b]11;rgb:${hex(r)}/${hex(g)}/${hex(b)}\x07`;
  }

  // ---------------------------------------------------------------- rows
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
    for (let i = 0; i < cells.length; i += 1) out[i] = cells[i].inverse && i !== cursorCol ? SELECTION_SENTINEL : cells[i].bg;
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

  function stripGeometry(rowIndex) {
    const fonts = state.fonts;
    const lx = state.virt.padX - state.virt.marginX;
    const ly = state.virt.padY + rowIndex * fonts.cellHeight;
    const lw = state.virt.cols * fonts.cellWidth + state.virt.marginX * 2;
    return { lx, ly, lw, lh: fonts.cellHeight };
  }

  function renderStrip(rowIndex) {
    const frame = state.frame;
    const { cells, line } = frame.parsed[rowIndex];
    const cursor = frame.cursor;
    const rows = frame.parsed.length;
    const cursorCol = cursor && cursor.row === rowIndex ? cursor.col : -1;
    const colFor = (r) => (cursor && cursor.row === r ? cursor.col : -1);
    const own = bgSignature(cells, cursorCol);
    const hasRuns = own.some((v) => v !== DEFAULT);
    const above = hasRuns && rowIndex > 0 ? bgSignature(frame.parsed[rowIndex - 1].cells, colFor(rowIndex - 1)) : null;
    const below = hasRuns && rowIndex < rows - 1 ? bgSignature(frame.parsed[rowIndex + 1].cells, colFor(rowIndex + 1)) : null;
    const rowPanels = frame.panels.filter((p) => rowIndex >= p.row0 && rowIndex <= p.row1).map((p) => ({
      start: p.col0, end: p.col1, fill: p.fill, alpha: p.alpha, border: p.border, borderAlpha: p.borderAlpha,
      top: rowIndex === p.row0, bottom: rowIndex === p.row1, suppressRules: p.suppressRules && (rowIndex === p.row0 || rowIndex === p.row1),
    }));
    const regionRole = frame.regionRoles.get(rowIndex) || null;
    const slice = frame.imageSlices.get(rowIndex);
    const hidden = state.stream.overlays.get(rowIndex)?.hidden || null;
    const scale = S();
    const geo = stripGeometry(rowIndex);
    const box = scale > 1 ? cellBox(geo.lx, geo.ly, geo.lw, geo.lh) : null;
    const key = [
      state.virt.cols, line, cursorCol, sigKey(above), sigKey(below), regionRole || "",
      rowPanels.map((p) => `${p.start}-${p.end}:${p.top ? 1 : 0}${p.bottom ? 1 : 0}${p.fill}:${p.alpha}`).join("|"),
      slice ? `${slice.id}:${slice.index}` : "",
      hidden ? [...hidden].join(",") : "",
      box ? `${scale}:${box.offX.toFixed(1)}:${box.offY.toFixed(1)}:${box.c}x${box.r}` : "",
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
      fonts: state.fonts, cols: state.virt.cols, theme: state.theme, cursorCol, scale,
      panels: rowPanels, bgAbove: above, bgBelow: below, marginX: state.virt.marginX,
      bgAboveRaw: above ? rawBg(frame.parsed[rowIndex - 1].cells) : null,
      bgBelowRaw: below ? rawBg(frame.parsed[rowIndex + 1].cells) : null,
      regionRole, hiddenCols: hidden,
    });
    if (slice) {
      const cw = state.fonts.cellWidth * scale; const ch = state.fonts.cellHeight * scale;
      const srcH = slice.decoded.height / slice.rows;
      drawScaledImage(strip.rgba, strip.width, strip.height, slice.decoded, state.virt.marginX * scale + slice.col * cw, 0, slice.cols * cw, ch, { srcY: slice.index * srcH, srcH });
      strip.empty = false;
    }
    state.stats.rasterMs += performance.now() - started;
    let entry = null; let upload = "";
    if (!strip.empty) {
      const image = box ? boxed(strip.rgba, strip.width, strip.height, box, scale) : strip;
      entry = { imageId: allocateImageId(`row-${state.stats.uploads}`), box };
      upload = transmit(entry.imageId, image.rgba, image.width, image.height);
    }
    state.stripCache.set(key, entry);
    return { key, entry, upload };
  }

  function placeRow(rowIndex, entry) {
    if (entry.box) {
      const b = entry.box;
      return `\x1b[${b.row0 + 1};${b.col0 + 1}H${serialize({ a: "p", i: entry.imageId, p: rowIndex + 1, c: b.c, r: b.r, C: 1, q: 2, z: z.rows })}`;
    }
    const geo = stripGeometry(rowIndex);
    return placeNatural(entry.imageId, rowIndex + 1, geo.lx, geo.ly, z.rows);
  }

  function updateRow(rowIndex, force = false) {
    const { key, entry, upload } = renderStrip(rowIndex);
    let out = upload;
    const slot = state.slots.get(rowIndex);
    if (slot && slot.key === key && !force) return { out, key };
    if (slot?.imageId != null && slot.imageId !== entry?.imageId) out += deletePlacement(slot.imageId, rowIndex + 1);
    if (entry) out += placeRow(rowIndex, entry);
    state.slots.set(rowIndex, { key, imageId: entry?.imageId ?? null });
    return { out, key };
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

  // ------------------------------------------------------------- stream-in
  const streamRoles = () => new Set(String(cfg().streamRoles || "").split(/[\s,]+/).filter(Boolean));

  function trackStreamIn(now) {
    const effect = cfg().streamIn;
    const stream = state.stream;
    if (effect === "none" || !effect) { stream.overlays.clear(); return; }
    const roles = streamRoles();
    const duration = Math.max(60, Number(cfg().streamInMs) || 420);
    const armed = now >= stream.armedAt;
    const seenNow = new Set();
    state.frame.parsed.forEach(({ cells }, rowIndex) => {
      const sem = cells.find((cell) => cell.sem)?.sem;
      if (!sem || !roles.has(sem.role)) return;
      const id = `${sem.block}:${sem.line}`;
      seenNow.add(id);
      let entry = stream.seen.get(id);
      if (!entry) { entry = { chars: [], born: [] }; stream.seen.set(id, entry); if (!sem.streaming) entry.static = true; }
      for (let col = 0; col < cells.length; col += 1) {
        const ch = cells[col].cont ? "" : cells[col].ch;
        if (entry.chars[col] !== ch) {
          entry.chars[col] = ch;
          entry.born[col] = armed && sem.streaming && !entry.static && ch.trim() ? now : 0;
        }
      }
      if (sem.streaming) entry.static = false;
      const hidden = new Set();
      for (let col = 0; col < cells.length; col += 1) if (entry.born[col] && now - entry.born[col] < duration) hidden.add(col);
      if (hidden.size) stream.overlays.set(rowIndex, { ...(stream.overlays.get(rowIndex) || {}), hidden, id, sem });
      else if (stream.overlays.has(rowIndex)) stream.overlays.get(rowIndex).hidden = null;
    });
    if (stream.seen.size > 4096) {
      for (const key of stream.seen.keys()) { if (stream.seen.size <= 2048) break; if (!seenNow.has(key)) stream.seen.delete(key); }
    }
  }

  function streamOverlayCommands(now) {
    const stream = state.stream;
    if (!stream.overlays.size) return "";
    const duration = Math.max(60, Number(cfg().streamInMs) || 420);
    const rise = cfg().streamIn === "float" ? Math.max(0, Math.min(6, Number(cfg().streamRise) || 0)) : 0;
    const fonts = state.fonts; const cw = fonts.cellWidth; const ch = fonts.cellHeight;
    let out = "";
    for (const [rowIndex, overlay] of stream.overlays) {
      const entry = stream.seen.get(overlay.id);
      const parsed = state.frame?.parsed[rowIndex];
      const live = overlay.hidden && entry && parsed ? [...overlay.hidden].filter((col) => entry.born[col] && now - entry.born[col] < duration) : [];
      if (!live.length) {
        if (overlay.imageId != null) out += freeImage(overlay.imageId);
        stream.overlays.delete(rowIndex);
        if (overlay.hidden) {
          overlay.hidden = null;
          out += updateRow(rowIndex, true).out; // bake the landed glyphs back into the row
        }
        continue;
      }
      const minCol = Math.min(...live); const maxCol = Math.max(...live) + 1;
      const pad = cw; const w = (maxCol - minCol + 1) * cw + pad * 2; const h = (rise + 1) * ch;
      const fb = Buffer.alloc(w * h * 4);
      for (const col of live) {
        const cell = parsed.cells[col];
        const t = Math.min(1, (now - entry.born[col]) / duration);
        const e = 1 - (1 - t) ** 3;
        const alpha = Math.round(255 * Math.min(1, t * 1.8) * (cell.dim ? 0.6 : 1));
        const atlas = fonts.forRole(cell.sem?.role === "thinking" ? "thinking" : null);
        const scaleDown = atlas.supersample > 1;
        const mask = scaleDown ? null : atlas.mask(cell.cp, { bold: cell.bold, italic: cell.italic, cells: cell.wide ? 2 : 1 });
        const fg = cell.fg === DEFAULT ? state.theme.fg : [(cell.fg >> 16) & 255, (cell.fg >> 8) & 255, cell.fg & 255];
        const x = pad + (col - minCol) * cw;
        const y = Math.round(rise * ch * (1 - e));
        if (t < 0.6) addRadialGlow(fb, w, x + cw / 2, y + ch / 2, ch * 0.55, [...mixRgb(fg, state.theme.accent, 0.4), Math.round(42 * (1 - t / 0.6))], 1);
        if (mask) blendMask(fb, w, h, mask, x + mask.left, y + mask.top, ...fg, alpha);
      }
      if (overlay.imageId == null) overlay.imageId = allocateImageId(`stream-${rowIndex}`);
      const px = state.virt.padX + minCol * cw - pad; const py = state.virt.padY + (rowIndex - rise) * ch;
      const at = cellAt(Math.max(0, px), Math.max(0, py));
      out += `\x1b[${at.row + 1};${at.col + 1}H`;
      out += transmit(overlay.imageId, fb, w, h, { place: { p: 1, X: at.X, Y: at.Y, C: 1, z: z.overlay } });
    }
    return out;
  }

  // ----------------------------------------------------------------- caret
  function caretImageFor(bucket) {
    const caret = state.caret;
    const fonts = state.fonts;
    const key = `${cfg().caretStyle}:${cfg().caretBloom}:${fonts.cellWidth}x${fonts.cellHeight}:${state.theme.accent}:${state.theme.warm}`;
    let out = "";
    if (caret.key !== key) {
      for (const id of caret.ids.values()) out += freeImage(id);
      caret.ids.clear(); caret.key = key; caret.shown = null; caret.imageId = null;
    }
    let id = caret.ids.get(bucket);
    if (id == null) {
      const img = renderCaret({ style: cfg().caretStyle, cellWidth: fonts.cellWidth, cellHeight: fonts.cellHeight, heat: bucket / (HEAT_BUCKETS - 1), bloom: cfg().caretBloom, colors: state.theme });
      id = allocateImageId(`caret-${bucket}`);
      caret.ids.set(bucket, id);
      caret.anchor = { x: img.anchorX, y: img.anchorY };
      out += transmit(id, img.rgba, img.width, img.height);
    }
    return { id, out };
  }

  function caretPixel(pos) {
    return { x: state.virt.padX + pos.col * state.fonts.cellWidth, y: state.virt.padY + pos.row * state.fonts.cellHeight };
  }

  function caretCommands(now) {
    const caret = state.caret;
    if (cfg().caretStyle === "off") return caret.imageId != null && caret.shown ? (caret.shown = null, deletePlacement(caret.imageId, 1)) : "";
    const heat = Math.max(0, Math.min(1, Number(getHeat()) || 0));
    const bucket = Math.round(heat * (HEAT_BUCKETS - 1));
    const target = caret.target ? caretPixel(caret.target) : null;
    let pos = target;
    if (target && bool(cfg().trail, true) && caret.to && caret.from && (caret.to.x !== target.x || caret.to.y !== target.y)) {
      const current = caret.shown || target;
      if (Math.hypot(target.x - current.x, target.y - current.y) < state.fonts.cellHeight * 6) { caret.from = { ...current }; caret.start = now; }
      else caret.from = target;
      caret.to = target;
    } else if (target && (!caret.to || !caret.from)) { caret.from = target; caret.to = target; caret.start = now; }
    if (target && caret.from && caret.to) {
      const t = Math.min(1, (now - caret.start) / 90);
      const e = 1 - (1 - t) ** 3;
      pos = { x: caret.from.x + (caret.to.x - caret.from.x) * e, y: caret.from.y + (caret.to.y - caret.from.y) * e };
    }
    let out = "";
    if (!pos) {
      if (caret.shown && caret.imageId != null) out += deletePlacement(caret.imageId, 1);
      caret.shown = null;
      return out;
    }
    const image = caretImageFor(bucket);
    out += image.out;
    const anchor = caret.anchor || { x: 0, y: 0 };
    const px = Math.round(pos.x - anchor.x); const py = Math.round(pos.y - anchor.y);
    if (caret.shown && caret.shown.x === px && caret.shown.y === py && caret.imageId === image.id) return out;
    if (caret.imageId != null && caret.imageId !== image.id) out += deletePlacement(caret.imageId, 1);
    // Clip by cropping at the canvas origin: placements cannot start off-screen.
    out += placeCropped(image.id, 1, px, py, z.caret);
    caret.imageId = image.id;
    caret.shown = { x: px, y: py };
    return out;
  }

  function placeCropped(imageId, placementId, px, py, zIndex) {
    const cropX = Math.max(0, -px); const cropY = Math.max(0, -py);
    const at = cellAt(Math.max(0, px), Math.max(0, py));
    const control = { a: "p", i: imageId, p: placementId, X: at.X, Y: at.Y, C: 1, q: 2, z: zIndex };
    if (cropX || cropY) Object.assign(control, { x: cropX, y: cropY });
    return `\x1b[${at.row + 1};${at.col + 1}H${serialize(control)}`;
  }

  function impulseCommands(now) {
    let out = "";
    const impulseAt = Number(getImpulseAt()) || 0;
    if (bool(cfg().impulse, true) && impulseAt > state.lastImpulseAt && state.caret.target && cfg().caretStyle !== "off") {
      state.lastImpulseAt = impulseAt;
      if (now - impulseAt < 150 && state.impulses.length < 4) {
        state.impulses.push({ at: caretPixel(state.caret.target), start: now, slot: (state.stats.ticks % 4) + 1, frame: -1, imageId: null });
      }
    }
    const fonts = state.fonts;
    state.impulses = state.impulses.filter((impulse) => {
      const frame = Math.floor((now - impulse.start) / 32);
      if (frame >= IMPULSE_FRAMES) {
        if (impulse.imageId != null) out += deletePlacement(impulse.imageId, impulse.slot);
        return false;
      }
      if (frame === impulse.frame) return true;
      const variant = impulse.slot % 3;
      const key = `${frame}:${variant}:${fonts.cellWidth}x${fonts.cellHeight}:${state.theme.accent}`;
      let id = state.impulseIds.get(key);
      let anchor;
      if (id == null) {
        const img = renderImpulse({ cellWidth: fonts.cellWidth, cellHeight: fonts.cellHeight, frame, frames: IMPULSE_FRAMES, colors: state.theme, seed: variant + 1 });
        id = allocateImageId(`impulse-${key}`);
        state.impulseIds.set(key, id);
        out += transmit(id, img.rgba, img.width, img.height);
      }
      anchor = { x: Math.floor(9 / 2) * fonts.cellWidth, y: Math.floor(5 / 2) * fonts.cellHeight };
      if (impulse.imageId != null && impulse.imageId !== id) out += deletePlacement(impulse.imageId, impulse.slot);
      out += placeCropped(id, impulse.slot, Math.round(impulse.at.x - anchor.x), Math.round(impulse.at.y - anchor.y), z.overlay);
      impulse.imageId = id; impulse.frame = frame;
      return true;
    });
    return out;
  }

  // ------------------------------------------------------------- editor glow
  function glowCommands(now, { force = false } = {}) {
    const glow = state.glow;
    const rect = state.frame?.glowRect;
    if (!bool(cfg().editorGlow, true) || !rect) {
      if (glow.placed) { const out = deletePlacement(glow.placed, 1); glow.placed = null; return out; }
      return "";
    }
    const heat = Math.max(0, Math.min(1, Number(getHeat()) || 0));
    let activity = getActivity() || "idle";
    if (activity === "idle" && heat > 0.12) activity = "typing";
    const heatBucket = activity === "typing" ? Math.round(heat * (HEAT_BUCKETS - 1)) : 0;
    const key = `${activity}:${heatBucket}:${rect.x},${rect.y},${rect.w}x${rect.h}:${state.theme.accent}:${cfg().glowIntensity}`;
    let out = "";
    if (glow.key !== key) {
      for (const id of glow.ids) if (id != null) out += freeImage(id);
      glow.ids = []; glow.key = key; glow.index = -1; glow.placed = null; glow.state = activity; glow.rect = rect;
    }
    const animated = activity !== "typing";
    const fps = activity === "working" ? 14 : activity === "speaking" ? 16 : 8;
    const frames = animated ? GLOW_FRAMES : 1;
    if (!force && glow.index >= 0 && (!animated || now - glow.last < 1000 / fps)) return out;
    const index = (glow.index + 1) % frames;
    let id = glow.ids[index];
    const margin = Math.round(state.fonts.cellWidth * 2.2);
    if (id == null) {
      const img = renderEditorGlow({ width: rect.w, height: rect.h, margin, radius: Math.round(state.fonts.cellHeight * 0.7), state: activity, phase: index / frames, heat, colors: state.theme, intensity: cfg().glowIntensity });
      id = allocateImageId(`glow-${index}`);
      glow.ids[index] = id;
      out += transmit(id, img.rgba, img.width, img.height);
    }
    if (glow.placed != null && glow.placed !== id) out += deletePlacement(glow.placed, 1);
    out += placeCropped(id, 1, Math.round(rect.x - margin), Math.round(rect.y - margin), z.glow);
    glow.placed = id; glow.index = index; glow.last = now;
    return out;
  }

  // ------------------------------------------------------------------ ticker
  function animating(now) {
    const caret = state.caret;
    if (caret.to && caret.from && now - caret.start < 120) return true;
    if (state.impulses.length || state.stream.overlays.size) return true;
    if (bool(cfg().editorGlow, true) && state.frame?.glowRect) return true;
    if (cfg().background === "aurora") return true;
    return Number(getHeat()) > 0.01;
  }

  function tick() {
    if (!state.active || !state.frame) return;
    const now = Date.now();
    state.stats.ticks += 1;
    let out = caretCommands(now) + impulseCommands(now) + streamOverlayCommands(now) + glowCommands(now);
    if (state.background.frames > 1 && now - state.background.last >= 1000 / Math.max(1, Number(cfg().backgroundFps) || 8)) {
      out += backgroundFrameCommand((state.background.index + 1) % state.background.frames);
    }
    if (out) write(`${BSU}\x1b7${out}\x1b8${ESU}`);
    if (!animating(now)) stopTicker();
  }

  function wake() {
    if (state.ticker || !state.active) return;
    const fps = Math.max(5, Math.min(60, Number(cfg().fps) || 30));
    state.ticker = setInterval(tick, Math.round(1000 / fps));
    state.ticker.unref?.();
  }
  function stopTicker() { if (state.ticker) { clearInterval(state.ticker); state.ticker = null; } }

  // ------------------------------------------------------------------ frame
  function buildRegions(renderer) {
    const regions = getRegions(renderer) || {};
    const panels = [];
    const regionRoles = new Map();
    const theme = state.theme;
    const fonts = state.fonts;
    let glowRect = null;
    const panelsOn = bool(cfg().panels, true);
    if (regions.editor) {
      const r = regions.editor;
      if (panelsOn) panels.push({ row0: r.y, row1: r.y + r.height - 1, col0: r.x, col1: r.x + r.width, fill: theme.surface, alpha: 0.92, border: theme.accent, borderAlpha: 0.55, suppressRules: true });
      for (let row = r.y; row < r.y + r.height; row += 1) regionRoles.set(row, "editor");
      const inset = Math.min(state.virt.marginX, Math.round(fonts.cellWidth * 0.8));
      glowRect = {
        x: state.virt.padX + r.x * fonts.cellWidth - inset,
        y: state.virt.padY + r.y * fonts.cellHeight + Math.round(fonts.cellHeight * 0.45),
        w: r.width * fonts.cellWidth + inset * 2,
        h: (r.height - 1) * fonts.cellHeight + Math.round(fonts.cellHeight * 0.1),
      };
    }
    if (regions.footer) {
      const r = regions.footer;
      if (panelsOn) panels.push({ row0: r.y, row1: r.y + r.height - 1, col0: r.x, col1: r.x + r.width, fill: mixRgb(theme.surface, theme.accent, 0.08), alpha: 0.55, border: null });
      for (let row = r.y; row < r.y + r.height; row += 1) regionRoles.set(row, "footer");
    }
    return { panels, regionRoles, glowRect };
  }

  function onFrame(frame, { renderer }) {
    const started = performance.now();
    if (!state.active) return {};
    try { semanticTick(); } catch {}
    const rows = state.virt.rows; const cols = state.virt.cols;
    const screen = Array.isArray(renderer?.previousScreen) ? renderer.previousScreen : [];
    const cursor = frame.cursor && frame.cursor.row < rows ? frame.cursor : null;
    let out = "";
    if (frame.cleared || state.slots.size === 0) out += backgroundCommands();
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
    const regions = buildRegions(renderer);
    state.frame = { parsed, cursor, imageSlices, ...regions };
    const now = Date.now();
    trackStreamIn(now);
    const live = new Set();
    for (let r = 0; r < rows; r += 1) {
      const { out: rowOut, key } = updateRow(r, frame.cleared);
      out += rowOut;
      live.add(key);
    }
    for (const [r, slot] of state.slots) {
      if (r < rows) continue;
      out += deletePlacement(slot.imageId, r + 1);
      state.slots.delete(r);
    }
    out += evictStrips(live);
    state.caret.target = cursor;
    out += caretCommands(now) + impulseCommands(now) + streamOverlayCommands(now) + glowCommands(now, { force: frame.cleared });
    const realCursor = cursor
      ? (() => { const p = caretPixel(cursor); const at = cellAt(p.x, p.y); return `\x1b[${at.row + 1};${at.col + 1}H`; })()
      : "";
    state.stats.frames += 1;
    state.stats.lastFrameMs = performance.now() - started;
    if (out.length) trace(`canvas frame ${state.stats.frames} ms=${state.stats.lastFrameMs.toFixed(1)} bytes=${out.length} uploads=${state.stats.uploads}`);
    if (animating(now)) wake();
    return { replace: out ? `${BSU}${out}${realCursor}\x1b[?25l${ESU}` : realCursor };
  }

  // ------------------------------------------------------------------ input
  const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
  function remapInput(data) {
    if (!state.active || typeof data !== "string") return undefined;
    const match = SGR_MOUSE_RE.exec(data);
    if (!match) return undefined;
    let px; let py;
    if (state.pixelMouse) { px = Number(match[2]) - 1; py = Number(match[3]) - 1; }
    else { px = (Number(match[2]) - 0.5) * state.real.cellW; py = (Number(match[3]) - 0.5) * state.real.cellH; }
    const vx = Math.max(0, Math.min(state.virt.cols - 1, Math.floor((px - state.virt.padX) / state.fonts.cellWidth)));
    const vy = Math.max(0, Math.min(state.virt.rows - 1, Math.floor((py - state.virt.padY) / state.fonts.cellHeight)));
    return `\x1b[<${match[1]};${vx + 1};${vy + 1}${match[4]}`;
  }

  // -------------------------------------------------------------- lifecycle
  function freeEverything() {
    let out = "";
    for (const id of state.ownedImages) out += serialize({ a: "d", d: "I", i: id, q: 2 });
    state.ownedImages.clear();
    state.stripCache.clear();
    state.parseCache.clear();
    state.slots.clear();
    state.images.clear();
    state.background = { ids: [], key: "", index: -1, last: 0 };
    state.caret = { ids: new Map(), key: "", target: null, shown: null, from: null, to: null, start: 0, bucket: -1, imageId: null, anchor: null };
    state.impulses = [];
    state.impulseIds.clear();
    state.glow = { key: "", ids: [], index: -1, last: 0, rect: null, placed: null, state: "idle" };
    state.stream.overlays.clear();
    return out;
  }

  async function start(options = {}) {
    const tui = getTui();
    if (!tui) throw new Error("Pi TUI is not available yet");
    if (tui.mode !== "fullscreen") throw new Error("full canvas needs Pi's fullscreen TUI mode (/settings → TUI mode, or --tui-mode fullscreen)");
    if ((process.env.TMUX || /^(screen|tmux)/.test(process.env.TERM || "")) && process.env.PI_GRAPHICS_FULL_TMUX !== "1") {
      throw new Error("full canvas is disabled inside tmux (set PI_GRAPHICS_FULL_TMUX=1 to force)");
    }
    const { tapInput, ...rest } = options;
    state.config = { ...FULL_CANVAS_DEFAULTS, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== "")) };
    if (!pixelGeometry) throw new Error("pixel geometry tracker unavailable");
    const terminalWrite = (data) => write(data);
    const explicitCell = String(cfg().cell || "").match(/^(\d+)\s*[x×,]\s*(\d+)$/);
    if (explicitCell) pixelGeometry.assume(Number(explicitCell[1]), Number(explicitCell[2]));
    const geometryResult = await pixelGeometry.ensure({ write: terminalWrite, columns: process.stdout.columns, rows: process.stdout.rows });
    trace(`full canvas geometry ${JSON.stringify(geometryResult)} ${JSON.stringify(pixelGeometry.geometry)}`);
    if (!geometryResult.known) {
      const kitty = await pixelGeometry.probeKittyGraphics({ write: terminalWrite });
      const where = [process.env.TERM_PROGRAM, process.env.TERM].filter(Boolean).join(" / ") || "this terminal";
      if (!kitty.supported) throw new Error(`${where} did not answer the Kitty graphics probe${kitty.reply ? ` (${kitty.reply})` : ""}, so it cannot display the canvas (needs Kitty, Ghostty or WezTerm graphics; Termux has none)`);
      throw new Error(`${where} supports Kitty graphics but did not report its cell size (CSI 16 t / 14 t). Set it explicitly: /gfx full cell <width>x<height> (pixels), e.g. /gfx full cell 10x22`);
    }
    const terminalName = String(await pixelGeometry.probeTerminalName?.({ write: terminalWrite }) || "").toLowerCase();
    const envName = `${process.env.TERM_PROGRAM || ""} ${process.env.TERM || ""} ${process.env.KITTY_WINDOW_ID ? "kitty" : ""}`.toLowerCase();
    const isGhostty = /ghostty/.test(terminalName || envName);
    state.terminalName = terminalName || envName.trim() || "unknown";
    state.notes = [];
    if (S() > 1 && isGhostty && process.env.PI_GRAPHICS_FULL_HIDPI_FORCE !== "1") {
      // Ghostty 1.3.1 leaves stale pixels when scaled (c/r) placements are
      // replaced during scrolling (reproduced in the lab; Kitty is correct).
      state.config.resolution = 1;
      state.notes.push("resolution forced to 1 on Ghostty (scaled-placement repaint bug); PI_GRAPHICS_FULL_HIDPI_FORCE=1 overrides");
    }
    buildFonts();
    try {
      const bg = await tui.queryTerminalBackgroundColor?.({ timeoutMs: 150 });
      if (bg && typeof bg === "object" && !state.edgeColorSet) state.termBg = [bg.r, bg.g, bg.b].map((v) => (v > 255 ? v >> 8 : v));
    } catch {}
    resolveTheme();
    const terminal = tui.terminal;
    state.terminal = terminal;
    state.active = true;
    computeVirtual();
    Object.defineProperty(terminal, "columns", { configurable: true, get: () => (state.active ? (computeVirtual(), state.virt.cols) : process.stdout.columns || 80) });
    Object.defineProperty(terminal, "rows", { configurable: true, get: () => (state.active ? state.virt.rows : process.stdout.rows || 24) });
    // SGR-Pixels mouse only when the terminal that answers is one known to
    // support it; a multiplexer (herdr/tmux) answering XTVERSION keeps cells.
    const pixelCapable = /kitty|ghostty|wezterm/.test(terminalName || envName);
    state.pixelMouse = cfg().pixelMouse === "on" || (cfg().pixelMouse === "auto" && pixelCapable);
    state.untapInput = tapInput?.(remapInput) || null;
    state.stream.armedAt = Date.now() + 600;
    // Mouse pixels, in-band resize reports (font-size changes), hide cursor,
    // clear, and blend the terminal padding into the canvas edge colour.
    write(`${state.pixelMouse ? "\x1b[?1016h" : ""}\x1b[?2048h\x1b[?25l\x1b[2J${edgeBlendCommand()}`);
    state.slots.clear();
    process.stdout.on?.("resize", onStdoutResize);
    trace(`full canvas start real=${JSON.stringify(state.real)} virt=${JSON.stringify(state.virt)} cell=${state.fonts.cellWidth}x${state.fonts.cellHeight} fonts=${JSON.stringify(state.fonts.resolved)} S=${S()}`);
    onStateChange(true);
    try { tui.invalidate?.(); } catch {}
    try { tui.requestRender?.(true); } catch {}
    return status();
  }

  function onStdoutResize() {
    // Terminals without in-band resize: re-ask for the cell size so a font
    // size change (which also resizes the grid) is picked up.
    if (!state.active) return;
    try { write("\x1b[16t\x1b[14t"); } catch {}
  }

  async function stop({ reason = "user" } = {}) {
    if (!state.active) return status();
    state.active = false;
    stopTicker();
    process.stdout.removeListener?.("resize", onStdoutResize);
    const out = freeEverything();
    try { state.untapInput?.(); } catch {}
    state.untapInput = null;
    const terminal = state.terminal;
    if (terminal) { delete terminal.columns; delete terminal.rows; }
    const restoreBg = state.edgeColorSet ? "\x1b]111\x07" : "";
    state.edgeColorSet = false;
    write(`${BSU}${out}${state.pixelMouse ? "\x1b[?1016l" : ""}\x1b[?2048l${restoreBg}\x1b[2J${ESU}`);
    state.pixelMouse = false;
    trace(`full canvas stop (${reason})`);
    onStateChange(false);
    if (reason !== "shutdown") {
      const tui = getTui();
      try { tui?.invalidate?.(); } catch {}
      try { tui?.requestRender?.(true); } catch {}
    }
    return status();
  }

  /** Real cell size changed (font size / DPI): rebuild grid, fonts, caches. */
  function onGeometry(geometry) {
    if (!state.active) return;
    trace(`full canvas geometry change ${JSON.stringify(geometry)}`);
    const out = freeEverything();
    buildFonts();
    computeVirtual();
    write(`${BSU}${out}\x1b[2J${ESU}`);
    try { getTui()?.invalidate?.(); } catch {}
    try { getTui()?.requestRender?.(true); } catch {}
  }

  function setTheme() {
    if (!state.active) return;
    resolveTheme();
    write(edgeBlendCommand());
    state.background.key = "";
    state.stripCache.clear();
    try { getTui()?.requestRender?.(true); } catch {}
  }

  function status() {
    return {
      active: state.active,
      fonts: state.fonts?.resolved || null,
      fontSizePx: state.fonts ? Math.round(state.fonts.base.fontSizePx * 10) / 10 : null,
      cell: state.fonts ? `${state.fonts.cellWidth}x${state.fonts.cellHeight}` : null,
      resolution: S(),
      real: state.real,
      virt: state.virt,
      pixelMouse: state.pixelMouse,
      terminal: state.terminalName || null,
      notes: state.notes || [],
      config: { ...state.config },
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
    setTheme,
    status,
    remapInput,
    poke: () => wake(),
  };
}
