// High-level affordance renderer for the agent-utils Pi graphics theme.
//
// Each helper returns a small RGBA PNG buffer plus the cell footprint
// (`columns`, `rows`) that the kitty graphics protocol should reserve for the
// rendered image. The caller is responsible for assigning a stable image id
// (see `extensions/kitty-graphics.js#stableKittyImageId`) and for placing the
// rendered bytes via `buildPngVirtualPlacementCommand` followed by
// `buildKittyUnicodePlaceholderLines`.
//
// We use a fixed nominal cell size (`CELL_PX_W` x `CELL_PX_H`) so the
// generated bitmaps scale cleanly across terminals. Kitty resamples the
// picture into the reserved cell area, so the absolute pixel size only matters
// for fidelity, not for layout.

import {
  addRadialGlow,
  addScanlines,
  encodeRgbaApng,
  encodeRgbaPng,
  fillHorizontalGradient,
  fillRect,
  fillVerticalGradient,
  makeCanvas,
  parseColor,
  strokeRect,
} from "./png-renderer.js";

export const CELL_PX_W = 8;
export const CELL_PX_H = 16;

const DEFAULT_GRADIENT_LEFT = "#00d8ff";
const DEFAULT_GRADIENT_RIGHT = "#b48cff";
const DEFAULT_GRADIENT_FADE_ALPHA = 0xb8;
const DEFAULT_BORDER_COLOR = "#00d8ff";
const DEFAULT_BORDER_FILL = [5, 10, 24, 86];
const NORDIC_DEEP_TOP = "#07111fff";
const NORDIC_DEEP_BOTTOM = "#101729f6";
const NORDIC_CYAN = "#88c0d0";
const NORDIC_AURORA = "#8fbcbb";
const NORDIC_VIOLET = "#b48ead";
const NORDIC_BLUE = "#5e81ac";
const NORDIC_EDGE = "#eceff4";

function clampPositive(value, fallback, name) {
  const n = Math.trunc(Number(value ?? fallback));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`pi-graphics affordance ${name} must be a positive integer, got ${value}`);
  }
  return n;
}

export function resolveCellMetrics({ cellWidthPx, cellHeightPx, lineHeightScale } = {}) {
  const width = clampPositive(cellWidthPx, CELL_PX_W, "cellWidthPx");
  const scale = Number(lineHeightScale ?? 1);
  const safeScale = Number.isFinite(scale) && scale > 0 ? Math.max(0.5, Math.min(3, scale)) : 1;
  const heightFallback = Math.max(1, Math.round(CELL_PX_H * safeScale));
  const height = clampPositive(cellHeightPx, heightFallback, "cellHeightPx");
  return { cellWidthPx: width, cellHeightPx: height, lineHeightScale: safeScale };
}

function withAlpha(color, alpha) {
  const [r, g, b] = parseColor(color);
  return [r, g, b, Math.max(0, Math.min(255, Math.trunc(alpha)))];
}

function pulseFactor(phase = 0) {
  const p = Number(phase) || 0;
  return (Math.sin(p * Math.PI * 2) + 1) / 2;
}

function drawGlowFrame(pixels, widthPx, heightPx, { phase = 0, borderThickness = 2 } = {}) {
  const pulse = pulseFactor(phase);
  const glowAlpha = 42 + Math.round(pulse * 70);
  const thickness = Math.max(1, Math.trunc(borderThickness));

  addRadialGlow(pixels, widthPx, widthPx * (0.12 + pulse * 0.08), heightPx * 0.05, Math.max(widthPx, heightPx) * 0.48, withAlpha(NORDIC_CYAN, glowAlpha), 0.95);
  addRadialGlow(pixels, widthPx, widthPx * (0.9 - pulse * 0.06), heightPx * 0.92, Math.max(widthPx, heightPx) * 0.46, withAlpha(NORDIC_VIOLET, glowAlpha), 0.9);
  addRadialGlow(pixels, widthPx, widthPx * 0.58, heightPx * 0.45, Math.max(widthPx, heightPx) * 0.34, withAlpha(NORDIC_AURORA, 22 + pulse * 34), 0.62);

  for (let i = 0; i < thickness + 4; i += 1) {
    const alpha = Math.max(18, glowAlpha - i * 16);
    strokeRect(pixels, widthPx, i, i, widthPx - i * 2, heightPx - i * 2, withAlpha(i % 2 ? NORDIC_BLUE : NORDIC_CYAN, alpha), 1);
  }
  strokeRect(pixels, widthPx, thickness + 2, thickness + 2, widthPx - (thickness + 2) * 2, heightPx - (thickness + 2) * 2, withAlpha(NORDIC_EDGE, 92 + pulse * 86), 1);
}

export const SURFACE_VARIANTS = Object.freeze(["rule", "gradient", "scanlines", "grid", "dots", "glow"]);

function normalizeAlpha(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function paintSurfaceVariant(pixels, widthPx, heightPx, {
  variant,
  leftColor,
  rightColor,
  alpha,
  phase,
} = {}) {
  const pulse = pulseFactor(phase);
  const baseAlpha = Math.round(normalizeAlpha(alpha, 0.65) * 255);
  if (variant === "gradient") {
    fillHorizontalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(leftColor, baseAlpha), withAlpha(rightColor, baseAlpha));
  } else if (variant === "scanlines") {
    fillHorizontalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(leftColor, Math.round(baseAlpha * 0.55)), withAlpha(rightColor, Math.round(baseAlpha * 0.55)));
    addScanlines(pixels, widthPx, { every: 2, alpha: Math.max(24, Math.round(baseAlpha * 0.55)), color: NORDIC_EDGE });
  } else if (variant === "grid") {
    fillHorizontalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(leftColor, Math.round(baseAlpha * 0.45)), withAlpha(rightColor, Math.round(baseAlpha * 0.45)));
    const step = Math.max(3, Math.round(heightPx / 4));
    for (let y = step - 1; y < heightPx; y += step) {
      fillRect(pixels, widthPx, 0, y, widthPx, 1, withAlpha(NORDIC_EDGE, Math.round(baseAlpha * 0.5)));
    }
    for (let x = step - 1; x < widthPx; x += step) {
      fillRect(pixels, widthPx, x, 0, 1, heightPx, withAlpha(NORDIC_EDGE, Math.round(baseAlpha * 0.4)));
    }
  } else if (variant === "dots") {
    fillHorizontalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(leftColor, Math.round(baseAlpha * 0.35)), withAlpha(rightColor, Math.round(baseAlpha * 0.35)));
    const stepX = Math.max(4, Math.round(widthPx / 24));
    const stepY = Math.max(3, Math.round(heightPx / 3));
    for (let y = Math.floor(stepY / 2); y < heightPx; y += stepY) {
      for (let x = Math.floor(stepX / 2); x < widthPx; x += stepX) {
        fillRect(pixels, widthPx, x, y, 1, 1, withAlpha(NORDIC_EDGE, Math.round(baseAlpha * 0.8)));
      }
    }
  } else if (variant === "glow") {
    addRadialGlow(pixels, widthPx, widthPx * (0.18 + pulse * 0.08), heightPx / 2, widthPx * 0.55, withAlpha(leftColor, Math.round(baseAlpha * 0.9)), 0.85);
    addRadialGlow(pixels, widthPx, widthPx * (0.82 - pulse * 0.08), heightPx / 2, widthPx * 0.55, withAlpha(rightColor, Math.round(baseAlpha * 0.9)), 0.85);
  }
}

