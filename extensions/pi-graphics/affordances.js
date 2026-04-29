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
  encodeRgbaPng,
  fillHorizontalGradient,
  fillRect,
  makeCanvas,
  parseColor,
  strokeRect,
} from "./png-renderer.js";

export const CELL_PX_W = 8;
export const CELL_PX_H = 16;

const DEFAULT_GRADIENT_LEFT = "#5e81ac";
const DEFAULT_GRADIENT_RIGHT = "#88c0d0";
const DEFAULT_GRADIENT_FADE_ALPHA = 0x66;
const DEFAULT_BORDER_COLOR = "#5e81ac";
const DEFAULT_BORDER_FILL = [0, 0, 0, 0];

function clampPositive(value, fallback, name) {
  const n = Math.trunc(Number(value ?? fallback));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`pi-graphics affordance ${name} must be a positive integer, got ${value}`);
  }
  return n;
}

function withAlpha(color, alpha) {
  const [r, g, b] = parseColor(color);
  return [r, g, b, Math.max(0, Math.min(255, Math.trunc(alpha)))];
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
export function renderPromptEnclosure({ columns, leftColor = DEFAULT_GRADIENT_LEFT, rightColor = DEFAULT_GRADIENT_RIGHT, fadeEdges = true } = {}) {
  const cols = clampPositive(columns, 1, "columns");
  const widthPx = cols * CELL_PX_W;
  const heightPx = CELL_PX_H;
  const pixels = makeCanvas(widthPx, heightPx, [0, 0, 0, 0]);

  const stripeY = Math.floor(heightPx / 2) - 1;
  const stripeH = 2;

  if (fadeEdges) {
    const edgePx = Math.min(widthPx / 4, CELL_PX_W * 2);
    fillHorizontalGradient(
      pixels,
      widthPx,
      0,
      stripeY,
      edgePx,
      stripeH,
      withAlpha(leftColor, 0),
      leftColor,
    );
    fillHorizontalGradient(
      pixels,
      widthPx,
      edgePx,
      stripeY,
      widthPx - edgePx * 2,
      stripeH,
      leftColor,
      rightColor,
    );
    fillHorizontalGradient(
      pixels,
      widthPx,
      widthPx - edgePx,
      stripeY,
      edgePx,
      stripeH,
      rightColor,
      withAlpha(rightColor, 0),
    );
  } else {
    fillHorizontalGradient(pixels, widthPx, 0, stripeY, widthPx, stripeH, leftColor, rightColor);
  }

  return {
    png: encodeRgbaPng(pixels, widthPx, heightPx),
    columns: cols,
    rows: 1,
    widthPx,
    heightPx,
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

export const DEFAULTS = Object.freeze({
  CELL_PX_W,
  CELL_PX_H,
  DEFAULT_GRADIENT_LEFT,
  DEFAULT_GRADIENT_RIGHT,
  DEFAULT_BORDER_COLOR,
});
