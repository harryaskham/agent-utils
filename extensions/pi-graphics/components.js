// TypeScript-friendly graphical TUI component renderer for Pi kitty graphics.
//
// This module mirrors the shape of a terminal UI component in plain ESM so the
// visual contract can be tested without loading Pi or a real kitty terminal. It
// intentionally renders the component chrome (background, rails, title strip,
// status chips, skeleton rows, waveform) into a tiny RGBA PNG. Text remains the
// responsibility of the surrounding TUI, but the frame is graphical enough to
// make kitty mode visibly different from a palette-only theme.

import {
  addRadialGlow,
  addScanlines,
  encodeRgbaApng,
  encodeRgbaPng,
  fillHorizontalGradient,
  fillRect,
  fillVerticalGradient,
  makeCanvas,
  strokeRect,
} from "./png-renderer.js";
import { CELL_PX_H, CELL_PX_W } from "./affordances.js";

const PALETTES = Object.freeze({
  assistant: {
    top: "#07111fff",
    bottom: "#11192cff",
    rail: "#00d8ff",
    rail2: "#72fbd6",
    glow: "#00d8ff88",
    glow2: "#b48cff77",
    textBar: "#d7f8ff88",
    mutedBar: "#4f7dff55",
    chip: "#72fbd6cc",
  },
  tool: {
    top: "#080d1bff",
    bottom: "#171326ff",
    rail: "#b48cff",
    rail2: "#00d8ff",
    glow: "#b48cff88",
    glow2: "#00d8ff66",
    textBar: "#f0ddff88",
    mutedBar: "#7aa2ff55",
    chip: "#b48cffcc",
  },
  user: {
    top: "#061817ff",
    bottom: "#0e202cff",
    rail: "#72fbd6",
    rail2: "#00d8ff",
    glow: "#72fbd688",
    glow2: "#00d8ff66",
    textBar: "#d7fff488",
    mutedBar: "#00d8ff55",
    chip: "#00d8ffcc",
  },
});

function clampPositive(value, fallback, name) {
  const n = Math.trunc(Number(value ?? fallback));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`pi-graphics component ${name} must be positive, got ${value}`);
  return n;
}

function phase01(value) {
  return ((Number(value) || 0) % 1 + 1) % 1;
}

function pulse(phase) {
  return (Math.sin(phase * Math.PI * 2) + 1) / 2;
}