/**
 * Render a horizontal "prompt enclosure" rule -- a 1-cell-tall gradient strip
 * meant to replace ASCII prompt separators like `------------------`.
 *
 * @param {object} options
 * @param {number} options.columns Cell width of the strip.
 * @param {string} [options.leftColor] CSS color for the left side.
 * @param {string} [options.rightColor] CSS color for the right side.
 * @param {boolean} [options.fadeEdges] Fade alpha at the start/end so the rule
 *   blends into surrounding text instead of butting up against margins.
 * @returns {{ png: Buffer, columns: number, rows: number, widthPx: number, heightPx: number }}
 */
export function renderEditorCursorVline({ cellWidthPx, cellHeightPx, lineHeightScale, backgroundColor = NORDIC_DEEP_BOTTOM, coreColor = NORDIC_EDGE, glowColor = NORDIC_CYAN, alpha = 0.72, columns = 1, rows = 1, heat = 0, glowRadiusCells = 1, trailCells = 0, trailDirection = 1 } = {}) {
  const metrics = resolveCellMetrics({ cellWidthPx, cellHeightPx, lineHeightScale });
  const cols = clampPositive(columns, 1, "columns");
  const rowCount = clampPositive(rows, 1, "rows");
  const widthPx = metrics.cellWidthPx * cols;
  const heightPx = metrics.cellHeightPx * rowCount;
  const pixels = makeCanvas(widthPx, heightPx, [0, 0, 0, 0]);
  const safeHeat = Math.max(0, Math.min(1, Number(heat) || 0));
  const bgAlpha = Math.round(normalizeAlpha(alpha, 0.72) * (18 + 30 * safeHeat));
  const centerCell = Math.floor(cols / 2);
  const cx = Math.floor((centerCell + 0.5) * metrics.cellWidthPx);
  const cy = Math.floor(heightPx / 2);
  const radius = Math.max(metrics.cellWidthPx, metrics.cellWidthPx * Math.max(0.4, Number(glowRadiusCells) || 1) * (1.1 + safeHeat * 1.8));
  addRadialGlow(pixels, widthPx, cx, cy, radius, withAlpha(glowColor, Math.round(bgAlpha * (1.1 + safeHeat))), 0.88);
  if (safeHeat > 0.05) {
    addRadialGlow(pixels, widthPx, cx, cy, radius * 0.62, withAlpha(coreColor, Math.round(36 + safeHeat * 72)), 0.78);
  }
  if (cols === 1 && rowCount === 1) {
    fillHorizontalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(backgroundColor, Math.round(bgAlpha * 0.45)), withAlpha(glowColor, bgAlpha));
  }

  const direction = Number(trailDirection) < 0 ? -1 : 1;
  const trailSpanCells = Math.max(0, Math.min(cols - 1, Number(trailCells) || 0));
  if (safeHeat > 0.03 && trailSpanCells > 0) {
    const behind = -direction;
    const segments = Math.max(1, Math.ceil(trailSpanCells * 2));
    const step = Math.max(2, Math.round(metrics.cellWidthPx * 0.52));
    const segmentW = Math.max(2, Math.round(metrics.cellWidthPx * (0.72 + safeHeat * 0.35)));
    const midH = Math.max(1, Math.round(metrics.cellHeightPx * (0.12 + safeHeat * 0.08)));
    for (let i = 1; i <= segments; i += 1) {
      const fade = 1 - (i - 1) / Math.max(1, segments);
      const x = Math.round(cx + behind * i * step - segmentW / 2);
      const y = Math.round(cy - midH / 2 + ((i % 2) - 0.5) * metrics.cellHeightPx * 0.12);
      const alphaTrail = Math.round((34 + safeHeat * 96) * fade ** 1.35);
      const alphaCore = Math.round((18 + safeHeat * 58) * fade ** 1.8);
      if (alphaTrail > 0) fillRect(pixels, widthPx, x, y, segmentW, midH, withAlpha(glowColor, alphaTrail));
      if (alphaCore > 0) fillRect(pixels, widthPx, x + Math.floor(segmentW * 0.18), y, Math.max(1, Math.floor(segmentW * 0.36)), 1, withAlpha(coreColor, alphaCore));
    }
  }

  const coreW = Math.max(1, Math.min(3, Math.round(metrics.cellWidthPx * (0.20 + safeHeat * 0.10))));
  const coreX = Math.max(0, cx - Math.floor(coreW / 2));
  const coreTop = Math.max(0, Math.floor(cy - metrics.cellHeightPx * (0.62 + safeHeat * 0.18)));
  const coreH = Math.min(heightPx - coreTop, Math.ceil(metrics.cellHeightPx * (1.24 + safeHeat * 0.36)));
  for (let dx = -Math.ceil(metrics.cellWidthPx * 0.55); dx <= Math.ceil(metrics.cellWidthPx * 0.55); dx += 1) {
    const x = cx + dx;
    if (x < 0 || x >= widthPx) continue;
    const distance = Math.abs(dx) / Math.max(1, metrics.cellWidthPx * 0.55);
    const glowA = Math.max(0, Math.round((70 + safeHeat * 90) * (1 - distance) ** 1.8));
    if (glowA > 0) fillRect(pixels, widthPx, x, coreTop, 1, coreH, withAlpha(glowColor, glowA));
  }
  fillRect(pixels, widthPx, coreX, coreTop, coreW, coreH, withAlpha(coreColor, Math.round(224 + safeHeat * 31)));
  fillRect(pixels, widthPx, Math.min(widthPx - 1, coreX + coreW), coreTop + 1, 1, Math.max(1, coreH - 2), withAlpha(glowColor, Math.round(96 + safeHeat * 90)));
  fillRect(pixels, widthPx, Math.max(0, coreX - 1), coreTop + 1, 1, Math.max(1, coreH - 2), withAlpha(coreColor, Math.round(82 + safeHeat * 72)));

  if (cols > 1 && safeHeat > 0.28) {
    const frameAlpha = Math.round(42 + safeHeat * 142);
    const capAlpha = Math.round(34 + safeHeat * 120);
    const flareAlpha = Math.round(Math.max(0, safeHeat - 0.62) * 230);
    const bracketW = Math.max(2, Math.round(metrics.cellWidthPx * (0.42 + safeHeat * 0.14)));
    const bracketH = Math.max(1, Math.round(metrics.cellHeightPx * 0.12));
    const inset = Math.max(2, Math.round(metrics.cellWidthPx * (0.82 + safeHeat * 0.22)));
    const leftX = Math.max(0, coreX - inset);
    const rightX = Math.min(widthPx - bracketW, coreX + coreW + inset - bracketW);
    const topY = Math.max(0, coreTop - bracketH - 1);
    const bottomY = Math.min(heightPx - bracketH, coreTop + coreH + 1);
    fillRect(pixels, widthPx, leftX, topY, bracketW, bracketH, withAlpha(glowColor, frameAlpha));
    fillRect(pixels, widthPx, rightX, topY, bracketW, bracketH, withAlpha(glowColor, frameAlpha));
    fillRect(pixels, widthPx, leftX, bottomY, bracketW, bracketH, withAlpha(coreColor, capAlpha));
    fillRect(pixels, widthPx, rightX, bottomY, bracketW, bracketH, withAlpha(coreColor, capAlpha));
    fillRect(pixels, widthPx, leftX, topY, 1, Math.max(1, Math.round(metrics.cellHeightPx * 0.42)), withAlpha(coreColor, Math.round(frameAlpha * 0.62)));
    fillRect(pixels, widthPx, rightX + bracketW - 1, topY, 1, Math.max(1, Math.round(metrics.cellHeightPx * 0.42)), withAlpha(coreColor, Math.round(frameAlpha * 0.62)));
    if (flareAlpha > 0) {
      fillRect(pixels, widthPx, coreX - Math.max(1, Math.round(metrics.cellWidthPx * 0.5)), topY - 1, Math.max(2, coreW + Math.round(metrics.cellWidthPx)), 1, withAlpha(glowColor, flareAlpha));
      fillRect(pixels, widthPx, coreX - Math.max(1, Math.round(metrics.cellWidthPx * 0.5)), bottomY + bracketH, Math.max(2, coreW + Math.round(metrics.cellWidthPx)), 1, withAlpha(glowColor, Math.round(flareAlpha * 0.72)));
    }
  }

  return {
    png: encodeRgbaPng(pixels, widthPx, heightPx),
    columns: cols,
    rows: rowCount,
    widthPx,
    heightPx,
    cellWidthPx: metrics.cellWidthPx,
    cellHeightPx: metrics.cellHeightPx,
    lineHeightScale: metrics.lineHeightScale,
  };
}

