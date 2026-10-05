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

import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";

import { DEFAULT, parseAnsiLine } from "./ansi-cells.js";
import { cellRole, renderRow } from "./canvas-renderer.js";
import { FontSet } from "./font-atlas.js";
import { decodePng, drawScaledImage } from "./png-decode.js";
import { addRadialGlow, encodeRgbaPng } from "../png-renderer.js";
import { blendMask } from "./raster.js";
import { BACKGROUND_SCALE, mixRgb, renderActivityTint, renderBackground, renderCaret, renderEditorGlow, renderEditorSurface, renderImpulse, renderScanlines, renderVignette } from "./effects.js";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
const SELECTION_SENTINEL = -2;
const CHUNK = 4096;
const HEAT_BUCKETS = 8;
const GLOW_FRAMES = 16;
const GLOW_CACHE_LIMIT = 40;
const IMPULSE_FRAMES = 6;
const STREAM_BURST_CAP = 360; // larger jumps (resume, paste) appear without animation
const HOLD_RELEASE_STEP = 24; // landed glyphs are baked back into rows in chunks
// Heavy cache misses (background frame, glow frame, flare, tint) rendered per
// frame/tick; the rest catch up on later ticks so input never stalls.
const HEAVY_RENDERS_PER_TICK = 2;
const TINT_LEVELS = 6;
// Background playback speed and tint per agent activity (backgroundReact).
const ACTIVITY_SPEED = { idle: 1, typing: 1.15, thinking: 1.8, working: 2.4, speaking: 1.5 };
const ACTIVITY_TINT = { idle: 0, typing: 0.25, thinking: 0.75, working: 0.6, speaking: 0.9 };