function withAlpha(hex, alpha) {
  const stripped = String(hex).replace(/^#/, "").slice(0, 6);
  const a = Math.max(0, Math.min(255, Math.round(alpha))).toString(16).padStart(2, "0");
  return `#${stripped}${a}`;
}

function barWidth(widthPx, index, density) {
  const wave = 0.5 + Math.sin(index * 1.7) * 0.18 + Math.cos(index * 0.61) * 0.12;
  return Math.max(10, Math.floor(widthPx * (0.34 + density * 0.42) * wave));
}

export function renderTuiComponentPixels({
  columns = 56,
  rows = 9,
  phase = 0,
  tone = "assistant",
  density = 0.72,
  scanlines = true,
} = {}) {
  const cols = clampPositive(columns, 8, "columns");
  const rs = clampPositive(rows, 4, "rows");
  const widthPx = cols * CELL_PX_W;
  const heightPx = rs * CELL_PX_H;
  const ph = phase01(phase);
  const p = pulse(ph);
  const d = Math.max(0.1, Math.min(1, Number(density) || 0.72));
  const palette = PALETTES[tone] ?? PALETTES.assistant;
  const pixels = makeCanvas(widthPx, heightPx, [0, 0, 0, 0]);

  fillVerticalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, palette.top, palette.bottom);
  addRadialGlow(pixels, widthPx, widthPx * (0.1 + p * 0.08), heightPx * 0.12, Math.max(widthPx, heightPx) * 0.42, palette.glow, 0.95);
  addRadialGlow(pixels, widthPx, widthPx * (0.88 - p * 0.07), heightPx * 0.88, Math.max(widthPx, heightPx) * 0.44, palette.glow2, 0.9);

  // Outer/inset frame: stable layout, phase-varying brightness only.
  strokeRect(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(palette.rail, 92 + p * 92), 1);
  strokeRect(pixels, widthPx, 2, 2, widthPx - 4, heightPx - 4, withAlpha("#d7f8ff", 62 + p * 72), 1);

  // Left activity rail and title strip.
  fillVerticalGradient(pixels, widthPx, 2, 4, 4, heightPx - 8, withAlpha(palette.rail, 225), withAlpha(palette.rail2, 170));
  fillHorizontalGradient(pixels, widthPx, 8, 4, widthPx - 16, Math.max(6, Math.floor(CELL_PX_H * 0.72)), withAlpha(palette.rail, 96 + p * 80), withAlpha(palette.glow2, 84 + p * 60));

  // Status chips at top right.
  const chipW = Math.max(12, Math.floor(widthPx * 0.08));
  for (let i = 0; i < 3; i += 1) {
    const x = widthPx - 10 - (i + 1) * (chipW + 5);
    fillRect(pixels, widthPx, x, 6, chipW, 4, withAlpha(i === 0 ? palette.chip : palette.rail, 110 + p * 80));
  }

  // Content skeleton bars: this approximates the TUI component's text/content
  // geometry while remaining font-independent and deterministic.
  const contentX = 13;
  const contentW = widthPx - contentX - 12;
  const firstY = CELL_PX_H + 8;
  const step = Math.max(7, Math.floor(CELL_PX_H * 0.62));
  const maxRows = Math.max(2, Math.floor((heightPx - firstY - CELL_PX_H) / step));
  for (let i = 0; i < maxRows; i += 1) {
    const y = firstY + i * step;
    const w = Math.min(contentW, barWidth(contentW, i, d));
    const alpha = i % 3 === 0 ? 96 + p * 52 : 58 + p * 36;
    fillRect(pixels, widthPx, contentX, y, w, 3, i % 3 === 0 ? withAlpha(palette.textBar, alpha) : withAlpha(palette.mutedBar, alpha));
  }

  // Bottom pulse waveform: cheap visual activity cue, deterministic by phase.
  const baseY = heightPx - 10;
  for (let x = contentX; x < widthPx - 12; x += 5) {
    const t = x / Math.max(1, widthPx - 1);
    const h = 2 + Math.round((Math.sin((t + ph) * Math.PI * 4) * 0.5 + 0.5) * 7);
    fillRect(pixels, widthPx, x, baseY - h, 2, h, withAlpha(palette.rail2, 86 + p * 90));
  }

  if (scanlines) addScanlines(pixels, widthPx, { every: 5, alpha: 10 + p * 10, color: "#d7f8ff" });

  return { pixels, columns: cols, rows: rs, widthPx, heightPx, phase: ph, tone: PALETTES[tone] ? tone : "assistant" };
}

function metricsForPayload(payload, widthPx, heightPx, extra = {}) {
  return {
    ...extra,
    pngBytes: payload.length,
    pixels: widthPx * heightPx,
    estimatedWireBytes: Math.ceil(payload.length / 3) * 4,
  };
}

export function renderTuiComponentFrame(options = {}) {
  const frame = renderTuiComponentPixels(options);
  const png = encodeRgbaPng(frame.pixels, frame.widthPx, frame.heightPx);
  return {
    png,
    columns: frame.columns,
    rows: frame.rows,
    widthPx: frame.widthPx,
    heightPx: frame.heightPx,
    phase: frame.phase,
    tone: frame.tone,
    metrics: metricsForPayload(png, frame.widthPx, frame.heightPx),
  };
}

export function renderTuiComponentFrames({ frames = 8, ...options } = {}) {
  const count = Math.max(1, Math.min(32, Math.trunc(Number(frames) || 8)));
  return Array.from({ length: count }, (_unused, index) => renderTuiComponentFrame({ ...options, phase: index / count }));
}