export function renderFooterDividerPng({ columns = 3, barColor = DEFAULT_GRADIENT_LEFT, glowColor = DEFAULT_GRADIENT_RIGHT, alpha = 0.72, cellWidthPx, cellHeightPx, lineHeightScale } = {}) {
  const cols = clampPositive(columns, 3, "columns");
  const metrics = resolveCellMetrics({ cellWidthPx, cellHeightPx, lineHeightScale });
  const widthPx = cols * metrics.cellWidthPx;
  const heightPx = metrics.cellHeightPx;
  const pixels = makeCanvas(widthPx, heightPx, [0, 0, 0, 0]);
  const cx = Math.floor(widthPx / 2);
  const cy = heightPx / 2;
  const safeAlpha = Math.max(0, Math.min(1, Number(alpha) || 0));
  const glowRadius = Math.max(2, Math.min(widthPx * 0.42, metrics.cellWidthPx * 1.05));
  addRadialGlow(pixels, widthPx, cx, cy, glowRadius, [...parseColor(glowColor).slice(0, 3), Math.round(126 * safeAlpha)], 0.72);
  const barW = Math.max(1, Math.round(metrics.cellWidthPx * 0.18));
  const barH = Math.max(2, Math.round(metrics.cellHeightPx * 0.68));
  const barX = cx - Math.floor(barW / 2);
  const barY = Math.floor((heightPx - barH) / 2);
  fillRect(pixels, widthPx, barX - 1, barY + 1, barW + 2, Math.max(1, barH - 2), [...parseColor(glowColor).slice(0, 3), Math.round(70 * safeAlpha)]);
  fillRect(pixels, widthPx, barX, barY, barW, barH, [...parseColor(barColor).slice(0, 3), Math.round(218 * safeAlpha)]);
  return {
    png: encodeRgbaPng(pixels, widthPx, heightPx),
    columns: cols,
    rows: 1,
    widthPx,
    heightPx,
    cellWidthPx: metrics.cellWidthPx,
    cellHeightPx: metrics.cellHeightPx,
    lineHeightScale: metrics.lineHeightScale,
  };
}

function applyHorizontalEdgeFade(pixels, widthPx, heightPx, { fadeLeft = true, fadeRight = true, edgePx = Math.min(widthPx / 4, CELL_PX_W * 3) } = {}) {
  const safeEdge = Math.max(1, Math.min(Math.floor(edgePx), Math.floor(widthPx / 2) || 1));
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 1) {
      let factor = 1;
      if (fadeLeft && x < safeEdge) factor = Math.min(factor, x / safeEdge);
      if (fadeRight && x >= widthPx - safeEdge) factor = Math.min(factor, (widthPx - 1 - x) / safeEdge);
      if (factor >= 1) continue;
      const off = (y * widthPx + x) * 4 + 3;
      pixels[off] = Math.max(0, Math.min(255, Math.round(pixels[off] * Math.max(0, factor))));
    }
  }
}