export const FULL_CANVAS_DEFAULTS = Object.freeze({
  fontSizePx: 0, // 0 = auto from the real cell height
  zoom: 1,
  lineHeight: 1.3,
  padding: 2, // px around the grid; terminals like Ghostty add their own padding
  fonts: {},
  resolution: 1, // supersample factor (2 = HiDPI cell-box placement)
  gamma: 1.35,
  caretStyle: "bloom",
  caretBloom: 1,
  caretSpill: 0.35, // how far the beam overshoots its row (scales with typing speed)
  caretSmear: 1, // comet tail when typing fast (0 = off)
  impulse: true,
  trail: true,
  typeIn: "pop", // typed letters: pop | rise | fade | none
  typeInMs: 170,
  streamIn: "float",
  streamInMs: 380,
  streamRise: 1, // rows (fractional ok)
  streamStagger: 8, // ms between glyphs that arrive in one token
  streamRoles: "thinking,assistant,tool",
  background: "aurora",
  backgroundPeriod: 24, // seconds per seamless loop
  backgroundFps: 20,
  backgroundScale: 0, // 0 = per-type default (1/N of window pixels)
  backgroundReact: true, // speed + tint follow agent activity and tokens
  backgroundBudgetMB: 64, // terminal memory for the cached loop
  edgeBlend: true,
  editorGlow: true,
  glowIntensity: 1,
  glowPulse: true, // flare the editor glow as tokens stream in
  panels: true,
  toolPanels: true, // Bash as terminal panes, other tools as cards
  paneStyle: "glass", // glass (translucent, sheen) | solid
  paneOpacity: 0.72,
  panelShadow: 0.6, // soft drop shadows under panes, dialogs and the editor
  editorStyle: "glass", // glass | card | neon | minimal | classic | none
  editorOpacity: 0.55,
  textShadow: 0.35, // soft glyph drop shadows away from the light
  textGlow: 0, // glyph bloom (brighter text glows more)
  lightAngle: 45, // degrees; direction shadows fall (45 = down-right)
  shadowDistance: 1.2, // px
  vignette: 0.3,
  scanlines: 0,
  renderWorker: true, // render background loop frames off the main thread
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
  getPulse = () => 0,
  onEditorText = () => {},
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
    background: freshBackground(),
    caret: freshCaret(),
    impulses: [],
    impulseIds: new Map(),
    lastImpulseAt: 0,
    glow: freshGlow(),
    stream: { blocks: new Map(), armedAt: 0 },
    overlay: { hidden: new Map(), items: new Map(), slots: new Map() },
    surface: { key: "", id: null, placedAt: "" },
    fx: { vignetteKey: "", vignetteId: null, scanKey: "", scanId: null, scanPlacements: 0 },
    typed: [],
    prevCursor: null,
    lastTypedImpulse: 0,
    ticker: null,
    stats: { frames: 0, uploads: 0, uploadBytes: 0, rasterMs: 0, lastFrameMs: 0, ticks: 0 },
  };
  function freshBackground() {
    return { key: "", ring: [], frames: 0, period: 1, phase: 0, speed: 1, lastTick: 0, index: -1, placed: null, bw: 0, bh: 0, tint: { cache: new Map(), level: 0, activity: "idle", placed: null, key: "" } };
  }
  function freshCaret() {
    return { ids: new Map(), key: "", target: null, shown: null, pos: null, from: null, to: null, start: 0, bucket: -1, imageId: null, anchor: null };
  }
  function freshGlow() {
    return { baseKey: "", cache: new Map(), activity: "", index: -1, last: 0, placed: null, flarePlaced: null };
  }
  const cfg = () => state.config;
  let renderBudget = HEAVY_RENDERS_PER_TICK;
  const spendRender = () => (renderBudget > 0 ? (renderBudget -= 1, true) : false);
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
    const error = hexToRgb(themeColor("error"), [191, 97, 106]);
    const pending = hexToRgb(themeColor("warning"), [235, 203, 139]);
    const bottom = mixRgb(bg, [0, 0, 0], dark ? 0.28 : 0.06);
    state.theme = {
      bg, fg, accent, accent2, warm, thinking, speech, error, pending,
      terminalBg: dark ? mixRgb(bg, [0, 0, 0], 0.5) : mixRgb(bg, [20, 22, 28], 0.9),
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

  /** Upload an already PNG-encoded image (from the render worker). */
  function transmitEncoded(imageId, base64) {
    let out = "";
    for (let offset = 0; offset < base64.length; offset += CHUNK) {
      const more = offset + CHUNK < base64.length ? 1 : 0;
      const control = offset === 0 ? { a: "t", f: 100, i: imageId, q: 2, m: more } : { m: more };
      out += serialize(control, base64.slice(offset, offset + CHUNK));
    }
    state.stats.uploads += 1;
    state.stats.uploadBytes += base64.length;
    state.ownedImages.add(imageId);
    return out;
  }

  // ---------------------------------------------------------- render worker
  let worker = null; let workerFailed = false; let workerSeq = 0;
  const workerPending = new Map();
  function renderOffThread(kind, args) {
    if (workerFailed || !bool(cfg().renderWorker, true)) return null;
    if (!worker) {
      try {
        worker = new Worker(new URL("./render-worker.js", import.meta.url));
        worker.unref?.();
        worker.on("message", (msg) => { const done = workerPending.get(msg.id); workerPending.delete(msg.id); done?.(msg); });
        const fail = (error) => {
          workerFailed = true; trace(`canvas render worker unavailable: ${error?.message || error}`);
          for (const done of workerPending.values()) done({ ok: false });
          workerPending.clear(); worker = null;
        };
        worker.on("error", fail);
        worker.on("exit", (code) => { if (code !== 0) fail(new Error(`exit ${code}`)); else worker = null; });
      } catch (error) { workerFailed = true; trace(`canvas render worker unavailable: ${error?.message || error}`); return null; }
    }
    const id = ++workerSeq;
    return new Promise((resolve) => { workerPending.set(id, resolve); worker.postMessage({ id, kind, args }); });
  }
  function stopWorker() {
    try { worker?.terminate?.(); } catch {}
    worker = null;
    for (const done of workerPending.values()) done({ ok: false });
    workerPending.clear();
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
  // Background: one seamless loop of `period` seconds rendered lazily into a
  // ring of cached terminal images (first pass renders ~1 frame per tick;
  // afterwards playback only re-places, ~70 bytes per frame). Agent activity
  // changes the playback speed (free) and crossfades a tint layer.
  function backgroundKey() {
    const mode = cfg().background;
    if (mode === "none" || mode === "transparent") return "";
    const { width, height } = state.real;
    return [mode, width, height, state.theme.bg, state.theme.accent, state.theme.accent2, cfg().backgroundPeriod, cfg().backgroundFps, cfg().backgroundScale, cfg().backgroundBudgetMB].join(":");
  }

  function freeBackground() {
    const bg = state.background;
    let out = "";
    for (const id of bg.ring) if (id != null) out += freeImage(id);
    for (const id of bg.tint.cache.values()) out += freeImage(id);
    state.background = freshBackground();
    return out;
  }

  function backgroundCommands({ force = false } = {}) {
    const key = backgroundKey();
    if (!force && key === state.background.key) return "";
    let out = freeBackground();
    if (!key) return out;
    const mode = cfg().background;
    const scale = Math.max(1, Number(cfg().backgroundScale) || BACKGROUND_SCALE[mode] || 8);
    const bw = Math.max(16, Math.round(state.real.width / scale)); const bh = Math.max(16, Math.round(state.real.height / scale));
    const animated = mode !== "static";
    const period = Math.max(2, Number(cfg().backgroundPeriod) || 24);
    const budgetFrames = Math.max(2, Math.floor((Math.max(4, Number(cfg().backgroundBudgetMB) || 64) * 1024 * 1024) / (bw * bh * 4)));
    const frames = animated ? Math.max(2, Math.min(budgetFrames, Math.round(period * Math.max(1, Math.min(60, Number(cfg().backgroundFps) || 20))))) : 1;
    Object.assign(state.background, { key, mode, bw, bh, frames, period, ring: new Array(frames).fill(null), lastTick: Date.now(), ready: new Map(), requested: new Set() });
    return out + backgroundFrameCommand(0);
  }

  function backgroundFrameCommand(index) {
    const bg = state.background;
    if (!bg.key) return "";
    const { cols, rows } = state.real;
    let out = "";
    let id = bg.ring[index];
    if (id == null && bg.ready?.has(index)) {
      const ready = bg.ready.get(index); bg.ready.delete(index);
      id = allocateImageId(`background-${index}`);
      bg.ring[index] = id;
      out += transmitEncoded(id, ready.base64);
    }
    if (id == null && bg.placed != null && requestBackgroundFrame(index)) return out; // worker renders it
    // Reactive layers (glow, flare, tint) render first; the background loop
    // only takes budget they left, so a long first pass never starves them.
    if (id == null && bg.placed != null && (renderBudget < HEAVY_RENDERS_PER_TICK || !spendRender())) return out;
    if (id == null) {
      const frame = renderBackground({ width: bg.bw, height: bg.bh, type: bg.mode, phase: index / bg.frames, colors: state.theme });
      id = allocateImageId(`background-${index}`);
      bg.ring[index] = id;
      out += transmit(id, frame.rgba, frame.width, frame.height);
    }
    if (bg.placed != null && bg.placed !== id) out += deletePlacement(bg.placed, 1);
    out += `\x1b[1;1H${serialize({ a: "p", i: id, p: 1, c: cols, r: rows, C: 1, q: 2, z: z.background })}`;
    bg.placed = id;
    bg.index = index;
    return out;
  }

  /** Ask the render worker for a loop frame; false when no worker. */
  function requestBackgroundFrame(index) {
    const bg = state.background;
    if (!bg.key || bg.ring[index] != null || bg.ready.has(index)) return Boolean(bg.key);
    if (bg.requested.has(index)) return true;
    const pending = renderOffThread("background", { width: bg.bw, height: bg.bh, type: bg.mode, phase: index / bg.frames, colors: state.theme });
    if (!pending) return false;
    bg.requested.add(index);
    const key = bg.key;
    pending.then((result) => {
      const current = state.background;
      if (current.key !== key) return;
      current.requested.delete(index);
      if (result?.ok) { current.ready.set(index, result); wake(); }
    });
    return true;
  }

  function backgroundAdvance(now) {
    const bg = state.background;
    if (!bg.key) return "";
    const dt = Math.max(0, Math.min(250, now - (bg.lastTick || now)));
    bg.lastTick = now;
    const react = bool(cfg().backgroundReact, true);
    const activity = currentActivity();
    const pulse = react ? Math.max(0, Math.min(1, Number(getPulse()) || 0)) : 0;
    let out = tintCommands(dt, activity, pulse, react);
    if (bg.frames > 1) {
      const target = react ? (ACTIVITY_SPEED[activity] || 1) + pulse * 0.8 : 1;
      bg.speed += (target - bg.speed) * Math.min(1, dt / 500);
      bg.phase = (bg.phase + (dt / 1000 / bg.period) * bg.speed) % 1;
      const index = Math.floor(bg.phase * bg.frames) % bg.frames;
      // Prefetch a few frames ahead on the worker during the first pass.
      if (bool(cfg().renderWorker, true) && !workerFailed) {
        for (let k = 1; k <= 4; k += 1) { const next = (index + k) % bg.frames; if (bg.ring[next] == null) requestBackgroundFrame(next); }
      }
      // Upload frames the worker finished (bounded per tick).
      let uploads = 0;
      for (const [readyIndex, ready] of bg.ready) {
        if (uploads >= 2) break;
        if (bg.ring[readyIndex] != null) { bg.ready.delete(readyIndex); continue; }
        const id = allocateImageId(`background-${readyIndex}`);
        bg.ring[readyIndex] = id; bg.ready.delete(readyIndex);
        out += transmitEncoded(id, ready.base64);
        uploads += 1;
      }
      if (index !== bg.index) out += backgroundFrameCommand(index);
    }
    return out;
  }

  function tintColor(activity) {
    const t = state.theme;
    return activity === "thinking" ? t.thinking : activity === "speaking" ? t.speech : activity === "typing" ? t.warm : t.accent;
  }

  function tintCommands(dt, activity, pulse, react) {
    const bg = state.background; const tint = bg.tint;
    const heat = Math.max(0, Math.min(1, Number(getHeat()) || 0));
    const target = react ? Math.min(1, (ACTIVITY_TINT[activity] || 0) * (activity === "typing" ? heat : 1) + pulse * 0.45) : 0;
    tint.level += (target - tint.level) * Math.min(1, dt / 280);
    if (target > 0.02) tint.activity = activity === "idle" ? tint.activity : activity;
    const bucket = Math.round(tint.level * TINT_LEVELS);
    const key = bucket > 0 ? `${tint.activity}:${bucket}` : "";
    if (key === tint.key) return "";
    tint.key = key;
    let out = "";
    if (!key) {
      if (tint.placed != null) { out += deletePlacement(tint.placed, 1); tint.placed = null; }
      return out;
    }
    let id = tint.cache.get(key);
    if (id == null && !spendRender()) { tint.key = ""; return out; }
    if (id == null) {
      const img = renderActivityTint({ width: bg.bw, height: bg.bh, color: tintColor(tint.activity), level: bucket / TINT_LEVELS });
      id = allocateImageId(`tint-${key}`);
      tint.cache.set(key, id);
      out += transmit(id, img.rgba, img.width, img.height);
    }
    if (tint.placed != null && tint.placed !== id) out += deletePlacement(tint.placed, 1);
    out += `\x1b[1;1H${serialize({ a: "p", i: id, p: 1, c: state.real.cols, r: state.real.rows, C: 1, q: 2, z: z.background + 1 })}`;
    tint.placed = id;
    return out;
  }

  function currentActivity() {
    const heat = Math.max(0, Math.min(1, Number(getHeat()) || 0));
    const activity = getActivity() || "idle";
    return activity === "idle" && heat > 0.12 ? "typing" : activity;
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
      ...p,
      start: p.col0, end: p.col1,
      top: rowIndex === p.row0 && p.top !== false, bottom: rowIndex === p.row1 && p.bottom !== false,
      // Full extent relative to this row (clamped: beyond ±3 rows a slice
      // is identical, so tall panels still share cached middle strips).
      relTop: p.top === false ? -3 : Math.max(-3, p.row0 - rowIndex),
      relBottom: p.bottom === false ? 3 : Math.min(3, p.row1 - rowIndex),
      suppressRules: p.suppressRules && (rowIndex === p.row0 || rowIndex === p.row1),
    }));
    const regionRole = frame.regionRoles.get(rowIndex) || null;
    const slice = frame.imageSlices.get(rowIndex);
    const lighting = frame.lighting;
    const xOffset = regionRole === "editor" ? frame.editorIndent || 0 : 0;
    const hidden = state.overlay.hidden.get(rowIndex) || null;
    const scale = S();
    const geo = stripGeometry(rowIndex);
    const box = scale > 1 ? cellBox(geo.lx, geo.ly, geo.lw, geo.lh) : null;
    const key = [
      state.virt.cols, line, cursorCol, sigKey(above), sigKey(below), regionRole || "",
      rowPanels.map((p) => `${p.style || ""}${p.flush ? "f" : ""}${p.start}-${p.end}:${p.relTop},${p.relBottom}:${p.top ? 1 : 0}${p.bottom ? 1 : 0}${p.fill}:${p.alpha}:${p.border}:${p.border2 || ""}:${p.sheen || 0}:${p.shadow || 0}:${p.absorbBg ? [...p.absorbBg].join("/") : ""}`).join("|"),
      slice ? `${slice.id}:${slice.index}` : "",
      hidden ? [...hidden].sort((a, b) => a - b).join(",") : "",
      box ? `${scale}:${box.offX.toFixed(1)}:${box.offY.toFixed(1)}:${box.c}x${box.r}` : "",
      lighting ? lighting.key : "",
      xOffset,
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
      regionRole, hiddenCols: hidden, lighting, xOffset,
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
  // A streamed glyph's identity is (semantic block, ordinal among the block's
  // non-space glyphs). Ordinals do not change when a word re-wraps onto the
  // next row or the transcript scrolls, so only glyphs past the block's
  // previous end are "born". Births are held hidden in the row strips and
  // drawn by per-row overlays that are rebuilt from the CURRENT positions on
  // every frame and tick, so in-flight glyphs follow reflow and scrolling.
  const streamRoles = () => new Set(String(cfg().streamRoles || "").split(/[\s,]+/).filter(Boolean));
  const baseRole = (sem) => (sem.role === "bash" ? "tool" : sem.role);
  const streamDuration = () => Math.max(60, Number(cfg().streamInMs) || 380);
  function semOf(cells) { for (const cell of cells) if (cell.sem) return cell.sem; return null; }
  function glyphCols(cells) {
    const out = [];
    for (let col = 0; col < cells.length; col += 1) {
      const cell = cells[col];
      if (cell.sem && !cell.cont && !cell.hidden && cell.cp !== 32 && cell.cp !== 0) out.push(col);
    }
    return out;
  }

  function addRun(block, from, to, now) {
    const stagger = Math.min(Math.max(0, Number(cfg().streamStagger) || 0), 160 / Math.max(1, to - from));
    block.runs.push({ from, to, at: now, stagger });
    block.hold = block.hold ? { from: Math.min(block.hold.from, from), to: Math.max(block.hold.to, to) } : { from, to };
  }

  function trackStreamIn(now) {
    const stream = state.stream;
    const frame = state.frame;
    frame.glyphs = new Map();
    frame.blockRows = new Map();
    const effect = cfg().streamIn;
    if (!effect || effect === "none") { stream.blocks.clear(); return; }
    const roles = streamRoles();
    const rows = frame.parsed.length;
    frame.parsed.forEach(({ cells }, r) => {
      const sem = semOf(cells);
      if (!sem || !roles.has(baseRole(sem))) return;
      const cols = glyphCols(cells);
      frame.glyphs.set(r, cols);
      let entry = frame.blockRows.get(sem.block);
      if (!entry) frame.blockRows.set(sem.block, (entry = { rows: [], streaming: false }));
      entry.rows.push({ row: r, line: sem.line, text: cols.map((c) => cells[c].ch).join("") });
      if (sem.streaming) entry.streaming = true;
    });
    const armed = now >= stream.armedAt;
    for (const [id, entry] of frame.blockRows) {
      let block = stream.blocks.get(id);
      const fresh = !block;
      if (fresh) { block = { lines: new Map(), seq: "", runs: [], hold: null, offsets: [] }; stream.blocks.set(id, block); }
      block.touched = now;
      let maxVisible = -1;
      for (const row of entry.rows) { block.lines.set(row.line, row.text); maxVisible = Math.max(maxVisible, row.line); }
      // The block ends on screen: forget lines a re-render no longer produces.
      const last = entry.rows[entry.rows.length - 1];
      if (last.row + 1 < rows && semOf(frame.parsed[last.row + 1].cells)?.block !== id) {
        for (const key of [...block.lines.keys()]) if (key > maxVisible) block.lines.delete(key);
      }
      let seq = "";
      const maxLine = Math.max(...block.lines.keys());
      block.offsets = new Array(maxLine + 1);
      for (let i = 0; i <= maxLine; i += 1) { block.offsets[i] = seq.length; seq += block.lines.get(i) ?? ""; }
      if (armed && entry.streaming) {
        const old = fresh ? "" : block.seq;
        let cp = 0; const lim = Math.min(old.length, seq.length);
        while (cp < lim && old.charCodeAt(cp) === seq.charCodeAt(cp)) cp += 1;
        const from = Math.max(cp, old.length); const to = seq.length;
        if (to > from && to - from <= STREAM_BURST_CAP) addRun(block, from, to, now);
      }
      if (block.hold) block.hold.to = Math.min(block.hold.to, seq.length);
      block.seq = seq;
    }
    if (stream.blocks.size > 512) {
      for (const [id, block] of stream.blocks) {
        if (stream.blocks.size <= 256) break;
        if (!frame.blockRows.has(id) && now - block.touched > 5000) stream.blocks.delete(id);
      }
    }
  }

  function glyphAge(block, ordinal, now) {
    for (let i = block.runs.length - 1; i >= 0; i -= 1) {
      const run = block.runs[i];
      if (ordinal >= run.from && ordinal < run.to) return now - (run.at + (ordinal - run.from) * run.stagger);
    }
    return Infinity;
  }

  /** Recompute hidden cells and overlay items from current positions. */
  function collectOverlays(now) {
    const hidden = new Map(); const items = new Map();
    const add = (row, item) => {
      let set = hidden.get(row); if (!set) hidden.set(row, (set = new Set()));
      set.add(item.col);
      let list = items.get(row); if (!list) items.set(row, (list = []));
      list.push(item);
    };
    const frame = state.frame;
    const duration = streamDuration();
    for (const [id, entry] of frame?.blockRows || []) {
      const block = state.stream.blocks.get(id);
      if (!block?.hold) continue;
      block.runs = block.runs.filter((run) => now < run.at + (run.to - run.from) * run.stagger + duration);
      if (!block.runs.length) { block.hold = null; continue; }
      // Release landed glyphs at the front of the hold in chunks.
      let firstLive = Infinity;
      for (const run of block.runs) {
        const landed = run.stagger > 0 ? Math.floor((now - duration - run.at) / run.stagger) + 1 : (now - run.at >= duration ? run.to - run.from : 0);
        firstLive = Math.min(firstLive, run.from + Math.max(0, landed));
      }
      if (firstLive - block.hold.from >= HOLD_RELEASE_STEP) block.hold.from = firstLive;
      for (const row of entry.rows) {
        const offset = block.offsets[row.line] ?? 0;
        const cols = frame.glyphs.get(row.row) || [];
        for (let k = 0; k < cols.length; k += 1) {
          const ordinal = offset + k;
          if (ordinal < block.hold.from || ordinal >= block.hold.to) continue;
          add(row.row, { col: cols[k], age: glyphAge(block, ordinal, now), duration, kind: "stream" });
        }
      }
    }
    const typeMs = Math.max(40, Number(cfg().typeInMs) || 170);
    state.typed = state.typed.filter((t) => {
      const cell = frame?.parsed[t.row]?.cells[t.col];
      return now - t.at < typeMs && cell && cell.cp !== 32 && cell.ch === t.ch;
    });
    for (const t of state.typed) add(t.row, { col: t.col, age: now - t.at, duration: typeMs, kind: "typed" });
    const changed = new Set([...state.overlay.hidden.keys(), ...hidden.keys()]);
    state.overlay.hidden = hidden;
    state.overlay.items = items;
    return changed;
  }

  function detectTyped(cursor, now) {
    const impulseAt = Number(getImpulseAt()) || 0;
    const prev = state.prevCursor;
    state.prevCursor = cursor ? { ...cursor } : null;
    if (impulseAt <= state.lastTypedImpulse) return;
    state.lastTypedImpulse = impulseAt;
    if (!cursor || !prev || cfg().typeIn === "none" || now - impulseAt > 250) return;
    const sameRow = cursor.row === prev.row && cursor.col > prev.col && cursor.col - prev.col <= 2;
    const wrapped = cursor.row === prev.row + 1 && cursor.col >= 1 && cursor.col <= 3;
    if (!sameRow && !wrapped) return;
    const cells = state.frame.parsed[cursor.row]?.cells;
    let col = cursor.col - 1;
    if (cells?.[col]?.cont) col -= 1;
    const cell = cells?.[col];
    if (!cell || cell.cp === 32) return;
    state.typed.push({ row: cursor.row, col, ch: cell.ch, at: now });
    if (state.typed.length > 8) state.typed.shift();
  }

  function overlayCommands(now) {
    const fonts = state.fonts; const cw = fonts.cellWidth; const ch = fonts.cellHeight;
    const streamEffect = cfg().streamIn; const typeEffect = cfg().typeIn;
    const rise = streamEffect === "float" ? Math.max(0, Math.min(6, Number(cfg().streamRise) || 0)) : 0;
    const above = Math.ceil(Math.max(rise, typeEffect === "pop" ? 0.35 : 0)); const below = typeEffect === "rise" ? 1 : 0;
    let out = "";
    for (const [row, list] of state.overlay.items) {
      const parsed = state.frame?.parsed[row];
      if (!parsed) continue;
      const key = `${parsed.line}|${above}|${below}|${list.map((it) => `${it.col}:${it.kind}:${it.age < 0 ? "w" : it.age >= it.duration ? "L" : Math.floor(it.age / 16)}`).join(",")}`;
      const slot = state.overlay.slots.get(row);
      if (slot && slot.key === key) continue;
      let minCol = Infinity; let maxCol = 0;
      for (const it of list) { minCol = Math.min(minCol, it.col); maxCol = Math.max(maxCol, it.col + (parsed.cells[it.col]?.wide ? 2 : 1)); }
      const pad = cw; const w = (maxCol - minCol) * cw + pad * 2; const h = (above + 1 + below) * ch;
      const fb = Buffer.alloc(w * h * 4);
      const regionRole = state.frame.regionRoles.get(row) || null;
      for (const it of list) {
        if (it.age < 0) continue; // not yet born (staggered): hidden until its turn
        const cell = parsed.cells[it.col];
        const t = Math.min(1, it.age / it.duration); const e = 1 - (1 - t) ** 3;
        let fg = cell.fg === DEFAULT ? state.theme.fg : [(cell.fg >> 16) & 255, (cell.fg >> 8) & 255, cell.fg & 255];
        let dy = 0; let alpha = 1; let glow = 0;
        if (it.kind === "stream") {
          if (streamEffect === "float") { dy = -rise * ch * (1 - e); alpha = Math.min(1, t * 1.8); glow = t < 0.45 ? (1 - t / 0.45) * 30 : 0; }
          else if (streamEffect === "fade") alpha = e;
        } else if (typeEffect === "pop") { dy = -0.3 * ch * (1 - e); fg = mixRgb(fg, [255, 255, 255], 0.65 * (1 - t)); glow = (1 - t) * 80; }
        else if (typeEffect === "rise") { dy = 0.45 * ch * (1 - e); alpha = Math.min(1, t * 2); }
        else if (typeEffect === "fade") alpha = e;
        const x = pad + (it.col - minCol) * cw; const y = above * ch + Math.round(dy);
        if (glow > 1) addRadialGlow(fb, w, x + cw / 2, y + ch / 2, ch * 0.6, [...mixRgb(fg, state.theme.accent, 0.4), Math.round(glow)], 1);
        const atlas = fonts.forRole(cellRole(cell, { regionRole, theme: state.theme }));
        const mask = atlas.supersample > 1 ? null : atlas.mask(cell.cp, { bold: cell.bold, italic: cell.italic, cells: cell.wide ? 2 : 1 });
        if (mask) blendMask(fb, w, h, mask, x + mask.left, y + mask.top, ...fg, Math.round(255 * alpha * (cell.dim ? 0.6 : 1)));
      }
      const imageId = slot?.imageId ?? allocateImageId(`overlay-${row}`);
      out += transmit(imageId, fb, w, h);
      out += placeCropped(imageId, 1, state.virt.padX + minCol * cw - pad + rowIndent(row), state.virt.padY + (row - above) * ch, z.overlay);
      state.overlay.slots.set(row, { key, imageId });
    }
    for (const [row, slot] of state.overlay.slots) {
      if (state.overlay.items.has(row)) continue;
      out += freeImage(slot.imageId);
      state.overlay.slots.delete(row);
    }
    return out;
  }

  // ----------------------------------------------------------------- caret
  function caretImageFor(bucket, dir = 1) {
    const caret = state.caret;
    const fonts = state.fonts;
    const key = `${cfg().caretStyle}:${cfg().caretBloom}:${cfg().caretSpill}:${cfg().caretSmear}:${fonts.cellWidth}x${fonts.cellHeight}:${state.theme.accent}:${state.theme.warm}`;
    let out = "";
    if (caret.key !== key) {
      for (const id of caret.ids.values()) out += freeImage(id);
      caret.ids.clear(); caret.key = key; caret.shown = null; caret.imageId = null;
    }
    // The comet smear trails behind the direction of travel, so images are
    // per heat bucket and direction (both share one anchor).
    const slot = `${bucket}:${dir < 0 ? -1 : 1}`;
    let id = caret.ids.get(slot);
    if (id == null) {
      const img = renderCaret({ style: cfg().caretStyle, cellWidth: fonts.cellWidth, cellHeight: fonts.cellHeight, heat: bucket / (HEAT_BUCKETS - 1), bloom: cfg().caretBloom, colors: state.theme, spill: Number(cfg().caretSpill) || 0, smear: Number(cfg().caretSmear) || 0, direction: dir });
      id = allocateImageId(`caret-${slot}`);
      caret.ids.set(slot, id);
      caret.anchor = { x: img.anchorX, y: img.anchorY };
      out += transmit(id, img.rgba, img.width, img.height);
    }
    return { id, out };
  }

  function rowIndent(row) {
    const rows = state.frame?.editorRows;
    return rows && row >= rows[0] && row <= rows[1] ? state.frame.editorIndent || 0 : 0;
  }
  function caretPixel(pos) {
    return { x: state.virt.padX + pos.col * state.fonts.cellWidth + rowIndent(pos.row), y: state.virt.padY + pos.row * state.fonts.cellHeight };
  }

  function caretCommands(now) {
    const caret = state.caret;
    if (cfg().caretStyle === "off") return caret.imageId != null && caret.shown ? (caret.shown = null, deletePlacement(caret.imageId, 1)) : "";
    const heat = Math.max(0, Math.min(1, Number(getHeat()) || 0));
    const bucket = Math.round(heat * (HEAT_BUCKETS - 1));
    // Positions here are LOGICAL caret pixels (cell top-left). The image's
    // anchor offset is applied only when placing, so the glide starts from
    // where the caret visibly is, never from the image's top-left corner.
    const target = caret.target ? caretPixel(caret.target) : null;
    let pos = target;
    const glide = bool(cfg().trail, true);
    if (target && glide && caret.to && (caret.to.x !== target.x || caret.to.y !== target.y)) {
      const current = caret.pos || target;
      caret.from = Math.hypot(target.x - current.x, target.y - current.y) < state.fonts.cellHeight * 6 ? { ...current } : target;
      caret.to = target; caret.start = now;
    } else if (target && (!glide || !caret.to)) { caret.from = target; caret.to = target; caret.start = now; }
    if (target && caret.from && caret.to) {
      const t = Math.min(1, (now - caret.start) / 80);
      const e = 1 - (1 - t) ** 3;
      pos = { x: caret.from.x + (caret.to.x - caret.from.x) * e, y: caret.from.y + (caret.to.y - caret.from.y) * e };
    }
    caret.pos = pos;
    let out = "";
    if (!pos) {
      if (caret.shown && caret.imageId != null) out += deletePlacement(caret.imageId, 1);
      caret.shown = null;
      return out;
    }
    if (caret.from && caret.to && caret.to.x !== caret.from.x) caret.dir = caret.to.y === caret.from.y ? Math.sign(caret.to.x - caret.from.x) : caret.dir || 1;
    const image = caretImageFor(bucket, caret.dir || 1);
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
  // A ring of frames per activity (typing heat, thinking, working, speaking)
  // plus a flare layer whose level follows streamed tokens (getPulse), so the
  // border reacts as text arrives rather than only between states.
  // args: renderEditorGlow arguments (the render worker draws them; the
  // previous glow stays up for the tick until the new frame arrives).
  function glowImage(key, args) {
    const glow = state.glow;
    let id = glow.cache.get(key);
    let out = "";
    if (id == null) {
      const ready = glow.ready?.get(key);
      if (ready) {
        glow.ready.delete(key);
        id = allocateImageId(`glow-${key}`);
        out += transmitEncoded(id, ready.base64);
      } else if (glow.placed != null && requestGlow(key, args)) {
        return null;
      } else {
        if (glow.placed != null && !spendRender()) return null;
        const img = renderEditorGlow(args);
        id = allocateImageId(`glow-${key}`);
        out += transmit(id, img.rgba, img.width, img.height);
      }
      glow.cache.set(key, id);
      for (const [oldKey, oldId] of glow.cache) {
        if (glow.cache.size <= GLOW_CACHE_LIMIT) break;
        if (oldId === glow.placed || oldId === glow.flarePlaced || oldKey === key) continue;
        glow.cache.delete(oldKey);
        out += freeImage(oldId);
      }
    } else { glow.cache.delete(key); glow.cache.set(key, id); }
    return { id, out };
  }

  function requestGlow(key, args) {
    const glow = state.glow;
    if (!glow.ready) glow.ready = new Map();
    if (!glow.requested) glow.requested = new Set();
    if (glow.requested.has(key)) return true;
    const pending = renderOffThread("glow", args);
    if (!pending) return false;
    glow.requested.add(key);
    const baseKey = glow.baseKey;
    pending.then((result) => {
      const current = state.glow;
      if (current.baseKey !== baseKey) return;
      current.requested?.delete(key);
      if (result?.ok) { current.ready.set(key, result); wake(); }
    });
    return true;
  }

  function glowCommands(now, { force = false } = {}) {
    const glow = state.glow;
    const rect = state.frame?.glowRect;
    if (!bool(cfg().editorGlow, true) || !rect) {
      let out = "";
      if (glow.placed != null) { out += deletePlacement(glow.placed, 1); glow.placed = null; }
      if (glow.flarePlaced != null) { out += deletePlacement(glow.flarePlaced, 1); glow.flarePlaced = null; }
      return out;
    }
    let out = "";
    const baseKey = `${rect.x},${rect.y},${rect.w}x${rect.h}:${state.theme.accent}:${cfg().glowIntensity}`;
    if (glow.baseKey !== baseKey) {
      for (const id of glow.cache.values()) out += freeImage(id);
      Object.assign(glow, freshGlow(), { baseKey });
    }
    const heat = Math.max(0, Math.min(1, Number(getHeat()) || 0));
    const activity = currentActivity();
    const heatBucket = activity === "typing" ? Math.round(heat * (HEAT_BUCKETS - 1)) : 0;
    const animated = activity !== "typing";
    const fps = activity === "working" ? 14 : activity === "speaking" ? 16 : activity === "thinking" ? 12 : 8;
    const frames = animated ? GLOW_FRAMES : 1;
    const margin = Math.round(state.fonts.cellWidth * 2.2);
    const radius = Math.round(state.fonts.cellHeight * 0.7);
    const px = Math.round(rect.x - margin); const py = Math.round(rect.y - margin);
    const switched = glow.activity !== `${activity}:${heatBucket}`;
    if (switched && process.env.PI_GRAPHICS_TRACE_GLOW) trace(`canvas glow ${activity}:${heatBucket}`);
    if (force || switched || (animated && now - glow.last >= 1000 / fps)) {
      const index = switched ? 0 : (glow.index + 1) % frames;
      const key = `${activity}:${heatBucket}:${index}`;
      const image = glowImage(key, { width: rect.w, height: rect.h, margin, radius, state: activity, phase: index / frames, heat, colors: state.theme, intensity: cfg().glowIntensity });
      if (image) {
        out += image.out;
        if (glow.placed != null && glow.placed !== image.id) out += deletePlacement(glow.placed, 1);
        if (glow.placed !== image.id || force) out += placeCropped(image.id, 1, px, py, z.glow);
        glow.placed = image.id; glow.index = index; glow.last = now; glow.activity = `${activity}:${heatBucket}`;
      }
    }
    // Token flare.
    const pulse = bool(cfg().glowPulse, true) ? Math.max(0, Math.min(1, Number(getPulse()) || 0)) : 0;
    const level = pulse > 0.08 ? Math.min(3, Math.ceil(pulse * 3)) : 0;
    const flareKey = level ? `flare:${level}` : "";
    if (flareKey !== (glow.flareKey || "") || force) {
      const image = level ? glowImage(flareKey, { width: rect.w, height: rect.h, margin, radius, state: "flare", colors: state.theme, intensity: (cfg().glowIntensity || 1) * (0.35 + level * 0.25) }) : null;
      if (!level || image) {
        if (glow.flarePlaced != null) { out += deletePlacement(glow.flarePlaced, 1); glow.flarePlaced = null; }
        if (image) { out += image.out + placeCropped(image.id, 1, px, py, z.glow + 1); glow.flarePlaced = image.id; }
        glow.flareKey = flareKey;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ ticker
  function animating(now) {
    const caret = state.caret;
    if (caret.to && caret.from && now - caret.start < 120) return true;
    if (state.impulses.length || state.overlay.items.size || state.overlay.slots.size || state.typed.length) return true;
    for (const block of state.stream.blocks.values()) if (block.hold) return true;
    if (bool(cfg().editorGlow, true) && state.frame?.glowRect) return true;
    if (state.background.frames > 1 || state.background.tint.placed != null) return true;
    return Number(getHeat()) > 0.01 || Number(getPulse()) > 0.01;
  }

  function tick() {
    if (!state.active || !state.frame) return;
    const now = Date.now();
    state.stats.ticks += 1;
    renderBudget = HEAVY_RENDERS_PER_TICK;
    let out = "";
    // Held glyphs land / typed letters settle: bake changed rows first.
    for (const row of collectOverlays(now)) if (row < state.virt.rows) out += updateRow(row).out;
    const t0 = performance.now();
    const marks = [];
    const timed = (name, fn) => { const a = performance.now(); const r = fn(); marks.push(`${name}=${(performance.now() - a).toFixed(1)}`); return r; };
    out += timed("glow", () => glowCommands(now)) + timed("bg", () => backgroundAdvance(now)) + timed("caret", () => caretCommands(now) + impulseCommands(now)) + timed("ov", () => overlayCommands(now));
    const ms = performance.now() - t0;
    state.stats.tickMs = Math.max(state.stats.tickMs || 0, ms);
    if (ms > 12) trace(`canvas tick ${state.stats.ticks} ms=${ms.toFixed(1)} ${marks.join(" ")} bytes=${out.length} overlays=${state.overlay.items.size}`);
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
    let editorIndent = 0; let editorRows = null;
    const panelsOn = bool(cfg().panels, true);
    if (regions.editor) {
      const r = regions.editor;
      // The editor's look comes from its own surface layer (one smooth image)
      // unless editorStyle is "classic"; the row panel then only suppresses
      // Pi's rule lines.
      const classic = cfg().editorStyle === "classic";
      if (panelsOn) panels.push(classic
        ? { row0: r.y, row1: r.y + r.height - 1, col0: r.x, col1: r.x + r.width, style: "editor", fill: theme.surface, alpha: 0.92, border: theme.accent, borderAlpha: 0.55, shadow: Number(cfg().panelShadow) || 0, suppressRules: true }
        : { row0: r.y, row1: r.y + r.height - 1, col0: r.x, col1: r.x + r.width, style: "editor-rules", fill: theme.surface, alpha: 0, border: null, suppressRules: true });
      for (let row = r.y; row < r.y + r.height; row += 1) regionRoles.set(row, "editor");
      // Pi lays the editor out from column 0; with little canvas padding the
      // text would touch the surface edge, so indent the editor's text.
      const flushLeft = state.virt.padX + r.x * fonts.cellWidth < fonts.cellWidth;
      editorIndent = flushLeft && cfg().editorStyle !== "none" && cfg().editorStyle !== "classic" ? Math.round(fonts.cellWidth * 0.9) : 0;
      editorRows = [r.y, r.y + r.height - 1];
      // Breathing room between the surface edge and the text, kept on screen
      // even with zero padding (Ghostty/Kitty add their own window padding).
      const inset = Math.round(fonts.cellWidth * 1.1);
      const left = Math.max(1, state.virt.padX + r.x * fonts.cellWidth - inset);
      const right = Math.min(state.real.width - 1, state.virt.padX + (r.x + r.width) * fonts.cellWidth + inset);
      glowRect = {
        x: left,
        y: state.virt.padY + r.y * fonts.cellHeight + Math.round(fonts.cellHeight * 0.45),
        w: right - left,
        h: (r.height - 1) * fonts.cellHeight + Math.round(fonts.cellHeight * 0.1),
      };
    }
    if (regions.footer) {
      const r = regions.footer;
      if (panelsOn) panels.push({ row0: r.y, row1: r.y + r.height - 1, col0: r.x, col1: r.x + r.width, fill: mixRgb(theme.surface, theme.accent, 0.08), alpha: 0.55, border: null });
      for (let row = r.y; row < r.y + r.height; row += 1) regionRoles.set(row, "footer");
    }
    return { panels, regionRoles, glowRect, editorRect: regions.editor || null, editorIndent, editorRows };
  }

  // Tool calls as panels: Bash (tool `bash` or a user `!` command) as a
  // terminal pane with a title band, other tools as cards with a status
  // stripe. Rows are grouped by semantic block; the panel absorbs Pi's
  // per-cell tool background so it can draw its own rounded fill.
  function toolPanels(parsed) {
    if (!bool(cfg().toolPanels, true) || !bool(cfg().panels, true)) return [];
    const groups = []; let current = null;
    parsed.forEach(({ cells }, r) => {
      const sem = semOf(cells);
      if (!sem || (sem.role !== "tool" && sem.role !== "bash")) { current = null; return; }
      if (current && current.block === sem.block && current.row1 === r - 1) {
        current.row1 = r; current.rows.push(cells);
        current.error ||= sem.error; current.streaming ||= sem.streaming;
        return;
      }
      current = { block: sem.block, row0: r, row1: r, firstLine: sem.line, sem, rows: [cells], error: sem.error, streaming: sem.streaming };
      groups.push(current);
    });
    const t = state.theme;
    const out = [];
    for (const group of groups) {
      const counts = new Map();
      for (const cells of group.rows) for (const cell of cells) if (cell.sem && cell.bg !== DEFAULT && !cell.inverse) counts.set(cell.bg, (counts.get(cell.bg) || 0) + 1);
      let dominant = DEFAULT; let best = 0;
      for (const [bg, n] of counts) if (n > best) { best = n; dominant = bg; }
      let col0 = Infinity; let col1 = 0;
      for (const cells of group.rows) {
        cells.forEach((cell, c) => {
          if (!cell.sem) return;
          if (dominant === DEFAULT ? cell.cp !== 32 : cell.bg === dominant) { col0 = Math.min(col0, c); col1 = Math.max(col1, c + 1); }
        });
      }
      if (!Number.isFinite(col0)) continue;
      if (dominant === DEFAULT) { col0 = Math.max(0, col0 - 1); col1 = state.virt.cols - col0; }
      const terminal = group.sem.kind === "bash" || group.sem.role === "bash";
      const status = group.error ? "error" : group.streaming ? "pending" : "done";
      const statusColor = status === "error" ? t.error : status === "pending" ? t.pending : t.speech;
      const base = {
        row0: group.row0, row1: group.row1, col0, col1,
        top: group.firstLine === 0,
        bottom: group.row1 < parsed.length - 1,
        absorbBg: dominant === DEFAULT ? null : new Set([dominant]),
      };
      const glass = cfg().paneStyle !== "solid";
      const opacity = Math.max(0.05, Math.min(1, Number(cfg().paneOpacity) || 0.72));
      const shadow = Number(cfg().panelShadow) || 0;
      out.push(terminal
        ? { ...base, style: `term:${status}:${cfg().paneStyle}:${opacity}`, fill: t.terminalBg, alpha: glass ? opacity : 0.97, border: mixRgb(statusColor, t.terminalBg, 0.4), border2: glass ? mixRgb(t.accent2, t.terminalBg, 0.35) : null, borderAlpha: 0.85, sheen: glass ? 0.05 : 0, shadow, chrome: "terminal", titleFill: mixRgb(t.terminalBg, t.fg, 0.08), suppressRules: true }
        : { ...base, style: `tool:${status}:${cfg().paneStyle}:${opacity}`, fill: mixRgb(t.surface, t.accent, 0.05), alpha: glass ? opacity * 0.8 : 0.9, border: t.accent, border2: glass ? t.accent2 : null, borderAlpha: 0.3, sheen: glass ? 0.04 : 0, shadow, stripe: statusColor });
    }
    return out;
  }

  // Pi composites overlays (dialogs, selectors, settings) into the screen
  // lines; tag each overlay row with its column span so the canvas can give
  // the overlay an opaque panel. Installed on the live renderer instance and
  // inert while the canvas is off.
  const OVERLAY_TAP = Symbol.for("agent-utils.piGraphics.overlayTap");
  function ensureOverlayTap(renderer) {
    if (!renderer || renderer[OVERLAY_TAP] || typeof renderer.compositeLineAt !== "function") return;
    const original = renderer.compositeLineAt;
    renderer.compositeLineAt = function piGraphicsOverlayTap(base, line, col, width, total) {
      const out = original.call(this, base, line, col, width, total);
      return state.active && typeof out === "string" ? `\x1b_pi:gfx:ov:${col}:${width}\x07${out}` : out;
    };
    renderer[OVERLAY_TAP] = original;
  }

  function lightingContext() {
    const shadow = Math.max(0, Math.min(1, Number(cfg().textShadow) || 0));
    const glow = Math.max(0, Math.min(1, Number(cfg().textGlow) || 0));
    if (!shadow && !glow) return null;
    const angle = ((Number(cfg().lightAngle) || 0) * Math.PI) / 180;
    const distance = Math.max(0, Number(cfg().shadowDistance) || 0);
    return { shadow, glow, angle, distance, key: `L${shadow}:${glow}:${cfg().lightAngle}:${distance}` };
  }

  // Editor surface: one smooth image under the editor rows (style, opacity,
  // drop shadow), re-rendered only when the editor rect, style or theme change.
  function surfaceCommands({ force = false } = {}) {
    const surface = state.surface;
    const rect = state.frame?.glowRect;
    const style = cfg().editorStyle;
    const active = rect && bool(cfg().panels, true) && style !== "none" && style !== "classic";
    let out = "";
    if (!active) {
      if (surface.id != null) { out += freeImage(surface.id); state.surface = { key: "", id: null, placedAt: "" }; }
      return out;
    }
    const key = `${style}:${rect.x},${rect.y},${rect.w}x${rect.h}:${cfg().editorOpacity}:${cfg().panelShadow}:${state.theme.surface}:${state.theme.accent}:${state.theme.accent2}`;
    if (key !== surface.key) {
      if (surface.id != null) out += freeImage(surface.id);
      const img = renderEditorSurface({
        width: rect.w, height: rect.h, radius: Math.round(state.fonts.cellHeight * 0.7), style,
        colors: state.theme, opacity: Number(cfg().editorOpacity) || 0.55, shadow: Number(cfg().panelShadow) || 0, scale: 1,
      });
      surface.id = allocateImageId("editor-surface");
      surface.key = key;
      surface.margin = img.margin;
      out += transmit(surface.id, img.rgba, img.width, img.height);
      surface.placedAt = "";
    }
    const at = `${rect.x - surface.margin},${rect.y - surface.margin}`;
    if (force || surface.placedAt !== at) {
      out += placeCropped(surface.id, 1, Math.round(rect.x - surface.margin), Math.round(rect.y - surface.margin), z.surface ?? z.glow + 2);
      surface.placedAt = at;
    }
    return out;
  }

  // Screen-space effects above the text: vignette (low-res, upscaled) and
  // scanlines (a full-width tile placed down the window). Static.
  function screenFxCommands({ force = false } = {}) {
    const fx = state.fx;
    let out = "";
    const { width, height, cols, rows, cellH } = state.real;
    const vignette = Math.max(0, Math.min(1, Number(cfg().vignette) || 0));
    const vKey = vignette > 0 ? `${width}x${height}:${vignette}` : "";
    if (vKey !== fx.vignetteKey) {
      if (fx.vignetteId != null) { out += freeImage(fx.vignetteId); fx.vignetteId = null; }
      fx.vignetteKey = vKey;
      if (vKey) {
        const img = renderVignette({ width: Math.max(16, Math.round(width / 8)), height: Math.max(16, Math.round(height / 8)), strength: vignette });
        fx.vignetteId = allocateImageId("vignette");
        out += transmit(fx.vignetteId, img.rgba, img.width, img.height);
        force = true;
      }
    }
    if (fx.vignetteId != null && force) out += `\x1b[1;1H${serialize({ a: "p", i: fx.vignetteId, p: 1, c: cols, r: rows, C: 1, q: 2, z: z.fx ?? z.overlay })}`;
    const scan = Math.max(0, Math.min(1, Number(cfg().scanlines) || 0));
    const tileRows = 4;
    const sKey = scan > 0 ? `${width}:${cellH}:${scan}` : "";
    if (sKey !== fx.scanKey) {
      if (fx.scanId != null) { out += freeImage(fx.scanId); fx.scanId = null; }
      fx.scanKey = sKey;
      if (sKey) {
        const img = renderScanlines({ width, height: cellH * tileRows, pitch: 3, strength: scan * 0.5 });
        fx.scanId = allocateImageId("scanlines");
        out += transmit(fx.scanId, img.rgba, img.width, img.height);
        force = true;
      }
    }
    if (fx.scanId != null && force) {
      let p = 1;
      for (let row = 0; row < rows; row += tileRows, p += 1) out += `\x1b[${row + 1};1H${serialize({ a: "p", i: fx.scanId, p, C: 1, q: 2, z: z.fx ?? z.overlay })}`;
    }
    return out;
  }

  function overlayPanels(parsed) {
    const panels = []; let current = null;
    parsed.forEach(({ overlay }, r) => {
      if (!overlay) { current = null; return; }
      if (current && current.col0 === overlay.col && current.col1 === overlay.col + overlay.width && current.row1 === r - 1) { current.row1 = r; return; }
      const t = state.theme;
      current = { row0: r, row1: r, col0: overlay.col, col1: overlay.col + overlay.width, style: "overlay", flush: true, fill: mixRgb(t.bg, t.surface, 0.6), alpha: 0.97, border: t.accent, border2: t.accent2, borderAlpha: 0.5, sheen: 0.04, shadow: Number(cfg().panelShadow) || 0 };
      panels.push(current);
    });
    return panels;
  }

  function onFrame(frame, { renderer }) {
    const started = performance.now();
    if (!state.active) return {};
    ensureOverlayTap(renderer);
    try { semanticTick(); } catch {}
    const rows = state.virt.rows; const cols = state.virt.cols;
    const screen = Array.isArray(renderer?.previousScreen) ? renderer.previousScreen : [];
    const cursor = frame.cursor && frame.cursor.row < rows ? frame.cursor : null;
    let out = "";
    // Regenerates only when the key (type, size, theme, loop settings) changed.
    // Regenerates only when the key (type, size, theme, loop settings)
    // changed; a cleared frame just re-asserts the current placements.
    out += backgroundCommands();
    if (frame.cleared && state.background.key && state.background.index >= 0) {
      out += backgroundFrameCommand(state.background.index);
      state.background.tint.key = "";
    }
    const parsed = [];
    const imageSlices = new Map();
    for (let r = 0; r < rows; r += 1) {
      const line = screen[r] ?? "";
      const result = parsedRow(line);
      parsed.push({ line, cells: result.cells, overlay: result.overlay || null });
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
    const tParsed = performance.now();
    renderBudget = HEAVY_RENDERS_PER_TICK;
    const regions = buildRegions(renderer);
    regions.panels.unshift(...toolPanels(parsed));
    regions.panels.push(...overlayPanels(parsed));
    state.frame = { parsed, cursor, imageSlices, lighting: lightingContext(), ...regions };
    const now = Date.now();
    // Typing heat comes from the editor rows the canvas sees, independent of
    // the classic graphics mode (which may be off).
    const editorRect = regions.editorRect;
    if (editorRect && cursor && cursor.row >= editorRect.y && cursor.row < editorRect.y + editorRect.height) {
      let text = ""; let offset = 0;
      for (let r = editorRect.y; r < editorRect.y + editorRect.height && r < rows; r += 1) {
        const rowText = parsed[r].cells.slice(editorRect.x, editorRect.x + editorRect.width).map((c) => (c.cont ? "" : c.ch)).join("");
        if (/^[\s─━═-]*$/.test(rowText)) continue; // rule rows
        if (r === cursor.row) offset = text.length + Math.max(0, cursor.col - editorRect.x);
        text += `${rowText.replace(/\s+$/, "")}\n`;
      }
      try { onEditorText(text, offset); } catch {}
    }
    trackStreamIn(now);
    detectTyped(cursor, now);
    collectOverlays(now);
    const tTracked = performance.now();
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
    const tRows = performance.now();
    state.caret.target = cursor;
    out += glowCommands(now, { force: frame.cleared }) + backgroundAdvance(now) + surfaceCommands({ force: frame.cleared }) + screenFxCommands({ force: frame.cleared }) + caretCommands(now) + impulseCommands(now) + overlayCommands(now);
    const realCursor = cursor
      ? (() => { const p = caretPixel(cursor); const at = cellAt(p.x, p.y); return `\x1b[${at.row + 1};${at.col + 1}H`; })()
      : "";
    state.stats.frames += 1;
    state.stats.lastFrameMs = performance.now() - started;
    if (out.length) trace(`canvas frame ${state.stats.frames} ms=${state.stats.lastFrameMs.toFixed(1)} parse=${(tParsed - started).toFixed(1)} track=${(tTracked - tParsed).toFixed(1)} rows=${(tRows - tTracked).toFixed(1)} fx=${(performance.now() - tRows).toFixed(1)} bytes=${out.length} uploads=${state.stats.uploads}`);
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
    const vy = Math.max(0, Math.min(state.virt.rows - 1, Math.floor((py - state.virt.padY) / state.fonts.cellHeight)));
    const vx = Math.max(0, Math.min(state.virt.cols - 1, Math.floor((px - state.virt.padX - rowIndent(vy)) / state.fonts.cellWidth)));
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
    state.background = freshBackground();
    state.caret = freshCaret();
    state.impulses = [];
    state.impulseIds.clear();
    state.glow = freshGlow();
    state.overlay = { hidden: new Map(), items: new Map(), slots: new Map() };
    state.surface = { key: "", id: null, placedAt: "" };
    state.fx = { vignetteKey: "", vignetteId: null, scanKey: "", scanId: null, scanPlacements: 0 };
    state.typed = [];
    for (const block of state.stream.blocks.values()) { block.hold = null; block.runs = []; }
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
    state.isGhostty = isGhostty;
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
    state.pixelCapable = pixelCapable;
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
    clearTimeout(state.geometryTimer);
    stopWorker();
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

  const GEOMETRY_KEYS = ["fontSizePx", "zoom", "lineHeight", "padding", "fonts", "font", "resolution", "gamma", "cell"];
  /**
   * Apply new settings in place (no stop/start, no terminal probes). Font or
   * grid changes rebuild the atlas and repaint; effect settings take effect
   * on the next frame/tick (their cache keys include the settings).
   */
  function reconfigure(next = {}) {
    const prev = state.config;
    state.config = { ...FULL_CANVAS_DEFAULTS, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== "")) };
    if (!state.active) return status();
    if (S() > 1 && state.isGhostty && process.env.PI_GRAPHICS_FULL_HIDPI_FORCE !== "1") state.config.resolution = 1;
    const changed = (key) => JSON.stringify(prev[key]) !== JSON.stringify(state.config[key]);
    let out = "";
    if (changed("cell")) {
      const explicit = String(cfg().cell || "").match(/^(\d+)\s*[x×,]\s*(\d+)$/);
      if (explicit) pixelGeometry.assume(Number(explicit[1]), Number(explicit[2]));
    }
    if (changed("pixelMouse")) {
      const want = cfg().pixelMouse === "on" || (cfg().pixelMouse === "auto" && state.pixelCapable);
      if (want !== state.pixelMouse) { out += want ? "\x1b[?1016h" : "\x1b[?1016l"; state.pixelMouse = want; }
    }
    if (changed("edgeBlend") || changed("background")) {
      const blend = edgeBlendCommand();
      if (blend) out += blend;
      else if (state.edgeColorSet) { state.edgeColorSet = false; out += "\x1b]111\x07"; }
    }
    trace(`full canvas reconfigure ${Object.keys(state.config).filter(changed).join(",")}`);
    if (out) write(`${BSU}${out}${ESU}`);
    if (GEOMETRY_KEYS.some(changed)) {
      // Font/grid rebuilds are coalesced: holding ←/→ in the settings window
      // repaints once when the value settles, not on every step.
      clearTimeout(state.geometryTimer);
      state.geometryTimer = setTimeout(() => {
        state.geometryTimer = null;
        if (!state.active) return;
        const freed = freeEverything();
        buildFonts();
        computeVirtual();
        write(`${BSU}${freed}${ESU}`);
        try { getTui()?.invalidate?.(); } catch {}
        try { getTui()?.requestRender?.(true); } catch {}
      }, 120);
      state.geometryTimer.unref?.();
      return status();
    }
    try { getTui()?.invalidate?.(); } catch {}
    try { getTui()?.requestRender?.(true); } catch {}
    wake();
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
      background: state.background.key ? { type: state.background.mode, frames: state.background.frames, cached: state.background.ring.filter((id) => id != null).length, size: `${state.background.bw}x${state.background.bh}`, fps: Math.round((state.background.frames / state.background.period) * 10) / 10, speed: Math.round(state.background.speed * 100) / 100 } : null,
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
    reconfigure,
    setTheme,
    status,
    remapInput,
    poke: () => wake(),
  };
}