export function renderTuiComponentPulseApng({ frames = 8, delayMs = 100, plays = 0, ...options } = {}) {
  const count = Math.max(2, Math.min(32, Math.trunc(Number(frames) || 8)));
  const rendered = Array.from({ length: count }, (_unused, index) => renderTuiComponentPixels({ ...options, phase: index / count }));
  const first = rendered[0];
  const png = encodeRgbaApng(rendered.map((frame) => frame.pixels), first.widthPx, first.heightPx, { delayMs, plays });
  return {
    png,
    columns: first.columns,
    rows: first.rows,
    widthPx: first.widthPx,
    heightPx: first.heightPx,
    frames: count,
    delayMs: Math.max(1, Math.trunc(delayMs || 100)),
    plays: Math.max(0, Math.trunc(plays || 0)),
    tone: first.tone,
    metrics: metricsForPayload(png, first.widthPx, first.heightPx, {
      frames: count,
      delayMs: Math.max(1, Math.trunc(delayMs || 100)),
      animationMillis: count * Math.max(1, Math.trunc(delayMs || 100)),
    }),
  };
}

export function renderNativeChromeFrame({ columns = 72, rows = 4, phase = 0, surface = "message" } = {}) {
  const cols = clampPositive(columns, 24, "columns");
  const rs = clampPositive(rows, 2, "rows");
  const widthPx = cols * CELL_PX_W;
  const heightPx = rs * CELL_PX_H;
  const ph = phase01(phase);
  const p = pulse(ph);
  const tone = surface === "user" ? PALETTES.user : surface === "tool" ? PALETTES.tool : PALETTES.assistant;
  const pixels = makeCanvas(widthPx, heightPx, [0, 0, 0, 0]);

  fillVerticalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(tone.top, 118), withAlpha(tone.bottom, 142));
  addRadialGlow(pixels, widthPx, widthPx * (0.18 + p * 0.12), heightPx * 0.2, Math.max(widthPx, heightPx) * 0.36, withAlpha(tone.glow, 110), 0.85);
  addRadialGlow(pixels, widthPx, widthPx * (0.82 - p * 0.10), heightPx * 0.86, Math.max(widthPx, heightPx) * 0.36, withAlpha(tone.glow2, 100), 0.85);
  strokeRect(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(tone.rail, 190), 1);
  strokeRect(pixels, widthPx, 2, 2, widthPx - 4, heightPx - 4, withAlpha(tone.rail2, 96 + p * 80), 1);
  fillHorizontalGradient(pixels, widthPx, 4, 3, widthPx - 8, 2, withAlpha(tone.rail, 175), withAlpha(tone.rail2, 132));
  fillHorizontalGradient(pixels, widthPx, 4, heightPx - 5, widthPx - 8, 2, withAlpha(tone.rail2, 118), withAlpha(tone.rail, 150));
  if (heightPx > 32) {
    for (let y = 12; y < heightPx - 12; y += 9) {
      const alpha = 26 + p * 22;
      fillRect(pixels, widthPx, 8, y, widthPx - 16, 1, withAlpha("#d7f8ff", alpha));
    }
  }
  addScanlines(pixels, widthPx, { every: 6, alpha: 6 + p * 6, color: "#d7f8ff" });
  const png = encodeRgbaPng(pixels, widthPx, heightPx);
  return {
    png,
    columns: cols,
    rows: rs,
    widthPx,
    heightPx,
    phase: ph,
    surface,
    metrics: metricsForPayload(png, widthPx, heightPx),
  };
}