export function renderPromptEnclosure({ columns, leftColor = DEFAULT_GRADIENT_LEFT, rightColor = DEFAULT_GRADIENT_RIGHT, fadeEdges = true, fadeStart = fadeEdges, fadeEnd = fadeEdges, phase = 0, cellWidthPx, cellHeightPx, lineHeightScale, variant = "rule", alpha = 0.7 } = {}) {
  const cols = clampPositive(columns, 1, "columns");
  const metrics = resolveCellMetrics({ cellWidthPx, cellHeightPx, lineHeightScale });
  const widthPx = cols * metrics.cellWidthPx;
  const heightPx = metrics.cellHeightPx;
  const pixels = makeCanvas(widthPx, heightPx, [0, 0, 0, 0]);

  const safeVariant = SURFACE_VARIANTS.includes(variant) ? variant : "rule";
  if (safeVariant !== "rule") {
    paintSurfaceVariant(pixels, widthPx, heightPx, {
      variant: safeVariant,
      leftColor,
      rightColor,
      alpha,
      phase,
    });
    if (fadeStart || fadeEnd) applyHorizontalEdgeFade(pixels, widthPx, heightPx, { fadeLeft: !!fadeStart, fadeRight: !!fadeEnd });
    return {
      png: encodeRgbaPng(pixels, widthPx, heightPx),
      columns: cols,
      rows: 1,
      widthPx,
      heightPx,
      cellWidthPx: metrics.cellWidthPx,
      cellHeightPx: metrics.cellHeightPx,
      lineHeightScale: metrics.lineHeightScale,
      variant: safeVariant,
    };
  }

  const pulse = pulseFactor(phase);
  const stripeY = Math.floor(heightPx / 2) - 2;
  const stripeH = 4;

  // A small glow halo makes the separator visibly graphical rather than an
  // ASCII line replacement. It stays one cell tall for layout stability.
  addRadialGlow(pixels, widthPx, widthPx * (0.18 + pulse * 0.08), heightPx / 2, widthPx * 0.36, withAlpha(leftColor, 90 + pulse * 80), 0.7);
  addRadialGlow(pixels, widthPx, widthPx * (0.82 - pulse * 0.08), heightPx / 2, widthPx * 0.36, withAlpha(rightColor, 90 + pulse * 80), 0.7);

  if (fadeStart || fadeEnd) {
    const edgePx = Math.min(widthPx / 4, CELL_PX_W * 3);
    fillHorizontalGradient(
      pixels,
      widthPx,
      0,
      stripeY,
      edgePx,
      stripeH,
      withAlpha(leftColor, fadeStart ? 0 : 180 + pulse * 55),
      withAlpha(leftColor, 180 + pulse * 55),
    );
    fillHorizontalGradient(
      pixels,
      widthPx,
      edgePx,
      stripeY,
      widthPx - edgePx * 2,
      stripeH,
      withAlpha(leftColor, 180 + pulse * 55),
      withAlpha(rightColor, 180 + pulse * 55),
    );
    fillHorizontalGradient(
      pixels,
      widthPx,
      widthPx - edgePx,
      stripeY,
      edgePx,
      stripeH,
      withAlpha(rightColor, 180 + pulse * 55),
      withAlpha(rightColor, fadeEnd ? 0 : 180 + pulse * 55),
    );
  } else {
    fillHorizontalGradient(pixels, widthPx, 0, stripeY, widthPx, stripeH, withAlpha(leftColor, 220), withAlpha(rightColor, 220));
  }

  fillHorizontalGradient(pixels, widthPx, CELL_PX_W, stripeY + 1, Math.max(1, widthPx - CELL_PX_W * 2), 1, NORDIC_EDGE, withAlpha(NORDIC_EDGE, 120));

  return {
    png: encodeRgbaPng(pixels, widthPx, heightPx),
    columns: cols,
    rows: 1,
    widthPx,
    heightPx,
    cellWidthPx: metrics.cellWidthPx,
    cellHeightPx: metrics.cellHeightPx,
    lineHeightScale: metrics.lineHeightScale,
    variant: "rule",
  };
}

/**
 * Render a translucent gradient border box that frames a rectangular block
 * (e.g. an agent message, table, code block).
 *
 * @returns {{ png: Buffer, columns: number, rows: number, widthPx: number, heightPx: number }}
 */
export function renderGradientBorder({
  columns,
  rows,
  topColor = DEFAULT_GRADIENT_LEFT,
  bottomColor = DEFAULT_GRADIENT_RIGHT,
  fillColor = DEFAULT_BORDER_FILL,
  borderThickness = 1,
  cornerRadius = 0,
} = {}) {
  const cols = clampPositive(columns, 1, "columns");
  const rs = clampPositive(rows, 1, "rows");
  const widthPx = cols * CELL_PX_W;
  const heightPx = rs * CELL_PX_H;
  const pixels = makeCanvas(widthPx, heightPx, fillColor);

  // Vertical color sweep across the border by drawing per-row strokes.
  const top = parseColor(topColor);
  const bottom = parseColor(bottomColor);
  const span = Math.max(1, heightPx - 1);
  const thickness = Math.max(1, Math.trunc(borderThickness));

  for (let y = 0; y < heightPx; y += 1) {
    const t = y / span;
    const color = [
      Math.round(top[0] + (bottom[0] - top[0]) * t),
      Math.round(top[1] + (bottom[1] - top[1]) * t),
      Math.round(top[2] + (bottom[2] - top[2]) * t),
      Math.round(top[3] + (bottom[3] - top[3]) * t),
    ];
    if (y < thickness || y >= heightPx - thickness) {
      fillRect(pixels, widthPx, 0, y, widthPx, 1, color);
    } else {
      fillRect(pixels, widthPx, 0, y, thickness, 1, color);
      fillRect(pixels, widthPx, widthPx - thickness, y, thickness, 1, color);
    }
  }

  if (cornerRadius > 0) {
    const r = Math.min(cornerRadius, Math.min(widthPx, heightPx) / 2);
    // Rough corner softening: punch alpha=0 squares outside the rounded corners.
    for (let y = 0; y < r; y += 1) {
      for (let x = 0; x < r; x += 1) {
        const dx = r - x - 0.5;
        const dy = r - y - 0.5;
        if (dx * dx + dy * dy > r * r) {
          stampTransparent(pixels, widthPx, x, y);
          stampTransparent(pixels, widthPx, widthPx - 1 - x, y);
          stampTransparent(pixels, widthPx, x, heightPx - 1 - y);
          stampTransparent(pixels, widthPx, widthPx - 1 - x, heightPx - 1 - y);
        }
      }
    }
  }

  return {
    png: encodeRgbaPng(pixels, widthPx, heightPx),
    columns: cols,
    rows: rs,
    widthPx,
    heightPx,
  };
}

