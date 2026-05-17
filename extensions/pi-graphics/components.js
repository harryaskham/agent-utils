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

function renderTuiComponentPixels({
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

export function componentFrameCacheKey({ columns = 56, rows = 9, tone = "assistant", density = 0.72, scanlines = true } = {}) {
  // Intentionally excludes phase: animation frames reuse the same component
  // layout/cache bucket and only swap tiny image bytes for the active phase.
  return JSON.stringify({ kind: "pi-graphics.tui-component", columns, rows, tone: PALETTES[tone] ? tone : "assistant", density: Number(density), scanlines: Boolean(scanlines) });
}