function drawTuiSurfaceCard(pixels, widthPx, heightPx, { x, y, w, h, tone = "assistant", phase = 0, label = 0 } = {}) {
  const palette = PALETTES[tone] ?? PALETTES.assistant;
  const p = pulse(phase + label * 0.08);
  const innerW = Math.max(12, w - 10);
  fillVerticalGradient(pixels, widthPx, x, y, w, h, withAlpha(palette.top, 210), withAlpha(palette.bottom, 232));
  addRadialGlow(pixels, widthPx, x + w * (0.18 + p * 0.10), y + h * 0.22, Math.max(w, h) * 0.42, withAlpha(palette.glow, 105), 0.72);
  addRadialGlow(pixels, widthPx, x + w * (0.84 - p * 0.08), y + h * 0.78, Math.max(w, h) * 0.38, withAlpha(palette.glow2, 98), 0.68);
  strokeRect(pixels, widthPx, x, y, w, h, withAlpha(palette.rail, 150 + p * 70), 1);
  strokeRect(pixels, widthPx, x + 2, y + 2, w - 4, h - 4, withAlpha(palette.rail2, 74 + p * 86), 1);
  fillVerticalGradient(pixels, widthPx, x + 3, y + 4, 3, h - 8, withAlpha(palette.rail, 230), withAlpha(palette.rail2, 165));
  fillHorizontalGradient(pixels, widthPx, x + 9, y + 5, innerW - 8, 4, withAlpha(palette.rail, 118 + p * 78), withAlpha(palette.glow2, 82 + p * 60));
  for (let i = 0; i < 3; i += 1) {
    const chipW = Math.max(10, Math.floor(w * (0.07 + i * 0.006)));
    fillRect(pixels, widthPx, x + w - 12 - (i + 1) * (chipW + 5), y + 6, chipW, 4, withAlpha(i === 0 ? palette.chip : palette.rail2, 112 + p * 78));
  }
  const textX = x + 13;
  const maxBars = Math.max(2, Math.floor((h - 22) / 8));
  for (let row = 0; row < maxBars; row += 1) {
    const yy = y + 18 + row * 8;
    const wave = 0.54 + Math.sin(row * 1.4 + label + phase * Math.PI * 2) * 0.16 + Math.cos(row * 0.7 + label) * 0.1;
    const bw = Math.max(18, Math.min(innerW - 18, Math.floor(innerW * wave)));
    fillRect(pixels, widthPx, textX, yy, bw, 3, row % 2 === 0 ? withAlpha(palette.textBar, 88 + p * 52) : withAlpha(palette.mutedBar, 60 + p * 38));
  }
  for (let xx = textX; xx < x + w - 13; xx += 7) {
    const t = (xx - textX) / Math.max(1, w - 26);
    const hh = 1 + Math.round((Math.sin((t * 3.5 + phase + label * 0.1) * Math.PI * 2) * 0.5 + 0.5) * Math.max(2, h * 0.10));
    fillRect(pixels, widthPx, xx, y + h - 7 - hh, 2, hh, withAlpha(palette.rail2, 70 + p * 96));
  }
}