/**
 * Render a high-contrast Nordic glow panel for Pi kitty graphics mode.
 *
 * This is intentionally more opinionated than the simple border helper: it
 * gives the terminal a visibly graphical surface with layered deep-blue fill,
 * cyan/violet aurora glows, bright edge strokes, and subtle scanlines. `phase`
 * is normalized (0..1) and changes glow centers/alpha so callers can animate
 * by updating only the small PNG for a stable cell footprint.
 *
 * @returns {{ png: Buffer, columns: number, rows: number, widthPx: number, heightPx: number, phase: number }}
 */
export function renderGlowPanel({
  columns,
  rows,
  phase = 0,
  borderThickness = 2,
  scanlines = true,
} = {}) {
  const cols = clampPositive(columns, 2, "columns");
  const rs = clampPositive(rows, 2, "rows");
  const widthPx = cols * CELL_PX_W;
  const heightPx = rs * CELL_PX_H;
  const normalizedPhase = ((Number(phase) || 0) % 1 + 1) % 1;
  const pulse = pulseFactor(normalizedPhase);
  const pixels = makeCanvas(widthPx, heightPx, [0, 0, 0, 0]);

  fillVerticalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, NORDIC_DEEP_TOP, NORDIC_DEEP_BOTTOM);
  fillHorizontalGradient(pixels, widthPx, 0, 0, widthPx, Math.max(2, Math.floor(heightPx * 0.16)), withAlpha(NORDIC_CYAN, 70 + pulse * 80), withAlpha(NORDIC_VIOLET, 36 + pulse * 52));
  fillHorizontalGradient(pixels, widthPx, 0, heightPx - Math.max(2, Math.floor(heightPx * 0.12)), widthPx, Math.max(2, Math.floor(heightPx * 0.12)), withAlpha(NORDIC_BLUE, 28 + pulse * 46), withAlpha(NORDIC_AURORA, 64 + pulse * 64));

  drawGlowFrame(pixels, widthPx, heightPx, { phase: normalizedPhase, borderThickness });

  // Corner ticks sell the "rendered TUI component" look without spending many
  // pixels. They remain tiny enough to compress well under PNG deflate.
  const tick = Math.max(6, Math.min(widthPx, heightPx) * 0.08);
  const tickAlpha = 150 + Math.round(pulse * 85);
  fillRect(pixels, widthPx, 2, 2, tick, 2, withAlpha(NORDIC_EDGE, tickAlpha));
  fillRect(pixels, widthPx, 2, 2, 2, tick, withAlpha(NORDIC_EDGE, tickAlpha));
  fillRect(pixels, widthPx, widthPx - tick - 2, 2, tick, 2, withAlpha(NORDIC_VIOLET, tickAlpha));
  fillRect(pixels, widthPx, widthPx - 4, 2, 2, tick, withAlpha(NORDIC_VIOLET, tickAlpha));
  fillRect(pixels, widthPx, 2, heightPx - 4, tick, 2, withAlpha(NORDIC_CYAN, tickAlpha));
  fillRect(pixels, widthPx, 2, heightPx - tick - 2, 2, tick, withAlpha(NORDIC_CYAN, tickAlpha));
  fillRect(pixels, widthPx, widthPx - tick - 2, heightPx - 4, tick, 2, withAlpha(NORDIC_AURORA, tickAlpha));
  fillRect(pixels, widthPx, widthPx - 4, heightPx - tick - 2, 2, tick, withAlpha(NORDIC_AURORA, tickAlpha));

  if (scanlines) addScanlines(pixels, widthPx, { every: 5, alpha: 14 + pulse * 12, color: NORDIC_EDGE });

  return {
    png: encodeRgbaPng(pixels, widthPx, heightPx),
    columns: cols,
    rows: rs,
    widthPx,
    heightPx,
    phase: normalizedPhase,
  };
}

export function renderGlowPanelFrames({ frames = 8, ...options } = {}) {
  const count = Math.max(1, Math.min(256, Math.trunc(Number(frames) || 24)));
  return Array.from({ length: count }, (_, index) => renderGlowPanel({ ...options, phase: index / count }));
}

function stampTransparent(pixels, width, x, y) {
  const off = (y * width + x) * 4;
  if (off < 0 || off + 4 > pixels.length) return;
  pixels[off] = 0;
  pixels[off + 1] = 0;
  pixels[off + 2] = 0;
  pixels[off + 3] = 0;
}

/**
 * Render a solid-fill 1-cell-tall accent bar with a stroke outline. Useful as
 * a clickable-looking affordance before/after table rows.
 */
export function renderAccentBar({ columns, color = DEFAULT_BORDER_COLOR, alpha = DEFAULT_GRADIENT_FADE_ALPHA, strokeColor } = {}) {
  const cols = clampPositive(columns, 1, "columns");
  const widthPx = cols * CELL_PX_W;
  const heightPx = CELL_PX_H;
  const pixels = makeCanvas(widthPx, heightPx, [0, 0, 0, 0]);
  fillRect(pixels, widthPx, 0, Math.floor(heightPx / 4), widthPx, Math.ceil(heightPx / 2), withAlpha(color, alpha));
  if (strokeColor) {
    strokeRect(pixels, widthPx, 0, Math.floor(heightPx / 4), widthPx, Math.ceil(heightPx / 2), strokeColor, 1);
  }
  return {
    png: encodeRgbaPng(pixels, widthPx, heightPx),
    columns: cols,
    rows: 1,
    widthPx,
    heightPx,
  };
}

