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

import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";

import { DEFAULT, parseAnsiLine } from "./ansi-cells.js";
import { cellRole, renderRow } from "./canvas-renderer.js";
import { FontSet } from "./font-atlas.js";
import { decodePng, drawScaledImage } from "./png-decode.js";
import { addRadialGlow, encodeRgbaPng } from "../png-renderer.js";
import { blendMask } from "./raster.js";
import { BACKGROUND_PALETTES, BACKGROUND_SCALE, autoBackground, mixRgb, renderActivityTint, renderBackground, renderCaret, renderEditorGlow, renderEditorSurface, renderGrainTile, renderImpulse, renderPaneBeacon, renderPaneFlash, renderScanlines, renderShimmer, renderVignette } from "./effects.js";

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
  backgroundPalette: "theme", // theme | auto | nord | ocean | sunset | forest | synthwave | ember | mono
  frost: 0.5, // dialogs blur the transcript behind them; panes/editor get a milky, grainy glass
  caretLight: 0.5, // nearby text is lit by the caret (brighter when typing fast)
  caretLightRadius: 6, // cells
  panePulse: true, // a light sweeps along running tools' panes
  paneFlash: true, // a tool pane's border flashes green/red when it finishes
  stickyHeaders: true, // a tool pane's title stays pinned while its output scrolls
  thinkingShimmer: true, // a band of light sweeps across streaming reasoning
  grain: 0, // animated film grain over everything (0 = off)
  grainFps: 12,
  // free: sub-cell grid at the canvas font size. aligned: rows snapped to
  // terminal rows and images padded to whole cells, for multiplexers that
  // re-place images by cell box (herdr). auto: aligned inside a multiplexer.
  grid: "auto",
  tmuxPollMs: 300, // tmux: how often to check the pane's position/visibility
  // tmux drops passthrough from panes that are not visible unless
  // allow-passthrough is "all", so the canvas could not remove itself when
  // you switch windows. Set it on this pane only (restored on stop).
  tmuxPassthroughAll: true,
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

/**
 * One placement inside a tmux pane: the outer cursor is moved to the pane's
 * absolute origin + (row, col) and restored inside a single passthrough, and
 * the placement is cropped to the pane (cells for scaled placements, source
 * pixels for natural ones). pane: { left, top, width, height } in outer cells.
 */
export function tmuxPlacement({ pane, cell, row, col, control, size = null, serializeRaw, wrap }) {
  const width = pane.width || cell.cols; const height = pane.height || cell.rows;
  if (row >= height || col >= width) return "";
  const ctl = { ...control };
  if (ctl.c) ctl.c = Math.min(ctl.c, width - col);
  if (ctl.r) ctl.r = Math.min(ctl.r, height - row);
  if (size && !control.c) {
    const visW = width * cell.cellW - (col * cell.cellW + (ctl.X || 0)); const visH = height * cell.cellH - (row * cell.cellH + (ctl.Y || 0));
    const srcW = size.w - (ctl.x || 0); const srcH = size.h - (ctl.y || 0);
    if (srcW > visW) ctl.w = Math.max(1, visW);
    if (srcH > visH) ctl.h = Math.max(1, visH);
  }
  return wrap(`\x1b7\x1b[${pane.top + row + 1};${pane.left + col + 1}H${serializeRaw(ctl)}\x1b8`);
}