export function renderTuiSurfaceScenePixels({ columns = 76, rows = 16, phase = 0, density = 0.78 } = {}) {
  const cols = clampPositive(columns, 32, "columns");
  const rs = clampPositive(rows, 10, "rows");
  const widthPx = cols * CELL_PX_W;
  const heightPx = rs * CELL_PX_H;
  const ph = phase01(phase);
  const p = pulse(ph);
  const pixels = makeCanvas(widthPx, heightPx, "#030711ff");

  fillVerticalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, "#020611ff", "#111a30ff");
  addRadialGlow(pixels, widthPx, widthPx * (0.16 + p * 0.18), heightPx * 0.12, widthPx * 0.44, "#00d8ffaa", 0.95);
  addRadialGlow(pixels, widthPx, widthPx * (0.84 - p * 0.16), heightPx * 0.58, widthPx * 0.42, "#b48cffaa", 0.9);
  addRadialGlow(pixels, widthPx, widthPx * 0.52, heightPx * 0.96, widthPx * 0.36, "#72fbd688", 0.65);

  // Outer terminal shell: this is a TypeScript mirror of a real Pi TUI layout,
  // not just a theme token swatch. It includes header, transcript cards,
  // tool/status lanes, and the editor/input box as rendered pixels.
  strokeRect(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha("#8fbcbb", 132 + p * 82), 2);
  strokeRect(pixels, widthPx, 6, 6, widthPx - 12, heightPx - 12, withAlpha("#88c0d0", 76 + p * 84), 1);
  fillHorizontalGradient(pixels, widthPx, 10, 9, widthPx - 20, 8, "#00d8ffaa", "#b48cffaa");
  fillHorizontalGradient(pixels, widthPx, 10, heightPx - 12, widthPx - 20, 5, "#72fbd688", "#00d8ffaa");

  const margin = Math.max(12, Math.floor(widthPx * 0.025));
  const gutter = Math.max(7, Math.floor(widthPx * 0.012));
  const top = CELL_PX_H + 10;
  const footerH = CELL_PX_H + 10;
  const inputH = Math.max(CELL_PX_H * 2, Math.floor(heightPx * 0.18));
  const contentBottom = heightPx - footerH - inputH - 10;
  const cardH = Math.max(CELL_PX_H * 2, Math.floor((contentBottom - top - gutter * 2) / 3));
  const fullW = widthPx - margin * 2;
  const userW = Math.floor(fullW * 0.72);
  const assistantW = Math.floor(fullW * 0.84);
  drawTuiSurfaceCard(pixels, widthPx, heightPx, { x: margin + fullW - userW, y: top, w: userW, h: cardH, tone: "user", phase: ph, label: 1 });
  drawTuiSurfaceCard(pixels, widthPx, heightPx, { x: margin, y: top + cardH + gutter, w: assistantW, h: cardH, tone: "assistant", phase: ph, label: 2 });
  drawTuiSurfaceCard(pixels, widthPx, heightPx, { x: margin, y: top + (cardH + gutter) * 2, w: Math.floor(fullW * 0.78), h: cardH, tone: "tool", phase: ph, label: 3 });

  const inputY = heightPx - footerH - inputH - 4;
  drawTuiSurfaceCard(pixels, widthPx, heightPx, { x: margin, y: inputY, w: fullW, h: inputH, tone: "assistant", phase: ph, label: 4 });
  fillRect(pixels, widthPx, margin + 18, inputY + Math.floor(inputH / 2), Math.floor(fullW * Math.max(0.35, Math.min(0.88, density))), 3, withAlpha("#eceff4", 98 + p * 50));
  fillRect(pixels, widthPx, margin + fullW - 22, inputY + 10, 3, inputH - 20, withAlpha("#72fbd6", 180 + p * 60));

  // Status beacons and a cheap waveform make animation obvious even when the
  // APNG is only uploaded once and then played by kitty.
  for (let i = 0; i < 7; i += 1) {
    const x = margin + i * Math.max(26, Math.floor(fullW / 8));
    const alpha = 70 + ((i % 3) * 24) + p * 72;
    fillRect(pixels, widthPx, x, heightPx - footerH + 8, Math.max(16, Math.floor(fullW / 13)), 5, withAlpha(i % 2 ? "#b48cff" : "#72fbd6", alpha));
  }
  for (let x = margin; x < margin + fullW; x += 5) {
    const t = (x - margin) / Math.max(1, fullW);
    const h = 2 + Math.round((Math.sin((t * 5 + ph) * Math.PI * 2) * 0.5 + 0.5) * 11);
    fillRect(pixels, widthPx, x, heightPx - 13 - h, 2, h, withAlpha("#00d8ff", 78 + p * 100));
  }

  addScanlines(pixels, widthPx, { every: 4, alpha: 12 + p * 8, color: "#d8dee9" });
  return { pixels, columns: cols, rows: rs, widthPx, heightPx, phase: ph };
}

export function renderTuiSurfaceSceneFrame(options = {}) {
  const scene = renderTuiSurfaceScenePixels(options);
  const png = encodeRgbaPng(scene.pixels, scene.widthPx, scene.heightPx);
  return {
    png,
    columns: scene.columns,
    rows: scene.rows,
    widthPx: scene.widthPx,
    heightPx: scene.heightPx,
    phase: scene.phase,
    metrics: metricsForPayload(png, scene.widthPx, scene.heightPx),
  };
}