function paintEditorBoxFrame(pixels, widthPx, heightPx, {
  paddingCells = 1,
  borderColor = NORDIC_CYAN,
  borderAlpha = 0.55,
  fillTop = NORDIC_DEEP_TOP,
  fillBottom = NORDIC_DEEP_BOTTOM,
  glowColor = NORDIC_VIOLET,
  glowAlpha = 0.35,
  cellWidthPx = CELL_PX_W,
  cellHeightPx = CELL_PX_H,
  phase = 0,
} = {}) {
  const pad = Math.max(0, Math.trunc(paddingCells));
  const innerLeft = pad * cellWidthPx;
  const innerRight = widthPx - pad * cellWidthPx;
  const innerTop = cellHeightPx;
  const innerBottom = heightPx - cellHeightPx;
  if (innerRight <= innerLeft || innerBottom <= innerTop) return;
  fillVerticalGradient(
    pixels,
    widthPx,
    innerLeft,
    innerTop,
    innerRight - innerLeft,
    innerBottom - innerTop,
    withAlpha(fillTop, 110),
    withAlpha(fillBottom, 150),
  );
  const stroke = withAlpha(borderColor, Math.round(normalizeAlpha(borderAlpha, 0.55) * 255));
  strokeRect(pixels, widthPx, innerLeft, innerTop, innerRight - innerLeft, innerBottom - innerTop, stroke, 1);
  const pulse = pulseFactor(phase);
  const glow = withAlpha(glowColor, Math.round(normalizeAlpha(glowAlpha, 0.35) * 255 * (0.7 + pulse * 0.6)));
  addRadialGlow(pixels, widthPx, widthPx * (0.2 + pulse * 0.1), innerTop, widthPx * 0.4, glow, 0.85);
  addRadialGlow(pixels, widthPx, widthPx * (0.8 - pulse * 0.1), innerBottom, widthPx * 0.4, glow, 0.85);
}

export function renderEditorBoxFrame({
  columns,
  rows,
  paddingCells = 1,
  borderColor,
  borderAlpha,
  fillTop,
  fillBottom,
  glowColor,
  glowAlpha,
  cellWidthPx,
  cellHeightPx,
  lineHeightScale,
  phase = 0,
} = {}) {
  const cols = clampPositive(columns, 2, "columns");
  const totalRows = Math.max(3, Math.trunc(Number(rows) || 3));
  const metrics = resolveCellMetrics({ cellWidthPx, cellHeightPx, lineHeightScale });
  const widthPx = cols * metrics.cellWidthPx;
  const heightPx = totalRows * metrics.cellHeightPx;
  const pixels = makeCanvas(widthPx, heightPx, [0, 0, 0, 0]);
  paintEditorBoxFrame(pixels, widthPx, heightPx, {
    paddingCells,
    borderColor,
    borderAlpha,
    fillTop,
    fillBottom,
    glowColor,
    glowAlpha,
    cellWidthPx: metrics.cellWidthPx,
    cellHeightPx: metrics.cellHeightPx,
    phase,
  });
  return {
    pixels,
    widthPx,
    heightPx,
    columns: cols,
    rows: totalRows,
    cellWidthPx: metrics.cellWidthPx,
    cellHeightPx: metrics.cellHeightPx,
    lineHeightScale: metrics.lineHeightScale,
  };
}

export function renderEditorBox(options = {}) {
  const frame = renderEditorBoxFrame(options);
  return {
    png: encodeRgbaPng(frame.pixels, frame.widthPx, frame.heightPx),
    columns: frame.columns,
    rows: frame.rows,
    widthPx: frame.widthPx,
    heightPx: frame.heightPx,
    cellWidthPx: frame.cellWidthPx,
    cellHeightPx: frame.cellHeightPx,
    lineHeightScale: frame.lineHeightScale,
  };
}

export function renderEditorBoxApng({ frames = 8, delayMs = 120, plays = 0, ...options } = {}) {
  const count = Math.max(1, Math.min(256, Math.trunc(Number(frames) || 24)));
  const rendered = Array.from({ length: count }, (_, index) =>
    renderEditorBoxFrame({ ...options, phase: (Number(options.phase) || 0) + index / count }),
  );
  const first = rendered[0];
  const png = encodeRgbaApng(
    rendered.map((frame) => frame.pixels),
    first.widthPx,
    first.heightPx,
    { delayMs, plays },
  );
  return {
    png,
    columns: first.columns,
    rows: first.rows,
    widthPx: first.widthPx,
    heightPx: first.heightPx,
    cellWidthPx: first.cellWidthPx,
    cellHeightPx: first.cellHeightPx,
    lineHeightScale: first.lineHeightScale,
    frames: count,
    delayMs,
    animationMs: delayMs * count,
  };
}

function paintEditorRailFrame(pixels, widthPx, heightPx, {
  edge = "top",
  glowColor = NORDIC_VIOLET,
  glowAlpha = 0.5,
  phase = 0,
} = {}) {
  const pulse = pulseFactor(phase);
  const glowA = Math.round(normalizeAlpha(glowAlpha, 0.5) * 255 * (0.55 + pulse * 0.65));
  // bright opaque near editor edge, fading to nothing away from editor
  if (edge === "bottom") {
    fillVerticalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(glowColor, glowA), withAlpha(glowColor, 0));
    const strokeH = Math.max(2, Math.round(heightPx * 0.08));
    fillRect(pixels, widthPx, 0, 0, widthPx, strokeH, withAlpha(glowColor, Math.min(255, glowA + 80)));
  } else {
    fillVerticalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(glowColor, 0), withAlpha(glowColor, glowA));
    const strokeH = Math.max(2, Math.round(heightPx * 0.08));
    fillRect(pixels, widthPx, 0, heightPx - strokeH, widthPx, strokeH, withAlpha(glowColor, Math.min(255, glowA + 80)));
  }
  const anchorY = edge === "bottom" ? 0 : heightPx - 1;
  addRadialGlow(pixels, widthPx, widthPx * (0.18 + pulse * 0.08), anchorY, widthPx * 0.4, withAlpha(glowColor, glowA), 0.85);
  addRadialGlow(pixels, widthPx, widthPx * (0.82 - pulse * 0.08), anchorY, widthPx * 0.4, withAlpha(glowColor, glowA), 0.85);
}