export function createFullCanvas({
  getTui,
  write,
  serialize,
  serializeRaw = serialize, // no multiplexer passthrough wrapping
  wrapPassthrough = (sequence) => sequence,
  allocateImageId,
  z,
  themeColor,
  pixelGeometry,
  getRegions = () => ({}),
  getHeat = () => 0,
  getImpulseAt = () => 0,
  getActivity = () => "idle",
  getPulse = () => 0,
  getThemeName = () => "",
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
    caretLight: { key: "", id: null },
    beacon: { store: freshStore(), slots: new Map() },
    paneFx: freshPaneFx(),
    grain: { store: freshStore(), key: "", frame: -1, placedId: null },
    fx: { vignetteKey: "", vignetteId: null, scanKey: "", scanId: null, scanPlacements: 0 },
    typed: [],
    tmux: { known: false, visible: true, left: 0, top: 0, width: 0, height: 0, timer: null, reassertAt: 0 },
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
  function freshStore() { return { ids: new Map(), ready: new Map(), requested: new Set(), gen: 0 }; }
  // Per-pane effects: finish flashes, pinned headers, thinking shimmer. Each
  // effect keeps its own image store and placement slots.
  function freshPaneFx() {
    return {
      status: new Map(), flashes: [], flashStore: freshStore(), flashSlots: new Map(),
      headers: new Map(), stickyStore: { ids: new Map() }, stickySlots: new Map(),
      shimmerStore: freshStore(), shimmerSlots: new Map(),
    };
  }
  function freshGlow() {
    return { baseKey: "", cache: new Map(), activity: "", index: -1, last: 0, placed: null, flarePlaced: null };
  }
  const cfg = () => state.config;
  // Layer ladder. Canvas layers sit below text (the canvas draws none). Under
  // tmux they also sit below cell backgrounds so tmux's status line, popups
  // and menus cover them; elsewhere they sit ABOVE cell backgrounds, because
  // multiplexers like herdr paint their theme background into every cell.
  const Z_OFFSETS = { background: 0, glow: 4, surface: 8, rows: 12, overlay: 16, fx: 20, caret: 24 };
  const zBase = () => (tmuxMode() ? -1_073_741_900 : (z?.base ?? -1_000_000));
  const Z = new Proxy({}, { get: (_target, key) => (key in Z_OFFSETS ? zBase() + Z_OFFSETS[key] : undefined) });
  let renderBudget = HEAVY_RENDERS_PER_TICK;
  const spendRender = () => (renderBudget > 0 ? (renderBudget -= 1, true) : false);
  const S = () => Math.max(1, Math.min(3, Math.trunc(Number(cfg().resolution) || 1)));
  // Re-emitting multiplexers (herdr, built on libghostty) re-place every
  // image with an explicit cell box covering the cells it touches; the host
  // then scales the image to that box. Snap rows to terminal rows and pad
  // images to whole cells so the box equals the natural size.
  // Which multiplexer (if any) sits between Pi and the terminal. The
  // XTVERSION reply is authoritative (tmux answers "tmux x.y", herdr its
  // embedded "libghostty"); environment variables leak into nested shells and
  // other terminals, so they are only a fallback when nothing answers.
  function muxKind() {
    const name = state.terminalName || "";
    if (/tmux/.test(name)) return "tmux";
    if (/libghostty|herdr/.test(name)) return "herdr";
    if (name && name !== "unknown" && !/^(xterm|screen|tmux)-/.test(name)) return "none";
    if (process.env.TMUX) return "tmux";
    if (process.env.HERDR_ENV) return "herdr";
    return "none";
  }
  const inMultiplexer = () => muxKind() !== "none";
  const gridAligned = () => S() > 1 || cfg().grid === "aligned" || (cfg().grid === "auto" && inMultiplexer());

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
    const padY = gridAligned()
      ? Math.floor((real.rows - rows) / 2) * real.cellH // row-aligned boxes
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
    const snap = gridAligned() ? realCellH : 0;
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

  // ---------------------------------------------------------------- tmux
  // tmux does not track images: passthrough bytes reach the outer terminal
  // wherever tmux's own cursor is. So under tmux every placement moves the
  // OUTER cursor to the pane's absolute origin + cell inside the same
  // passthrough, restores it, and is cropped to the pane. A poller tracks the
  // pane's position and visibility (window switches, zoom, detach).
  const tmuxMode = () => muxKind() === "tmux" && cfg().tmux !== "off";
  const TMUX_FORMAT = "#{pane_left} #{pane_top} #{pane_width} #{pane_height} #{window_active} #{session_attached} #{window_zoomed_flag} #{pane_active} #{status} #{status-position}";
  function pollTmux() {
    if (!state.active || !tmuxMode()) return;
    const args = ["display-message", "-p"];
    if (process.env.TMUX_PANE) args.push("-t", process.env.TMUX_PANE);
    args.push(TMUX_FORMAT);
    execFile("tmux", args, { timeout: 1500 }, (error, stdout) => {
      if (error) trace(`canvas tmux poll failed: ${error.message}`);
      if (error || !state.active) return;
      if (!state.tmux.known || process.env.PI_GRAPHICS_TRACE_TMUX) trace(`canvas tmux pane ${String(stdout).trim()}`);
      const [left, top, width, height, windowActive, attached, zoomed, paneActive, status, statusPosition] = String(stdout).trim().split(/\s+/);
      const statusLines = status === "off" ? 0 : status === "on" ? 1 : Number(status) || 0;
      const next = {
        left: Number(left) || 0,
        top: (Number(top) || 0) + (statusPosition === "top" ? statusLines : 0),
        width: Number(width) || 0, height: Number(height) || 0,
        visible: windowActive === "1" && attached !== "0" && (zoomed !== "1" || paneActive === "1"),
      };
      const pane = state.tmux;
      const moved = !pane.known || pane.left !== next.left || pane.top !== next.top || pane.width !== next.width || pane.height !== next.height;
      const shown = next.visible && (!pane.visible || !pane.known);
      const hidden = !next.visible && pane.visible && pane.known;
      if (hidden) write(deleteAllPlacements());
      Object.assign(pane, next, { known: true });
      if (next.visible && (moved || shown || Date.now() >= pane.reassertAt)) {
        // Re-place everything (tmux may have cleared the screen on redraw).
        pane.reassertAt = Date.now() + 5000;
        write(deleteAllPlacements());
        forgetPlacements();
        try { getTui()?.requestRender?.(true); } catch {}
        wake();
      }
    });
  }
  function tmuxPaneOption(args) {
    return new Promise((resolve) => {
      const target = process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE] : [];
      execFile("tmux", [args[0], "-p", ...target, ...args.slice(1)], { timeout: 1500 }, (error, stdout) => resolve(error ? null : String(stdout).trim()));
    });
  }
  async function ensureTmuxPassthrough() {
    if (!bool(cfg().tmuxPassthroughAll, true)) return;
    // Effective value for this pane (pane, window or global scope).
    const current = await tmuxPaneOption(["show-options", "-Avq", "allow-passthrough"]);
    if (current === "all") return;
    const own = await tmuxPaneOption(["show-options", "-vq", "allow-passthrough"]);
    if ((await tmuxPaneOption(["set-option", "allow-passthrough", "all"])) !== null) {
      state.tmuxRestore = own ? ["set-option", "allow-passthrough", own] : ["set-option", "-u", "allow-passthrough"];
      trace(`canvas tmux allow-passthrough ${current || "?"} → all (this pane)`);
    }
  }

  function deleteAllPlacements() {
    let out = "";
    for (const id of state.ownedImages) out += serialize({ a: "d", d: "i", i: id, q: 2 });
    return out;
  }
  /** Drop placement bookkeeping (images stay uploaded) so all is re-placed. */
  function forgetPlacements() {
    state.slots.clear();
    state.background.placed = null; state.background.index = -1; state.background.tint.key = ""; state.background.tint.placed = null;
    Object.assign(state.glow, { placed: null, flarePlaced: null, flareKey: "", activity: "", index: -1 });
    state.surface.placedAt = "";
    state.caret.shown = null; state.caret.imageId = null;
    state.impulses = [];
    for (const slot of state.overlay.slots.values()) slot.key = "";
    state.caretLight = { key: "", id: state.caretLight.id };
    state.beacon.slots.clear();
    state.paneFx.flashSlots.clear(); state.paneFx.stickySlots.clear(); state.paneFx.shimmerSlots.clear();
    state.grain.placedId = null; state.grain.frame = -1;
    state.fx.vignetteKey = ""; state.fx.scanKey = "";
  }

  /**
   * Emit one placement at a cell (row, col of this pane). size = the drawn
   * pixel size for natural placements, used to crop at the pane edge under
   * tmux; scaled (c/r) placements are clipped by cells.
   */
  function placeAt(row, col, control, size = null) {
    if (!tmuxMode()) return `\x1b[${row + 1};${col + 1}H${serialize(control)}`;
    if (!state.tmux.known || !state.tmux.visible) return "";
    return tmuxPlacement({ pane: state.tmux, cell: state.real, row, col, control, size, serializeRaw, wrap: wrapPassthrough });
  }

  /** Natural-size placement with sub-cell pixel offsets (portable at S=1). */
  function placeNatural(imageId, placementId, px, py, zIndex) {
    const at = cellAt(Math.max(0, px), Math.max(0, py));
    return placeAt(at.row, at.col, { a: "p", i: imageId, p: placementId, X: at.X, Y: at.Y, C: 1, q: 2, z: zIndex });
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
  // "auto" picks a background type and palette from the theme name/brightness.
  function backgroundChoice() {
    let type = cfg().background;
    let palette = cfg().backgroundPalette || "theme";
    if (type === "auto" || palette === "auto") {
      const auto = autoBackground(getThemeName(), state.theme.bg);
      if (type === "auto") type = auto.type;
      if (palette === "auto") palette = auto.palette;
    }
    return { type, palette };
  }
  /** Theme colours with the backdrop palette applied (text/UI keep the theme). */
  function backgroundColors(palette) {
    const p = BACKGROUND_PALETTES[palette];
    return p ? { ...state.theme, ...p } : state.theme;
  }

  function backgroundKey() {
    const { type: mode, palette } = backgroundChoice();
    if (mode === "none" || mode === "transparent") return "";
    const { width, height } = state.real;
    return [mode, palette, width, height, state.theme.bg, state.theme.accent, state.theme.accent2, cfg().backgroundPeriod, cfg().backgroundFps, cfg().backgroundScale, cfg().backgroundBudgetMB].join(":");
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
    const { type: mode, palette } = backgroundChoice();
    const scale = Math.max(1, Number(cfg().backgroundScale) || BACKGROUND_SCALE[mode] || 8);
    const bw = Math.max(16, Math.round(state.real.width / scale)); const bh = Math.max(16, Math.round(state.real.height / scale));
    const animated = mode !== "static";
    const period = Math.max(2, Number(cfg().backgroundPeriod) || 24);
    const budgetFrames = Math.max(2, Math.floor((Math.max(4, Number(cfg().backgroundBudgetMB) || 64) * 1024 * 1024) / (bw * bh * 4)));
    const frames = animated ? Math.max(2, Math.min(budgetFrames, Math.round(period * Math.max(1, Math.min(60, Number(cfg().backgroundFps) || 20))))) : 1;
    Object.assign(state.background, { key, mode, palette, colors: backgroundColors(palette), bw, bh, frames, period, ring: new Array(frames).fill(null), lastTick: Date.now(), ready: new Map(), requested: new Set() });
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
      const frame = renderBackground({ width: bg.bw, height: bg.bh, type: bg.mode, phase: index / bg.frames, colors: bg.colors || state.theme });
      id = allocateImageId(`background-${index}`);
      bg.ring[index] = id;
      out += transmit(id, frame.rgba, frame.width, frame.height);
    }
    if (bg.placed != null && bg.placed !== id) out += deletePlacement(bg.placed, 1);
    out += placeAt(0, 0, { a: "p", i: id, p: 1, c: cols, r: rows, C: 1, q: 2, z: Z.background });
    bg.placed = id;
    bg.index = index;
    return out;
  }

  /** Ask the render worker for a loop frame; false when no worker. */
  function requestBackgroundFrame(index) {
    const bg = state.background;
    if (!bg.key || bg.ring[index] != null || bg.ready.has(index)) return Boolean(bg.key);
    if (bg.requested.has(index)) return true;
    const pending = renderOffThread("background", { width: bg.bw, height: bg.bh, type: bg.mode, phase: index / bg.frames, colors: bg.colors || state.theme });
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
    const t = state.background.colors || state.theme;
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
    out += placeAt(0, 0, { a: "p", i: id, p: 1, c: state.real.cols, r: state.real.rows, C: 1, q: 2, z: Z.background + 1 });
    tint.placed = id;
    return out;
  }

  function currentActivity() {
    const heat = Math.max(0, Math.min(1, Number(getHeat()) || 0));
    const activity = getActivity() || "idle";
    return activity === "idle" && heat > 0.12 ? "typing" : activity;
  }

  function edgeBlendCommand() {
    const bgType = backgroundChoice().type;
    if (!bool(cfg().edgeBlend, true) || bgType === "transparent" || bgType === "none") return "";
    // Inside tmux, OSC 11 sets the PANE's default background, which tmux then
    // paints explicitly into every cell (hiding canvas layers below cell
    // backgrounds); and a pane has no window padding to blend into.
    if (tmuxMode()) return "";
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

  /** The part of a panel that falls on one row. */
  function paneSlice(p, rowIndex) {
    return {
      ...p,
      start: p.col0, end: p.col1,
      top: rowIndex === p.row0 && p.top !== false, bottom: rowIndex === p.row1 && p.bottom !== false,
      // Full extent relative to this row (clamped: beyond ±3 rows a slice
      // is identical, so tall panels still share cached middle strips).
      relTop: p.top === false ? -3 : Math.max(-3, p.row0 - rowIndex),
      relBottom: p.bottom === false ? 3 : Math.min(3, p.row1 - rowIndex),
      suppressRules: p.suppressRules && (rowIndex === p.row0 || rowIndex === p.row1),
    };
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
    const rowPanels = frame.panels.filter((p) => rowIndex >= p.row0 && rowIndex <= p.row1).map((p) => paneSlice(p, rowIndex));
    const regionRole = frame.regionRoles.get(rowIndex) || null;
    const slice = frame.imageSlices.get(rowIndex);
    const lighting = frame.lighting;
    const xOffset = regionRole === "editor" ? frame.editorIndent || 0 : 0;
    const frost = frame.frostRows?.get(rowIndex) || null;
    const hidden = state.overlay.hidden.get(rowIndex) || null;
    const scale = S();
    const geo = stripGeometry(rowIndex);
    const box = gridAligned() ? cellBox(geo.lx, geo.ly, geo.lw, geo.lh) : null;
    const key = [
      state.virt.cols, line, cursorCol, sigKey(above), sigKey(below), regionRole || "",
      rowPanels.map((p) => `${p.style || ""}${p.flush ? "f" : ""}${p.start}-${p.end}:${p.relTop},${p.relBottom}:${p.top ? 1 : 0}${p.bottom ? 1 : 0}${p.fill}:${p.alpha}:${p.border}:${p.border2 || ""}:${p.sheen || 0}:${p.shadow || 0}:${p.absorbBg ? [...p.absorbBg].join("/") : ""}`).join("|"),
      slice ? `${slice.id}:${slice.index}` : "",
      hidden ? [...hidden].sort((a, b) => a - b).join(",") : "",
      box ? `${scale}:${box.offX.toFixed(1)}:${box.offY.toFixed(1)}:${box.c}x${box.r}` : "",
      lighting ? lighting.key : "",
      xOffset,
      frost ? frost.key : "",
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
      regionRole, hiddenCols: hidden, lighting, xOffset, frostCells: frost?.cells || null,
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
    const geo = stripGeometry(rowIndex);
    if (entry.box) {
      // Strips are content-keyed and reused at any row (scrolling): the box's
      // size and sub-cell phase are part of the key, but its position must
      // come from the row it is placed on NOW, never the row it was cut for.
      const at = cellBox(geo.lx, geo.ly, geo.lw, geo.lh);
      return placeAt(at.row0, at.col0, { a: "p", i: entry.imageId, p: rowIndex + 1, c: entry.box.c, r: entry.box.r, C: 1, q: 2, z: Z.rows });
    }
    return placeNatural(entry.imageId, rowIndex + 1, geo.lx, geo.ly, Z.rows);
  }

  function updateRow(rowIndex, force = false) {
    const { key, entry, upload } = renderStrip(rowIndex);
    let out = upload;
    const slot = state.slots.get(rowIndex);
    // Placement position depends on the grid (resize, padding, pane moves),
    // not only on content: re-place when either changes.
    const geo = stripGeometry(rowIndex);
    const at = `${geo.lx},${geo.ly},${state.real.cellW}x${state.real.cellH}`;
    if (slot && slot.key === key && slot.at === at && !force) return { out, key };
    if (slot?.imageId != null && slot.imageId !== entry?.imageId) out += deletePlacement(slot.imageId, rowIndex + 1);
    if (entry) out += placeRow(rowIndex, entry);
    state.slots.set(rowIndex, { key, imageId: entry?.imageId ?? null, at });
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
      const img = alignedImage(fb, w, h, state.virt.padX + minCol * cw - pad + rowIndent(row), state.virt.padY + (row - above) * ch);
      out += transmit(imageId, img.rgba, img.w, img.h);
      out += placeCropped(imageId, 1, img.px, img.py, Z.overlay, { w: img.w, h: img.h });
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
      caret.size = { w: img.width, h: img.height };
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
    out += placeCropped(image.id, 1, px, py, Z.caret, caret.size);
    caret.imageId = image.id;
    caret.shown = { x: px, y: py };
    return out;
  }

  /**
   * Aligned grid mode: pad an image so it starts on a cell boundary and spans
   * whole cells (offset baked in), so a multiplexer's cell box equals its
   * natural size. Identity otherwise.
   */
  function alignedImage(rgba, w, h, px, py) {
    px = Math.round(px); py = Math.round(py);
    if (!gridAligned()) return { rgba, w, h, px, py };
    const { cellW, cellH } = state.real;
    const col0 = Math.floor(px / cellW); const row0 = Math.floor(py / cellH);
    const offX = px - col0 * cellW; const offY = py - row0 * cellH;
    const bw = Math.ceil((offX + w) / cellW) * cellW; const bh = Math.ceil((offY + h) / cellH) * cellH;
    const out = Buffer.alloc(bw * bh * 4);
    for (let y = 0; y < h; y += 1) rgba.copy(out, ((y + offY) * bw + offX) * 4, y * w * 4, (y + 1) * w * 4);
    return { rgba: out, w: bw, h: bh, px: col0 * cellW, py: row0 * cellH };
  }

  function placeCropped(imageId, placementId, px, py, zIndex, size = null) {
    const cropX = Math.max(0, -px); const cropY = Math.max(0, -py);
    const at = cellAt(Math.max(0, px), Math.max(0, py));
    const control = { a: "p", i: imageId, p: placementId, X: at.X, Y: at.Y, C: 1, q: 2, z: zIndex };
    if (cropX || cropY) Object.assign(control, { x: cropX, y: cropY });
    return placeAt(at.row, at.col, control, size);
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
      out += placeCropped(id, impulse.slot, Math.round(impulse.at.x - anchor.x), Math.round(impulse.at.y - anchor.y), Z.overlay, { w: 9 * fonts.cellWidth, h: 5 * fonts.cellHeight });
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
        if (glow.placed !== image.id || force) out += placeCropped(image.id, 1, px, py, Z.glow, { w: rect.w + margin * 2, h: rect.h + margin * 2 });
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
        if (image) { out += image.out + placeCropped(image.id, 1, px, py, Z.glow + 1, { w: rect.w + margin * 2, h: rect.h + margin * 2 }); glow.flarePlaced = image.id; }
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
    if (state.beacon.slots.size || (Number(cfg().grain) > 0 && Number(cfg().grainFps) > 0)) return true;
    if (state.paneFx.flashes.length || state.paneFx.flashSlots.size || state.paneFx.shimmerSlots.size) return true;
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
    out += timed("glow", () => glowCommands(now)) + timed("bg", () => backgroundAdvance(now)) + timed("caret", () => caretCommands(now) + caretLightCommands() + impulseCommands(now)) + timed("fx", () => beaconCommands(now) + (trackPaneStatus(now), paneFlashCommands(now)) + shimmerCommands(now) + grainCommands(now)) + timed("ov", () => overlayCommands(now));
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
      // Remember each pane's title row so it can stay pinned while the pane
      // scrolls past it.
      // (the first non-blank line: tool cards start with a padding row).
      if (group.firstLine === 0) {
        const titleIndex = group.rows.slice(0, 3).findIndex((cells) => cells.some((c) => c.sem && !c.cont && c.cp !== 32 && c.cp !== 0));
        if (titleIndex >= 0) rememberPaneHeader(group.block, group.rows[titleIndex], titleIndex);
      }
      const base = {
        block: group.block, status, firstLine: group.firstLine, terminal: group.sem.kind === "bash" || group.sem.role === "bash",
        row0: group.row0, row1: group.row1, col0, col1, pending: status === "pending", frost: glassFrost(),
        top: group.firstLine === 0,
        bottom: group.row1 < parsed.length - 1,
        absorbBg: dominant === DEFAULT ? null : new Set([dominant]),
      };
      const glass = cfg().paneStyle !== "solid";
      const opacity = Math.max(0.05, Math.min(1, Number(cfg().paneOpacity) || 0.72));
      base.style = `f${base.frost}`;
      const shadow = Number(cfg().panelShadow) || 0;
      out.push(terminal
        ? { ...base, style: `term:${status}:${cfg().paneStyle}:${opacity}:${base.style}`, fill: t.terminalBg, alpha: glass ? opacity : 0.97, border: mixRgb(statusColor, t.terminalBg, 0.4), border2: glass ? mixRgb(t.accent2, t.terminalBg, 0.35) : null, borderAlpha: 0.85, sheen: glass ? 0.05 : 0, shadow, chrome: "terminal", titleFill: mixRgb(t.terminalBg, t.fg, 0.08), suppressRules: true }
        : { ...base, style: `tool:${status}:${cfg().paneStyle}:${opacity}:${base.style}`, fill: mixRgb(t.surface, t.accent, 0.05), alpha: glass ? opacity * 0.8 : 0.9, border: t.accent, border2: glass ? t.accent2 : null, borderAlpha: 0.3, sheen: glass ? 0.04 : 0, shadow, stripe: statusColor });
    }
    return out;
  }

  function rememberPaneHeader(block, cells, line) {
    const headers = state.paneFx.headers;
    const key = cells.map((c) => `${c.cp}:${c.fg}:${c.bg}:${c.bold ? 1 : 0}`).join(",");
    if (headers.get(block)?.key === key) return;
    headers.delete(block);
    headers.set(block, { key, cells, line });
    while (headers.size > 64) headers.delete(headers.keys().next().value);
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
      if (!state.active || typeof out !== "string") return out;
      // Remember the transcript line the overlay covers (content-keyed, so
      // unchanged rows keep their cached strips) for frosted-glass dialogs.
      const baseKey = typeof base === "string" && base ? rememberOverlayBase(base) : "";
      return `\x1b_pi:gfx:ov:${col}:${width}${baseKey ? `:${baseKey}` : ""}\x07${out}`;
    };
    renderer[OVERLAY_TAP] = original;
  }

  const overlayBases = new Map();
  function rememberOverlayBase(base) {
    let h = 2166136261;
    for (let i = 0; i < base.length; i += 1) { h ^= base.charCodeAt(i); h = Math.imul(h, 16777619); }
    const key = (h >>> 0).toString(36) + base.length.toString(36);
    overlayBases.delete(key); overlayBases.set(key, base);
    while (overlayBases.size > 512) overlayBases.delete(overlayBases.keys().next().value);
    return key;
  }

  // Panes behind which only the soft background shows get a milky, grainy
  // frost (half strength) rather than a blur.
  function glassFrost() {
    return cfg().paneStyle === "solid" ? 0 : Math.round(Math.max(0, Math.min(1, Number(cfg().frost) || 0)) * 50) / 100;
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
    const key = `${style}:${rect.x},${rect.y},${rect.w}x${rect.h}:${cfg().editorOpacity}:${cfg().panelShadow}:${glassFrost()}:${state.theme.surface}:${state.theme.accent}:${state.theme.accent2}`;
    if (key !== surface.key) {
      if (surface.id != null) out += freeImage(surface.id);
      const img = renderEditorSurface({
        width: rect.w, height: rect.h, radius: Math.round(state.fonts.cellHeight * 0.7), style,
        colors: state.theme, opacity: Number(cfg().editorOpacity) || 0.55, shadow: Number(cfg().panelShadow) || 0, scale: 1, frost: glassFrost(),
      });
      surface.id = allocateImageId("editor-surface");
      surface.key = key;
      surface.margin = img.margin;
      surface.size = { w: img.width, h: img.height };
      out += transmit(surface.id, img.rgba, img.width, img.height);
      surface.placedAt = "";
    }
    const at = `${rect.x - surface.margin},${rect.y - surface.margin}`;
    if (force || surface.placedAt !== at) {
      out += placeCropped(surface.id, 1, Math.round(rect.x - surface.margin), Math.round(rect.y - surface.margin), Z.surface, surface.size);
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
    if (fx.vignetteId != null && force) out += placeAt(0, 0, { a: "p", i: fx.vignetteId, p: 1, c: cols, r: rows, C: 1, q: 2, z: Z.fx });
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
      for (let row = 0; row < rows; row += tileRows, p += 1) out += placeAt(row, 0, { a: "p", i: fx.scanId, p, C: 1, q: 2, z: Z.fx }, { w: width, h: cellH * tileRows });
    }
    return out;
  }

  // Off-thread image store: cached ids, finished renders awaiting upload,
  // and in-flight requests (falls back to a budgeted synchronous render).
  function workerImage(store, key, kind, args, renderSync) {
    let id = store.ids.get(key);
    if (id != null) return { id, out: "" };
    const ready = store.ready.get(key);
    if (ready) {
      store.ready.delete(key);
      id = allocateImageId(`${kind}-${key}`);
      store.ids.set(key, id);
      return { id, out: transmitEncoded(id, ready.base64) };
    }
    if (store.requested.has(key)) return null;
    const pending = renderOffThread(kind, args);
    if (pending) {
      store.requested.add(key);
      const gen = store.gen;
      pending.then((result) => {
        if (store.gen !== gen) return;
        store.requested.delete(key);
        if (result?.ok) { store.ready.set(key, result); wake(); }
      });
      return null;
    }
    if (!spendRender()) return null;
    const img = renderSync(args);
    id = allocateImageId(`${kind}-${key}`);
    store.ids.set(key, id);
    return { id, out: transmit(id, img.rgba, img.width, img.height) };
  }
  function freeStore(store) {
    let out = "";
    for (const id of store.ids.values()) out += freeImage(id);
    store.ids.clear(); store.ready.clear(); store.requested.clear(); store.gen += 1;
    return out;
  }

  // Caret light: glyphs near the caret are redrawn brighter in a light
  // tint above the rows, falling off with distance; hotter and wider when
  // typing fast. Re-rendered only when the caret, heat level or nearby text
  // change.
  function caretLightCommands() {
    const light = state.caretLight;
    const amount = Math.max(0, Math.min(1, Number(cfg().caretLight) || 0));
    const target = state.caret.target;
    const frame = state.frame;
    const remove = () => {
      if (light.id == null) return "";
      const out = freeImage(light.id);
      state.caretLight = { key: "", id: null };
      return out;
    };
    if (!amount || !target || !frame || cfg().caretStyle === "off") return remove();
    const fonts = state.fonts; const cw = fonts.cellWidth; const ch = fonts.cellHeight;
    const heat = Math.max(0, Math.min(1, Number(getHeat()) || 0));
    const heatBucket = Math.round(heat * 4);
    const radius = Math.max(2, Number(cfg().caretLightRadius) || 6) * (1 + heatBucket * 0.12);
    const rx = Math.ceil(radius); const ry = Math.max(1, Math.ceil((radius * cw) / (ch * 1.2)));
    const rows = frame.parsed.length;
    const row0 = Math.max(0, target.row - ry); const row1 = Math.min(rows - 1, target.row + ry);
    const col0 = Math.max(0, target.col - rx); const col1 = Math.min(state.virt.cols, target.col + rx + 1);
    const lines = [];
    for (let r = row0; r <= row1; r += 1) lines.push(`${frame.parsed[r].line}|${[...(state.overlay.hidden.get(r) || [])].join(",")}`);
    const key = `${target.row}:${target.col}:${heatBucket}:${amount}:${radius}:${rowIndent(target.row)}:${lines.join("\u0002")}`;
    if (key === light.key) return "";
    let out = remove();
    const maxIndent = Math.max(0, frame.editorIndent || 0);
    const w = (col1 - col0) * cw + maxIndent + cw; const h = (row1 - row0 + 1) * ch;
    const fb = Buffer.alloc(w * h * 4);
    const t = state.theme;
    const lamp = mixRgb(mixRgb(t.accent, [255, 255, 255], 0.65), t.warm, heat * 0.5);
    const cx = (target.col + 0.5) * cw + rowIndent(target.row); const cy = (target.row + 0.5) * ch;
    let lit = 0;
    for (let r = row0; r <= row1; r += 1) {
      const cells = frame.parsed[r].cells;
      const hidden = state.overlay.hidden.get(r);
      const indent = rowIndent(r);
      const regionRole = frame.regionRoles.get(r) || null;
      for (let c = col0; c < col1; c += 1) {
        const cell = cells[c];
        if (!cell || cell.cont || cell.hidden || cell.cp === 32 || cell.cp === 0 || cell.inverse || hidden?.has(c)) continue;
        const d = Math.hypot((c + 0.5) * cw + indent - cx, ((r + 0.5) * ch - cy) * 1.2) / (radius * cw);
        if (d >= 1) continue;
        const fall = (1 - d) * (1 - d) * amount * (0.6 + 0.4 * heat);
        const atlas = fonts.forRole(cellRole(cell, { regionRole, theme: t }));
        const mask = atlas.supersample > 1 ? null : atlas.mask(cell.cp, { bold: cell.bold, italic: cell.italic, cells: cell.wide ? 2 : 1 });
        if (!mask) continue;
        const fg = cell.fg === DEFAULT ? t.fg : [(cell.fg >> 16) & 255, (cell.fg >> 8) & 255, cell.fg & 255];
        const color = mixRgb(fg, lamp, 0.65);
        blendMask(fb, w, h, mask, (c - col0) * cw + indent + mask.left, (r - row0) * ch + mask.top, ...color, Math.round(255 * Math.min(1, fall)));
        lit += 1;
      }
    }
    state.caretLight.key = key;
    if (!lit) return out;
    const id = allocateImageId("caret-light");
    const img = alignedImage(fb, w, h, state.virt.padX + col0 * cw, state.virt.padY + row0 * ch);
    out += transmit(id, img.rgba, img.w, img.h);
    out += placeCropped(id, 1, img.px, img.py, Z.rows + 1, { w: img.w, h: img.h });
    state.caretLight = { key, id };
    return out;
  }

  // Running-tool beacon: a light sweeping along the top (or bottom) edge of
  // each pending tool pane. Frames are cached per pane width, rendered on
  // the worker; panes keep their own placement slot.
  const BEACON_FRAMES = 16;
  function beaconCommands(now, { force = false } = {}) {
    const beacon = state.beacon;
    let out = "";
    const panes = bool(cfg().panePulse, true) ? (state.frame?.panels || []).filter((p) => p.pending).slice(0, 4) : [];
    const fonts = state.fonts; const cw = fonts.cellWidth; const ch = fonts.cellHeight;
    const frame = Math.floor(now / 62) % BEACON_FRAMES;
    const wanted = new Map();
    panes.forEach((pane, k) => {
      const atTop = pane.top !== false; const atBottom = pane.bottom !== false;
      if (!atTop && !atBottom) return;
      const inset = Math.min(state.virt.marginX, Math.round(cw * 0.8));
      const x = state.virt.padX + pane.col0 * cw - inset;
      const width = Math.round((pane.col1 - pane.col0) * cw + inset * 2);
      const edgeY = atTop ? state.virt.padY + pane.row0 * ch + ch * 0.45 : state.virt.padY + (pane.row1 + 1) * ch - ch * 0.45;
      const h = Math.max(4, Math.round(ch * 1.4));
      wanted.set(k + 1, { x, y: Math.round(edgeY - h / 2), width });
    });
    for (const [slot, placed] of beacon.slots) {
      if (wanted.has(slot)) continue;
      out += deletePlacement(placed.id, slot);
      beacon.slots.delete(slot);
    }
    for (const [slot, want] of wanted) {
      const key = `${want.width}:${frame}`;
      const img = workerImage(beacon.store, key, "beacon", { width: want.width, cellHeight: ch, frame, frames: BEACON_FRAMES, colors: state.theme }, renderPaneBeacon);
      if (!img) continue;
      out += img.out;
      const placed = beacon.slots.get(slot);
      if (!force && placed && placed.id === img.id && placed.x === want.x && placed.y === want.y) continue;
      if (placed && placed.id !== img.id) out += deletePlacement(placed.id, slot);
      out += placeCropped(img.id, slot, want.x, want.y, Z.overlay, { w: want.width, h: Math.max(4, Math.round(ch * 1.4)) });
      beacon.slots.set(slot, { id: img.id, x: want.x, y: want.y });
    }
    // Bound cached widths (16 frames each).
    if (beacon.store.ids.size > BEACON_FRAMES * 3) out += freeStore(beacon.store);
    return out;
  }

  // ------------------------------------------------------------ pane effects
  // Finish flash: when a tool pane goes from running to done/failed its
  // border lights up in the outcome colour and fades (FLASH_STEPS frames,
  // rendered off-thread, cached per pane size and outcome).
  const FLASH_STEPS = 9; const FLASH_MS = 1100;
  function paneMargin() { return Math.max(4, Math.min(state.virt.marginX + Math.round(state.fonts.cellHeight * 0.5), Math.round(state.fonts.cellWidth * 2.4))); }
  function paneRect(pane) {
    const cw = state.fonts.cellWidth; const ch = state.fonts.cellHeight;
    const inset = Math.min(state.virt.marginX, Math.round(cw * 0.8));
    const top = pane.top !== false ? ch * 0.45 : 0; const bottom = pane.bottom !== false ? ch * 0.45 : 0;
    return {
      x: Math.round(state.virt.padX + pane.col0 * cw - inset),
      y: Math.round(state.virt.padY + pane.row0 * ch + top),
      w: Math.round((pane.col1 - pane.col0) * cw + inset * 2),
      h: Math.max(4, Math.round((pane.row1 - pane.row0 + 1) * ch - top - bottom)),
    };
  }
  function trackPaneStatus(now) {
    const fx = state.paneFx;
    const panes = (state.frame?.panels || []).filter((p) => p.block && p.status);
    for (const pane of panes) {
      const before = fx.status.get(pane.block);
      if (before === "pending" && pane.status !== "pending" && bool(cfg().paneFlash, true)) {
        fx.flashes = fx.flashes.filter((f) => f.block !== pane.block);
        fx.flashes.push({ block: pane.block, status: pane.status, at: now });
        if (process.env.PI_GRAPHICS_TRACE_FX) trace(`canvas pane flash ${pane.block} ${pane.status}`);
        if (fx.flashes.length > 4) fx.flashes.shift();
      }
      fx.status.delete(pane.block); fx.status.set(pane.block, pane.status);
    }
    while (fx.status.size > 256) fx.status.delete(fx.status.keys().next().value);
    fx.flashes = fx.flashes.filter((f) => now - f.at < FLASH_MS);
  }
  function paneFlashCommands(now, { force = false } = {}) {
    const fx = state.paneFx;
    let out = "";
    const panes = state.frame?.panels || [];
    const wanted = new Map();
    fx.flashes.forEach((flash, k) => {
      const pane = panes.find((p) => p.block === flash.block);
      if (!pane) return;
      const step = Math.min(FLASH_STEPS - 1, Math.floor(((now - flash.at) / FLASH_MS) * FLASH_STEPS));
      wanted.set(k + 1, { pane, rect: paneRect(pane), status: flash.status, step });
    });
    for (const [slot, placed] of fx.flashSlots) {
      if (wanted.has(slot)) continue;
      out += deletePlacement(placed.id, slot);
      fx.flashSlots.delete(slot);
    }
    const margin = paneMargin(); const radius = Math.round(state.fonts.cellHeight * 0.5);
    for (const [slot, want] of wanted) {
      const { rect } = want;
      const key = `${rect.w}x${rect.h}:${want.status}:${want.step}`;
      const img = workerImage(fx.flashStore, key, "flash", { width: rect.w, height: rect.h, margin, radius, status: want.status, step: want.step, steps: FLASH_STEPS, colors: state.theme, intensity: cfg().glowIntensity ?? 1 }, renderPaneFlash);
      if (!img) continue;
      out += img.out;
      const x = rect.x - margin; const y = rect.y - margin;
      const placed = fx.flashSlots.get(slot);
      if (!force && placed && placed.id === img.id && placed.x === x && placed.y === y) continue;
      if (placed && placed.id !== img.id) out += deletePlacement(placed.id, slot);
      out += placeCropped(img.id, slot, x, y, Z.overlay + 1, { w: rect.w + margin * 2, h: rect.h + margin * 2 });
      fx.flashSlots.set(slot, { id: img.id, x, y });
    }
    if (fx.flashStore.ids.size > FLASH_STEPS * 6 && !fx.flashes.length) out += freeStore(fx.flashStore);
    return out;
  }

  // Sticky headers: while a tool pane's title row is scrolled out of view,
  // its remembered title is drawn as a floating card on the pane's first
  // visible row.
  function stickyCommands({ force = false } = {}) {
    const fx = state.paneFx;
    let out = "";
    const wanted = new Map();
    if (bool(cfg().stickyHeaders, true)) {
      (state.frame?.panels || [])
        .filter((p) => p.block && p.top === false && p.row1 > p.row0 && fx.headers.has(p.block) && (p.firstLine ?? 0) > fx.headers.get(p.block).line)
        .slice(0, 4)
        .forEach((pane, k) => wanted.set(k + 1, pane));
    }
    for (const [slot, placed] of fx.stickySlots) {
      if (wanted.has(slot)) continue;
      out += deletePlacement(placed.id, slot);
      fx.stickySlots.delete(slot);
    }
    for (const [slot, pane] of wanted) {
      const header = fx.headers.get(pane.block);
      const row = pane.row0;
      // A flush one-row card in the title-band colour (no band: its rule
      // would cross the text), with the pane's border and status stripe.
      const slice = { ...paneSlice({ ...pane, top: true, bottom: true, row0: row, row1: row }, row), chrome: null, flush: true, fill: pane.titleFill || pane.fill, alpha: 1, shadow: 0, sheen: 0.08, frost: 0 };
      const key = `${header.key}|${slice.style}|${slice.start}-${slice.end}|${state.virt.cols}|${S()}`;
      // Rendered and placed exactly like a row strip (HiDPI and aligned
      // grids use whole-cell boxes).
      const geo = stripGeometry(row);
      const box = gridAligned() ? cellBox(geo.lx, geo.ly, geo.lw, geo.lh) : null;
      const fullKey = `${key}|${box ? `${box.offX.toFixed(1)}:${box.offY.toFixed(1)}:${box.c}x${box.r}` : ""}`;
      let id = fx.stickyStore.ids.get(fullKey);
      if (id == null) {
        const scale = S();
        const strip = renderRow(header.cells, { fonts: state.fonts, cols: state.virt.cols, theme: state.theme, cursorCol: -1, scale, panels: [slice], marginX: state.virt.marginX, regionRole: null, lighting: state.frame?.lighting });
        if (strip.empty) continue;
        opaqueCardBehind(strip, pane, scale);
        const image = box ? boxed(strip.rgba, strip.width, strip.height, box, scale) : strip;
        id = allocateImageId(`sticky-${pane.block}`);
        out += transmit(id, image.rgba, image.width, image.height);
        fx.stickyStore.ids.set(fullKey, id);
        if (fx.stickyStore.ids.size > 24) {
          const [oldKey, oldId] = fx.stickyStore.ids.entries().next().value;
          if (![...fx.stickySlots.values()].some((p) => p.id === oldId)) { fx.stickyStore.ids.delete(oldKey); out += freeImage(oldId); }
        }
      }
      const at = `${geo.lx},${geo.ly},${state.real.cellW}x${state.real.cellH}`;
      const placed = fx.stickySlots.get(slot);
      if (!force && placed && placed.id === id && placed.at === at) continue;
      if (placed && placed.id !== id) out += deletePlacement(placed.id, slot);
      if (box) {
        const cell = cellBox(geo.lx, geo.ly, geo.lw, geo.lh);
        out += placeAt(cell.row0, cell.col0, { a: "p", i: id, p: slot, c: box.c, r: box.r, C: 1, q: 2, z: Z.overlay });
      } else {
        out += placeNatural(id, slot, geo.lx, geo.ly, Z.overlay);
      }
      fx.stickySlots.set(slot, { id, at });
    }
    return out;
  }

  // The pinned title must hide the output row it floats over: composite the
  // rendered title onto an opaque rounded card in the pane's colour.
  function opaqueCardBehind(strip, pane, scale) {
    const cw = state.fonts.cellWidth * scale;
    const inset = Math.min(state.virt.marginX, Math.round(state.fonts.cellWidth * 0.8)) * scale;
    const x0 = Math.max(0, Math.round(state.virt.marginX * scale + pane.col0 * cw - inset));
    const x1 = Math.min(strip.width, Math.round(state.virt.marginX * scale + pane.col1 * cw + inset));
    const h = strip.height; const radius = Math.min(h / 2, Math.round(state.fonts.cellHeight * 0.4 * scale));
    const fill = pane.titleFill || pane.fill || state.theme.surface;
    const buf = strip.rgba;
    for (let y = 0; y < h; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        // rounded-rect coverage (1px anti-aliased edge)
        const dx = Math.max(x0 + radius - (x + 0.5), (x + 0.5) - (x1 - radius), 0);
        const dy = Math.max(radius - (y + 0.5), (y + 0.5) - (h - radius), 0);
        const cover = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(dx, dy)));
        if (cover <= 0) continue;
        const i = (y * strip.width + x) * 4; const a = buf[i + 3] / 255;
        // strip pixel over the card, then the result at the card's coverage
        const r = buf[i] * a + fill[0] * (1 - a); const g = buf[i + 1] * a + fill[1] * (1 - a); const b = buf[i + 2] * a + fill[2] * (1 - a);
        const outA = cover + a * (1 - cover);
        buf[i] = Math.round((r * cover + buf[i] * a * (1 - cover)) / outA);
        buf[i + 1] = Math.round((g * cover + buf[i + 1] * a * (1 - cover)) / outA);
        buf[i + 2] = Math.round((b * cover + buf[i + 2] * a * (1 - cover)) / outA);
        buf[i + 3] = Math.round(255 * outA);
      }
    }
  }

  // Thinking shimmer: a diagonal band of light sweeps across reasoning while
  // it streams. One image per block size; only its placement moves.
  const SHIMMER_PERIOD = 2200;
  function shimmerCommands(now, { force = false } = {}) {
    const fx = state.paneFx;
    let out = "";
    const wanted = new Map();
    const parsed = state.frame?.parsed || [];
    if (bool(cfg().thinkingShimmer, true)) {
      let run = null;
      parsed.forEach(({ cells }, r) => {
        const sem = semOf(cells);
        const thinking = sem && sem.role === "thinking" && sem.streaming;
        if (thinking && run && run.block === sem.block && run.row1 === r - 1) { run.row1 = r; return; }
        if (thinking) { run = { block: sem.block, row0: r, row1: r }; if (wanted.size < 2) wanted.set(wanted.size + 1, run); } else run = null;
      });
    }
    for (const [slot, placed] of fx.shimmerSlots) {
      if (wanted.has(slot)) continue;
      out += deletePlacement(placed.id, slot);
      fx.shimmerSlots.delete(slot);
    }
    const cw = state.fonts.cellWidth; const ch = state.fonts.cellHeight;
    for (const [slot, run] of wanted) {
      const height = (run.row1 - run.row0 + 1) * ch;
      const width = Math.round(Math.min(state.virt.cols, 28) * cw);
      const key = `${width}x${height}`;
      const img = workerImage(fx.shimmerStore, key, "shimmer", { width, height, colors: state.theme, intensity: cfg().glowIntensity ?? 1 }, renderShimmer);
      if (!img) continue;
      out += img.out;
      const span = state.virt.cols * cw + width;
      const phase = (now % SHIMMER_PERIOD) / SHIMMER_PERIOD;
      const x = Math.round(state.virt.padX - width + phase * span);
      const y = Math.round(state.virt.padY + run.row0 * ch);
      const placed = fx.shimmerSlots.get(slot);
      if (!force && placed && placed.id === img.id && placed.x === x && placed.y === y) continue;
      if (placed && placed.id !== img.id) out += deletePlacement(placed.id, slot);
      out += placeCropped(img.id, slot, x, y, Z.overlay + 2, { w: width, h: height });
      fx.shimmerSlots.set(slot, { id: img.id, x, y });
    }
    if (fx.shimmerStore.ids.size > 8 && !wanted.size) out += freeStore(fx.shimmerStore);
    return out;
  }

  // Film grain: one 256px noise tile tiled over the window, swapping between
  // a few tiles at grainFps (deletes all placements of the old tile at once).
  const GRAIN_TILES = 4; const GRAIN_SIZE = 256;
  function grainCommands(now, { force = false } = {}) {
    const grain = state.grain;
    const amount = Math.max(0, Math.min(1, Number(cfg().grain) || 0));
    const key = amount > 0 ? `${amount}:${state.real.width}x${state.real.height}` : "";
    let out = "";
    if (key !== grain.key) {
      if (grain.placedId != null) out += serialize({ a: "d", d: "i", i: grain.placedId, q: 2 });
      out += freeStore(grain.store);
      grain.key = key; grain.frame = -1; grain.placedId = null;
      force = true;
    }
    if (!key) return out;
    const fps = Math.max(0, Math.min(30, Number(cfg().grainFps) || 0));
    const frame = fps > 0 ? Math.floor(now / (1000 / fps)) % GRAIN_TILES : 0;
    if (frame === grain.frame && !force) return out;
    const img = workerImage(grain.store, frame, "grain", { size: GRAIN_SIZE, strength: amount, seed: frame + 1 }, renderGrainTile);
    if (!img) return out;
    out += img.out;
    if (grain.placedId != null && grain.placedId !== img.id) out += serialize({ a: "d", d: "i", i: grain.placedId, q: 2 });
    if (grain.placedId !== img.id || force) {
      let p = 1;
      for (let y = 0; y < state.real.height; y += GRAIN_SIZE) {
        for (let x = 0; x < state.real.width; x += GRAIN_SIZE) out += placeCropped(img.id, p++, x, y, Z.fx, { w: GRAIN_SIZE, h: GRAIN_SIZE });
      }
    }
    grain.placedId = img.id; grain.frame = frame;
    return out;
  }

  function overlayPanels(parsed, frostRows) {
    const panels = []; let current = null;
    const frost = Math.max(0, Math.min(1, Number(cfg().frost) || 0));
    parsed.forEach(({ overlay }, r) => {
      if (!overlay) { current = null; return; }
      // Frosted glass: the covered transcript row, parsed for a blurred
      // underlay (content-keyed so unchanged rows stay cached).
      if (frost > 0 && overlay.base && overlayBases.has(overlay.base)) {
        frostRows.set(r, { key: overlay.base, cells: parsedRow(overlayBases.get(overlay.base)).cells });
      }
      if (current && current.col0 === overlay.col && current.col1 === overlay.col + overlay.width && current.row1 === r - 1) { current.row1 = r; return; }
      const t = state.theme;
      current = { row0: r, row1: r, col0: overlay.col, col1: overlay.col + overlay.width, style: `overlay:${frost}`, flush: true, fill: mixRgb(t.bg, t.surface, 0.6), alpha: 0.97, border: t.accent, border2: t.accent2, borderAlpha: 0.5, sheen: 0.04, shadow: Number(cfg().panelShadow) || 0, frost };
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
    const frostRows = new Map();
    regions.panels.push(...overlayPanels(parsed, frostRows));
    if (process.env.PI_GRAPHICS_TRACE_FROST) trace(`canvas frost rows=${frostRows.size} overlayRows=${parsed.filter((p) => p.overlay).length} withBase=${parsed.filter((p) => p.overlay?.base).length} bases=${overlayBases.size}`);
    state.frame = { parsed, cursor, imageSlices, lighting: lightingContext(), frostRows, ...regions };
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
    out += glowCommands(now, { force: frame.cleared }) + backgroundAdvance(now) + surfaceCommands({ force: frame.cleared }) + screenFxCommands({ force: frame.cleared }) + grainCommands(now, { force: frame.cleared }) + beaconCommands(now, { force: frame.cleared }) + (trackPaneStatus(now), paneFlashCommands(now, { force: frame.cleared })) + stickyCommands({ force: frame.cleared }) + shimmerCommands(now, { force: frame.cleared }) + caretCommands(now) + caretLightCommands() + impulseCommands(now) + overlayCommands(now);
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
    if (tmuxMode() && (data === "\x1b[I" || data === "\x1b[O")) pollTmux(); // focus change: re-check visibility now
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
    state.caretLight = { key: "", id: null };
    state.beacon = { store: freshStore(), slots: new Map() };
    state.paneFx = freshPaneFx();
    state.grain = { store: freshStore(), key: "", frame: -1, placedId: null };
    state.fx = { vignetteKey: "", vignetteId: null, scanKey: "", scanId: null, scanPlacements: 0 };
    state.typed = [];
    for (const block of state.stream.blocks.values()) { block.hold = null; block.runs = []; }
    return out;
  }

  async function start(options = {}) {
    const tui = getTui();
    if (!tui) throw new Error("Pi TUI is not available yet");
    if (tui.mode !== "fullscreen") throw new Error("full canvas needs Pi's fullscreen TUI mode (/settings → TUI mode, or --tui-mode fullscreen)");
    // GNU screen has no Kitty graphics passthrough to position through.
    if (/^screen/.test(process.env.TERM || "") && !process.env.TMUX && process.env.PI_GRAPHICS_FULL_TMUX !== "1") {
      throw new Error("full canvas does not support GNU screen (tmux, herdr and plain terminals work)");
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
    // Multiplexers translate cell mouse reports but not SGR-Pixels ones.
    const pixelCapable = /kitty|ghostty|wezterm/.test(terminalName || envName) && !inMultiplexer();
    state.pixelCapable = pixelCapable;
    state.pixelMouse = cfg().pixelMouse === "on" || (cfg().pixelMouse === "auto" && pixelCapable);
    state.untapInput = tapInput?.(remapInput) || null;
    state.stream.armedAt = Date.now() + 600;
    // Mouse pixels, in-band resize reports (font-size changes), hide cursor,
    // clear, and blend the terminal padding into the canvas edge colour.
    write(`${state.pixelMouse ? "\x1b[?1016h" : ""}\x1b[?2048h\x1b[?25l\x1b[2J${edgeBlendCommand()}`);
    state.slots.clear();
    process.stdout.on?.("resize", onStdoutResize);
    if (tmuxMode()) {
      await ensureTmuxPassthrough();
      state.tmux = { known: false, visible: true, left: 0, top: 0, width: 0, height: 0, timer: null, reassertAt: 0 };
      pollTmux();
      state.tmux.timer = setInterval(pollTmux, Math.max(100, Number(cfg().tmuxPollMs) || 300));
      state.tmux.timer.unref?.();
    }
    trace(`full canvas start terminal=${JSON.stringify(state.terminalName)} grid=${gridAligned() ? "aligned" : "free"} real=${JSON.stringify(state.real)} virt=${JSON.stringify(state.virt)} cell=${state.fonts.cellWidth}x${state.fonts.cellHeight} fonts=${JSON.stringify(state.fonts.resolved)} S=${S()}`);
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
    if (state.tmux.timer) { clearInterval(state.tmux.timer); state.tmux.timer = null; }
    if (state.tmuxRestore) { void tmuxPaneOption(state.tmuxRestore); state.tmuxRestore = null; }
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
      grid: gridAligned() ? "aligned" : "free",
      tmux: tmuxMode() ? { ...state.tmux, timer: undefined } : null,
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