export function renderTuiSurfaceScenePulseApng({ frames = 10, delayMs = 70, plays = 0, ...options } = {}) {
  const count = Math.max(2, Math.min(32, Math.trunc(Number(frames) || 10)));
  const rendered = Array.from({ length: count }, (_unused, index) => renderTuiSurfaceScenePixels({ ...options, phase: index / count }));
  const first = rendered[0];
  const png = encodeRgbaApng(rendered.map((frame) => frame.pixels), first.widthPx, first.heightPx, { delayMs, plays });
  return {
    png,
    columns: first.columns,
    rows: first.rows,
    widthPx: first.widthPx,
    heightPx: first.heightPx,
    frames: count,
    delayMs: Math.max(1, Math.trunc(delayMs || 70)),
    plays: Math.max(0, Math.trunc(plays || 0)),
    metrics: metricsForPayload(png, first.widthPx, first.heightPx, {
      frames: count,
      delayMs: Math.max(1, Math.trunc(delayMs || 70)),
      animationMillis: count * Math.max(1, Math.trunc(delayMs || 70)),
    }),
  };
}


export function renderTerminalScenePixels({ columns = 72, rows = 14, phase = 0 } = {}) {
  const cols = clampPositive(columns, 16, "columns");
  const rs = clampPositive(rows, 8, "rows");
  const widthPx = cols * CELL_PX_W;
  const heightPx = rs * CELL_PX_H;
  const ph = phase01(phase);
  const p = pulse(ph);
  const pixels = makeCanvas(widthPx, heightPx, "#020611ff");

  fillVerticalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, "#020611ff", "#10182dff");
  addRadialGlow(pixels, widthPx, widthPx * (0.18 + p * 0.22), heightPx * 0.18, widthPx * 0.45, "#00d8ffaa", 0.95);
  addRadialGlow(pixels, widthPx, widthPx * (0.82 - p * 0.18), heightPx * 0.72, widthPx * 0.42, "#b48cff99", 0.9);
  strokeRect(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha("#72fbd6", 140 + p * 80), 2);
  strokeRect(pixels, widthPx, 6, 6, widthPx - 12, heightPx - 12, withAlpha("#00d8ff", 70 + p * 70), 1);

  // Terminal cell grid and glyph-like micro blocks: a TypeScript mirror of a
  // rendered terminal surface, not merely themed text.
  const gridLeft = CELL_PX_W * 2;
  const gridTop = CELL_PX_H * 2;
  const gridCols = Math.max(8, cols - 4);
  const gridRows = Math.max(4, rs - 5);
  for (let y = 0; y < gridRows; y += 1) {
    for (let x = 0; x < gridCols; x += 1) {
      const px = gridLeft + x * CELL_PX_W;
      const py = gridTop + y * CELL_PX_H;
      const wave = Math.sin((x * 0.35) + (y * 0.71) + ph * Math.PI * 2);
      if ((x + y + Math.floor(ph * 9)) % 5 === 0) {
        fillRect(pixels, widthPx, px + 2, py + 3, Math.max(2, CELL_PX_W - 4), 2, withAlpha(wave > 0 ? "#72fbd6" : "#b48cff", 70 + Math.abs(wave) * 120));
      }
      if ((x * 3 + y + Math.floor(ph * 13)) % 11 === 0) {
        fillRect(pixels, widthPx, px + 3, py + 7, 2, Math.max(2, CELL_PX_H - 9), withAlpha("#00d8ff", 90 + p * 90));
      }
    }
  }

  fillHorizontalGradient(pixels, widthPx, 16, 10, widthPx - 32, 8, "#00d8ff99", "#b48cffaa");
  for (let i = 0; i < 5; i += 1) {
    const chipW = Math.max(18, Math.floor(widthPx * 0.09));
    const x = widthPx - 22 - (i + 1) * (chipW + 7);
    fillRect(pixels, widthPx, x, 18, chipW, 6, withAlpha(i % 2 === 0 ? "#72fbd6" : "#b48cff", 120 + p * 80));
  }
  for (let x = 18; x < widthPx - 18; x += 7) {
    const t = x / Math.max(1, widthPx - 1);
    const h = 3 + Math.round((Math.sin((t * 5 + ph) * Math.PI * 2) * 0.5 + 0.5) * 12);
    fillRect(pixels, widthPx, x, heightPx - 18 - h, 3, h, withAlpha("#72fbd6", 90 + p * 100));
  }
  addScanlines(pixels, widthPx, { every: 4, alpha: 12 + p * 10, color: "#d7f8ff" });
  return { pixels, columns: cols, rows: rs, widthPx, heightPx, phase: ph };
}