export function renderEditorRailFrame({ columns, rows = 1, edge = "top", glowColor, glowAlpha = 0.5, cellWidthPx, cellHeightPx, lineHeightScale, phase = 0 } = {}) {
  const cols = clampPositive(columns, 2, "columns");
  const rs = Math.max(1, Math.trunc(Number(rows) || 1));
  const metrics = resolveCellMetrics({ cellWidthPx, cellHeightPx, lineHeightScale });
  const widthPx = cols * metrics.cellWidthPx;
  const heightPx = rs * metrics.cellHeightPx;
  const pixels = makeCanvas(widthPx, heightPx, [0, 0, 0, 0]);
  paintEditorRailFrame(pixels, widthPx, heightPx, { edge, glowColor, glowAlpha, phase });
  return { pixels, widthPx, heightPx, columns: cols, rows: rs, cellWidthPx: metrics.cellWidthPx, cellHeightPx: metrics.cellHeightPx, lineHeightScale: metrics.lineHeightScale };
}

export function renderEditorRailApng({ frames = 24, delayMs = 120, plays = 0, ...options } = {}) {
  const count = Math.max(1, Math.min(256, Math.trunc(Number(frames) || 24)));
  const rendered = Array.from({ length: count }, (_, index) => renderEditorRailFrame({ ...options, phase: (Number(options.phase) || 0) + index / count }));
  const first = rendered[0];
  const png = encodeRgbaApng(rendered.map((frame) => frame.pixels), first.widthPx, first.heightPx, { delayMs, plays });
  return { png, columns: first.columns, rows: first.rows, widthPx: first.widthPx, heightPx: first.heightPx, cellWidthPx: first.cellWidthPx, cellHeightPx: first.cellHeightPx, lineHeightScale: first.lineHeightScale, frames: count, delayMs, animationMs: delayMs * count };
}

function paintEditorBorderFrame(pixels, widthPx, heightPx, {
  edge = "symmetric",
  borderColor = NORDIC_CYAN,
  borderAlpha = 0.55,
  glowColor = NORDIC_VIOLET,
  glowAlpha = 0.34,
  phase = 0,
} = {}) {
  const pulse = pulseFactor(phase);
  const borderA = Math.round(normalizeAlpha(borderAlpha, 0.55) * 255);
  const glowA = Math.round(normalizeAlpha(glowAlpha, 0.4) * 255 * (0.6 + pulse * 0.6));
  const strokeH = Math.max(2, Math.round(heightPx * 0.18));
  const borderRgb = parseColor(borderColor);
  const glowRgb = parseColor(glowColor);
  const specularRgb = [
    Math.min(255, borderRgb[0] + Math.round((255 - borderRgb[0]) * 0.6)),
    Math.min(255, borderRgb[1] + Math.round((255 - borderRgb[1]) * 0.6)),
    Math.min(255, borderRgb[2] + Math.round((255 - borderRgb[2]) * 0.6)),
  ];
  const shadowRgb = [
    Math.max(0, Math.round(borderRgb[0] * 0.35)),
    Math.max(0, Math.round(borderRgb[1] * 0.35)),
    Math.max(0, Math.round(borderRgb[2] * 0.35)),
  ];
  function paintTwoToneStroke(strokeY) {
    // Per-row vertical blend: top of stroke is `borderColor` (cool theme accent),
    // bottom is `glowColor` (aurora/violet tint). Adds a glassy edge feel.
    for (let dy = 0; dy < strokeH; dy += 1) {
      const t = strokeH <= 1 ? 0 : dy / (strokeH - 1);
      const r = Math.round(borderRgb[0] * (1 - t) + glowRgb[0] * t);
      const g = Math.round(borderRgb[1] * (1 - t) + glowRgb[1] * t);
      const b = Math.round(borderRgb[2] * (1 - t) + glowRgb[2] * t);
      fillRect(pixels, widthPx, 0, strokeY + dy, widthPx, 1, [r, g, b, borderA]);
    }
    // 1px specular highlight just above the stroke (bright, low alpha).
    if (strokeY - 1 >= 0) {
      fillRect(pixels, widthPx, 0, strokeY - 1, widthPx, 1, [specularRgb[0], specularRgb[1], specularRgb[2], Math.round(borderA * 0.38)]);
    }
    // 1px shadow just below the stroke (darker, low alpha).
    if (strokeY + strokeH < heightPx) {
      fillRect(pixels, widthPx, 0, strokeY + strokeH, widthPx, 1, [shadowRgb[0], shadowRgb[1], shadowRgb[2], Math.round(borderA * 0.32)]);
    }
  }
  if (edge === "top") {
    fillVerticalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(glowColor, 0), withAlpha(glowColor, glowA));
    paintTwoToneStroke(heightPx - strokeH);
  } else if (edge === "bottom") {
    fillVerticalGradient(pixels, widthPx, 0, 0, widthPx, heightPx, withAlpha(glowColor, glowA), withAlpha(glowColor, 0));
    paintTwoToneStroke(0);
  } else {
    // Symmetric: alpha 0 at top -> glowA at center -> 0 at bottom.
    const mid = Math.floor(heightPx / 2);
    fillVerticalGradient(pixels, widthPx, 0, 0, widthPx, mid, withAlpha(glowColor, 0), withAlpha(glowColor, glowA));
    fillVerticalGradient(pixels, widthPx, 0, mid, widthPx, heightPx - mid, withAlpha(glowColor, glowA), withAlpha(glowColor, 0));
    const strokeY = Math.max(0, mid - Math.floor(strokeH / 2));
    paintTwoToneStroke(strokeY);
    // Heartbeat pulse: a bright bump that sweeps left -> right along the stroke.
    const sweepPhase = ((Number(phase) || 0) % 1 + 1) % 1;
    const peakX = sweepPhase * widthPx;
    const halfWidthPx = Math.max(widthPx * 0.08, 12);
    const peakColor = parseColor(borderColor);
    const haloColor = parseColor(glowColor);
    for (let x = 0; x < widthPx; x += 1) {
      const dx = Math.abs(x - peakX);
      if (dx > halfWidthPx * 1.8) continue;
      const t = Math.max(0, 1 - dx / halfWidthPx);
      const power = t * t; // ease so the peak is concentrated near the head
      // brighten the stroke band itself
      for (let y = strokeY; y < strokeY + strokeH; y += 1) {
        const off = (y * widthPx + x) * 4;
        pixels[off] = Math.min(255, Math.round(pixels[off] * (1 - power * 0.4) + peakColor[0] * power));
        pixels[off + 1] = Math.min(255, Math.round(pixels[off + 1] * (1 - power * 0.4) + peakColor[1] * power));
        pixels[off + 2] = Math.min(255, Math.round(pixels[off + 2] * (1 - power * 0.4) + peakColor[2] * power));
        pixels[off + 3] = Math.min(255, Math.round(pixels[off + 3] + (255 - pixels[off + 3]) * power * 0.28));
      }
      // halo above/below the stroke
      const haloReach = Math.max(2, Math.round(heightPx * 0.4));
      for (let dyOff = 1; dyOff <= haloReach; dyOff += 1) {
        const fade = power * (1 - dyOff / (haloReach + 1));
        if (fade <= 0) continue;
        for (const y of [strokeY - dyOff, strokeY + strokeH - 1 + dyOff]) {
          if (y < 0 || y >= heightPx) continue;
          const off = (y * widthPx + x) * 4;
          pixels[off] = Math.min(255, Math.round(pixels[off] * (1 - fade * 0.35) + haloColor[0] * fade));
          pixels[off + 1] = Math.min(255, Math.round(pixels[off + 1] * (1 - fade * 0.35) + haloColor[1] * fade));
          pixels[off + 2] = Math.min(255, Math.round(pixels[off + 2] * (1 - fade * 0.35) + haloColor[2] * fade));
          pixels[off + 3] = Math.min(255, Math.round(pixels[off + 3] + (255 - pixels[off + 3]) * fade * 0.24));
        }
      }
    }
  }
  const anchors = edge === "top" ? [heightPx - 1] : edge === "bottom" ? [0] : [Math.floor(heightPx / 2)];
  for (const anchorY of anchors) {
    addRadialGlow(pixels, widthPx, widthPx * (0.2 + pulse * 0.1), anchorY, widthPx * 0.45, withAlpha(glowColor, glowA), 0.9);
    addRadialGlow(pixels, widthPx, widthPx * (0.8 - pulse * 0.1), anchorY, widthPx * 0.45, withAlpha(glowColor, glowA), 0.9);
  }
  // Hard guarantee: alpha goes to zero at the cell edges so the glyph reads as
  // a freestanding band with no abutting cutoff. We rescale alpha within an
  // edge fade band; the bright center stays opaque. The horizontal taper makes
  // the border narrow to a fine point at the leftmost and rightmost columns so
  // it does not look hard-cut at the terminal edges.
  const fadeBand = Math.max(2, Math.round(heightPx * 0.3));
  const horizontalTaperPx = Math.max(16, Math.round(widthPx * 0.12));
  for (let y = 0; y < heightPx; y += 1) {
    let vFactor = 1;
    if (edge === "top") {
      if (y < fadeBand) vFactor = y / fadeBand;
    } else if (edge === "bottom") {
      if (y >= heightPx - fadeBand) vFactor = (heightPx - 1 - y) / fadeBand;
    } else {
      const distTop = y;
      const distBottom = heightPx - 1 - y;
      const dist = Math.min(distTop, distBottom);
      if (dist < fadeBand) vFactor = dist / fadeBand;
    }
    for (let x = 0; x < widthPx; x += 1) {
      const distLeft = x;
      const distRight = widthPx - 1 - x;
      const hDist = Math.min(distLeft, distRight);
      const hFactorRaw = hDist >= horizontalTaperPx ? 1 : hDist / horizontalTaperPx;
      // smoothstep ease: 3t^2 - 2t^3, gentler than t^2 with no hard knee.
      const hFactor = hFactorRaw * hFactorRaw * (3 - 2 * hFactorRaw);
      const factor = Math.max(0, Math.min(1, vFactor * hFactor));
      if (factor >= 1) continue;
      const off = (y * widthPx + x) * 4 + 3;
      pixels[off] = Math.round(pixels[off] * factor);
    }
  }
}

export function renderEditorBorderFrame({ columns, edge = "symmetric", borderColor, borderAlpha = 0.55, glowColor, glowAlpha = 0.34, cellWidthPx, cellHeightPx, lineHeightScale, phase = 0 } = {}) {
  const cols = clampPositive(columns, 2, "columns");
  const metrics = resolveCellMetrics({ cellWidthPx, cellHeightPx, lineHeightScale });
  const widthPx = cols * metrics.cellWidthPx;
  const heightPx = metrics.cellHeightPx;
  const pixels = makeCanvas(widthPx, heightPx, [0, 0, 0, 0]);
  paintEditorBorderFrame(pixels, widthPx, heightPx, { edge, borderColor, borderAlpha, glowColor, glowAlpha, phase });
  return { pixels, widthPx, heightPx, columns: cols, rows: 1, cellWidthPx: metrics.cellWidthPx, cellHeightPx: metrics.cellHeightPx, lineHeightScale: metrics.lineHeightScale };
}

export function renderEditorBorderFramesPngs({ frames = 24, ...options } = {}) {
  const count = Math.max(1, Math.min(256, Math.trunc(Number(frames) || 24)));
  const rendered = Array.from({ length: count }, (_, index) => renderEditorBorderFrame({ ...options, phase: (Number(options.phase) || 0) + index / count }));
  const first = rendered[0];
  const pngs = rendered.map((f) => encodeRgbaPng(f.pixels, f.widthPx, f.heightPx));
  return { pngs, columns: first.columns, rows: first.rows, widthPx: first.widthPx, heightPx: first.heightPx, frames: count };
}

export function renderEditorBorderApng({ frames = 24, delayMs = 120, plays = 0, ...options } = {}) {
  const count = Math.max(1, Math.min(256, Math.trunc(Number(frames) || 24)));
  const rendered = Array.from({ length: count }, (_, index) => renderEditorBorderFrame({ ...options, phase: (Number(options.phase) || 0) + index / count }));
  const first = rendered[0];
  const png = encodeRgbaApng(rendered.map((frame) => frame.pixels), first.widthPx, first.heightPx, { delayMs, plays });
  return { png, columns: first.columns, rows: 1, widthPx: first.widthPx, heightPx: first.heightPx, cellWidthPx: first.cellWidthPx, cellHeightPx: first.cellHeightPx, lineHeightScale: first.lineHeightScale, frames: count, delayMs, animationMs: delayMs * count };
}

export const DEFAULTS = Object.freeze({
  CELL_PX_W,
  CELL_PX_H,
  DEFAULT_GRADIENT_LEFT,
  DEFAULT_GRADIENT_RIGHT,
  DEFAULT_BORDER_COLOR,
});