export function renderTerminalSceneFrame(options = {}) {
  const scene = renderTerminalScenePixels(options);
  const png = encodeRgbaPng(scene.pixels, scene.widthPx, scene.heightPx);
  return {
    png,
    columns: scene.columns,
    rows: scene.rows,
    widthPx: scene.widthPx,
    heightPx: scene.heightPx,
    phase: scene.phase,
    metrics: metricsForPayload(png, scene.widthPx, scene.heightPx),
  };
}

export function renderTerminalScenePulseApng({ frames = 8, delayMs = 90, plays = 0, ...options } = {}) {
  const count = Math.max(2, Math.min(32, Math.trunc(Number(frames) || 8)));
  const rendered = Array.from({ length: count }, (_unused, index) => renderTerminalScenePixels({ ...options, phase: index / count }));
  const first = rendered[0];
  const png = encodeRgbaApng(rendered.map((frame) => frame.pixels), first.widthPx, first.heightPx, { delayMs, plays });
  return {
    png,
    columns: first.columns,
    rows: first.rows,
    widthPx: first.widthPx,
    heightPx: first.heightPx,
    frames: count,
    delayMs: Math.max(1, Math.trunc(delayMs || 90)),
    plays: Math.max(0, Math.trunc(plays || 0)),
    metrics: metricsForPayload(png, first.widthPx, first.heightPx, {
      frames: count,
      delayMs: Math.max(1, Math.trunc(delayMs || 90)),
      animationMillis: count * Math.max(1, Math.trunc(delayMs || 90)),
    }),
  };
}

function blit(src, dst, dstWidth, x, y) {
  for (let row = 0; row < src.heightPx; row += 1) {
    const srcStart = row * src.widthPx * 4;
    const dstStart = ((y + row) * dstWidth + x) * 4;
    src.pixels.copy(dst, dstStart, srcStart, srcStart + src.widthPx * 4);
  }
}

export function renderPiGraphicsContactSheet({ columns = 36, rows = 6, gapPx = 12 } = {}) {
  const phases = [0, 0.25, 0.5, 0.75];
  const tones = ["assistant", "tool", "user"];
  const tiles = [];
  for (const tone of tones) {
    for (const phase of phases) {
      tiles.push(renderTuiComponentPixels({ columns, rows, tone, phase }));
    }
  }
  const tileWidth = tiles[0].widthPx;
  const tileHeight = tiles[0].heightPx;
  const sheetCols = phases.length;
  const sheetRows = tones.length;
  const gap = Math.max(0, Math.trunc(gapPx));
  const widthPx = sheetCols * tileWidth + (sheetCols + 1) * gap;
  const heightPx = sheetRows * tileHeight + (sheetRows + 1) * gap;
  const pixels = makeCanvas(widthPx, heightPx, "#050914ff");
  fillVerticalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, "#050914ff", "#101729ff");
  tiles.forEach((tile, index) => {
    const col = index % sheetCols;
    const row = Math.floor(index / sheetCols);
    blit(tile, pixels, widthPx, gap + col * (tileWidth + gap), gap + row * (tileHeight + gap));
  });
  const png = encodeRgbaPng(pixels, widthPx, heightPx);
  return {
    png,
    columns: sheetCols * columns,
    rows: sheetRows * rows,
    widthPx,
    heightPx,
    tileCount: tiles.length,
    tones,
    phases,
    metrics: metricsForPayload(png, widthPx, heightPx, { tileCount: tiles.length }),
  };
}

export function componentFrameCacheKey({ columns = 56, rows = 9, tone = "assistant", density = 0.72, scanlines = true } = {}) {
  // Intentionally excludes phase: animation frames reuse the same component
  // layout/cache bucket and only swap tiny image bytes for the active phase.
  return JSON.stringify({ kind: "pi-graphics.tui-component", columns, rows, tone: PALETTES[tone] ? tone : "assistant", density: Number(density), scanlines: Boolean(scanlines) });
}
