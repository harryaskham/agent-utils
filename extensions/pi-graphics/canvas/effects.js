// Pixel effects for the Pi canvas: caret styles with typing-heat bloom,
// keystroke impulses, editor-card glow states, and the animated background.
// Everything renders straight RGBA buffers; the canvas controller decides
// when to upload, cycle and place them.

import { addRadialGlow } from "../png-renderer.js";
import { fillPaths, strokeArcPath } from "./raster.js";

export const CARET_STYLES = Object.freeze(["bloom", "glow", "beam", "block", "underline"]);
export const EDITOR_STATES = Object.freeze(["idle", "typing", "thinking", "working", "speaking"]);
export const BACKGROUNDS = Object.freeze(["aurora", "static", "transparent", "none"]);
export const STREAM_EFFECTS = Object.freeze(["float", "fade", "none"]);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export function mixRgb(a, b, t) {
  const k = clamp01(t);
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k));
}

function blendPixel(fb, i, r, g, b, a) {
  if (a <= 0) return;
  const sa = a / 255; const da = fb[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  const k = sa / oa;
  fb[i] = fb[i] + (r - fb[i]) * k;
  fb[i + 1] = fb[i + 1] + (g - fb[i + 1]) * k;
  fb[i + 2] = fb[i + 2] + (b - fb[i + 2]) * k;
  fb[i + 3] = oa * 255;
}

/** Elliptical soft glow (Gaussian-ish falloff). */
function ellipseGlow(fb, w, h, cx, cy, rx, ry, rgb, alpha) {
  const x0 = Math.max(0, Math.floor(cx - rx)); const x1 = Math.min(w - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry)); const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y += 1) {
    const dy = (y + 0.5 - cy) / ry;
    for (let x = x0; x <= x1; x += 1) {
      const dx = (x + 0.5 - cx) / rx;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 1) continue;
      const falloff = Math.exp(-d2 * 3.2) - Math.exp(-3.2);
      blendPixel(fb, (y * w + x) * 4, rgb[0], rgb[1], rgb[2], Math.round(alpha * falloff / (1 - Math.exp(-3.2))));
    }
  }
}

/**
 * Caret image. The image is a fixed box of `cols x rows` cells centred on the
 * cursor cell so every heat bucket shares one anchor. Returns
 * { rgba, width, height, anchorX, anchorY } — anchor = cursor cell origin.
 */
export function renderCaret({ style = "bloom", cellWidth, cellHeight, heat = 0, bloom = 1, colors }) {
  const cols = style === "bloom" ? 15 : style === "beam" ? 3 : 7;
  const rows = style === "bloom" ? 5 : 3;
  const w = cols * cellWidth; const h = rows * cellHeight;
  const fb = Buffer.alloc(w * h * 4);
  const anchorX = Math.floor(cols / 2) * cellWidth; const anchorY = Math.floor(rows / 2) * cellHeight;
  const t = clamp01(heat);
  const calm = colors.accent; const warm = colors.warm; const hot = [255, 244, 228];
  const base = t < 0.5 ? mixRgb(calm, warm, t / 0.5) : mixRgb(warm, hot, (t - 0.5) / 0.5);
  const cx = anchorX + Math.max(1, cellWidth * 0.12); const cy = anchorY + cellHeight / 2;
  const strength = Math.max(0, Number(bloom) || 0);
  if (style === "bloom") {
    // Light bleeding over neighbouring text: an anamorphic ellipse that widens
    // and warms with typing speed, plus a tight core halo.
    ellipseGlow(fb, w, h, cx, cy, cellWidth * (1.6 + t * 5.4), cellHeight * (0.9 + t * 1.3), base, (60 + t * 90) * strength);
    ellipseGlow(fb, w, h, cx, cy, cellWidth * (0.9 + t * 1.6), cellHeight * (0.65 + t * 0.4), mixRgb(base, [255, 255, 255], 0.3), (70 + t * 80) * strength);
    if (t > 0.55) {
      const flare = (t - 0.55) / 0.45;
      ellipseGlow(fb, w, h, cx, cy, cellWidth * (3 + flare * 4), Math.max(2, cellHeight * 0.12), [255, 255, 255], 110 * flare * strength);
    }
  } else if (style === "glow") {
    addRadialGlow(fb, w, cx, cy, cellHeight * (0.8 + t * 0.6), [...base, Math.round((70 + t * 60) * strength)], 1);
  } else if (style === "block") {
    fillPaths(fb, w, h, [[anchorX, anchorY + 1, anchorX + cellWidth, anchorY + 1, anchorX + cellWidth, anchorY + cellHeight - 1, anchorX, anchorY + cellHeight - 1]], ...base, 110);
    addRadialGlow(fb, w, anchorX + cellWidth / 2, cy, cellHeight * 0.9, [...base, Math.round(50 * strength)], 1);
  } else if (style === "underline") {
    addRadialGlow(fb, w, anchorX + cellWidth / 2, anchorY + cellHeight - 2, cellHeight * 0.7, [...base, Math.round(60 * strength)], 1);
  }
  const core = mixRgb(base, [255, 255, 255], 0.55 + t * 0.35);
  if (style === "underline") {
    const uh = Math.max(2, Math.round(cellHeight * 0.1));
    fillPaths(fb, w, h, [[anchorX, anchorY + cellHeight - uh, anchorX + cellWidth, anchorY + cellHeight - uh, anchorX + cellWidth, anchorY + cellHeight, anchorX, anchorY + cellHeight]], ...core, 255);
  } else if (style !== "block") {
    const beamW = Math.max(2, Math.round(cellWidth * (0.18 + t * 0.06)));
    const top = Math.round(anchorY + cellHeight * 0.06); const bottom = Math.round(anchorY + cellHeight * 0.94);
    const bx = Math.round(cx - beamW / 2);
    fillPaths(fb, w, h, [[bx, top + beamW / 2, bx + beamW, top + beamW / 2, bx + beamW, bottom - beamW / 2, bx, bottom - beamW / 2]], ...core, 255);
    fillPaths(fb, w, h, [strokeArcPath(bx + beamW / 2, top + beamW / 2, beamW / 4, Math.PI, Math.PI * 2, beamW / 2)], ...core, 255);
    fillPaths(fb, w, h, [strokeArcPath(bx + beamW / 2, bottom - beamW / 2, beamW / 4, 0, Math.PI, beamW / 2)], ...core, 255);
  }
  return { rgba: fb, width: w, height: h, anchorX, anchorY };
}

/** Keystroke impulse: an expanding ring with sparks. frame in [0, frames). */
export function renderImpulse({ cellWidth, cellHeight, frame, frames = 6, colors, strength = 1, seed = 1 }) {
  const cols = 9; const rows = 5;
  const w = cols * cellWidth; const h = rows * cellHeight;
  const fb = Buffer.alloc(w * h * 4);
  const anchorX = Math.floor(cols / 2) * cellWidth; const anchorY = Math.floor(rows / 2) * cellHeight;
  const cx = anchorX + cellWidth * 0.15; const cy = anchorY + cellHeight / 2;
  const t = (frame + 1) / frames;
  const fade = (1 - t) ** 1.5;
  const radius = cellHeight * (0.4 + t * 1.6);
  const ring = colors.accent;
  const thickness = Math.max(1.5, cellWidth * 0.22 * (1 - t * 0.6));
  fillPaths(fb, w, h, [strokeArcPath(cx, cy, radius, 0, Math.PI * 2, thickness, 32)], ...mixRgb(ring, [255, 255, 255], 0.3), Math.round(200 * fade * strength));
  let rnd = seed * 9301 + 49297;
  const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
  for (let k = 0; k < 9; k += 1) {
    const angle = rand() * Math.PI * 2; const speed = 0.6 + rand() * 0.8;
    const d = radius * speed * 1.25;
    const px = cx + Math.cos(angle) * d * 1.6; const py = cy + Math.sin(angle) * d * 0.8;
    ellipseGlow(fb, w, h, px, py, cellWidth * 0.45, cellWidth * 0.45, mixRgb(colors.warm, [255, 255, 255], 0.5), 230 * fade * strength);
  }
  return { rgba: fb, width: w, height: h, anchorX, anchorY };
}

/**
 * Editor card glow ring. (left, top, width, height) is the card rect inside
 * an image padded by `margin` px. phase in [0,1) animates the state.
 */
export function renderEditorGlow({ width, height, margin, radius, state = "idle", phase = 0, heat = 0, colors, intensity = 1 }) {
  const w = Math.ceil(width + margin * 2); const h = Math.ceil(height + margin * 2);
  const fb = Buffer.alloc(w * h * 4);
  const cx = w / 2; const cy = h / 2;
  const hw = width / 2; const hh = height / 2;
  const r = Math.min(radius, hw, hh);
  const pulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
  let color = colors.accent; let level = 0.32; let travel = null; let ripple = 0;
  if (state === "typing") { color = heat > 0.5 ? mixRgb(colors.warm, [255, 240, 220], (heat - 0.5) * 2) : mixRgb(colors.accent, colors.warm, heat * 2); level = 0.35 + heat * 0.55; }
  else if (state === "thinking") { color = colors.thinking; level = 0.3 + pulse * 0.35; travel = { at: phase, span: 0.08, gain: 0.6 }; }
  else if (state === "working") { color = mixRgb(colors.accent, [255, 255, 255], 0.15); level = 0.36; travel = { at: phase, span: 0.14, gain: 1.4 }; }
  else if (state === "speaking") { color = colors.speech; ripple = Math.abs(Math.sin(phase * Math.PI * 6)) * 0.5 + Math.abs(Math.sin(phase * Math.PI * 14 + 1)) * 0.5; level = 0.3 + ripple * 0.6; }
  else { level = 0.22 + pulse * 0.1; }
  level *= Math.max(0, Number(intensity) || 0);
  const reach = margin * (state === "speaking" ? 0.6 + ripple * 0.4 : 0.85);
  const perimeterParam = (x, y) => (Math.atan2((y - cy) / Math.max(1, hh), (x - cx) / Math.max(1, hw)) / (Math.PI * 2) + 1) % 1;
  for (let y = 0; y < h; y += 1) {
    const py = Math.abs(y + 0.5 - cy) - hh + r;
    for (let x = 0; x < w; x += 1) {
      const px = Math.abs(x + 0.5 - cx) - hw + r;
      const outside = Math.hypot(Math.max(px, 0), Math.max(py, 0)) + Math.min(Math.max(px, py), 0) - r;
      if (outside < -2 || outside > reach) continue;
      let a = outside <= 0 ? 0.85 : Math.exp(-(outside / reach) * 3.5);
      if (travel) {
        let dist = Math.abs(perimeterParam(x + 0.5, y + 0.5) - travel.at);
        dist = Math.min(dist, 1 - dist);
        a *= 1 + travel.gain * Math.max(0, 1 - dist / travel.span);
      }
      blendPixel(fb, (y * w + x) * 4, color[0], color[1], color[2], Math.round(255 * clamp01(a * level)));
    }
  }
  return { rgba: fb, width: w, height: h };
}

/**
 * Background frame (low resolution; the terminal scales it with c/r). Edges
 * converge exactly to `edge` so the canvas blends into terminal padding whose
 * colour is set to the same value (OSC 11).
 */
export function renderBackground({ width, height, frame = 0, frames = 1, colors, animated = false }) {
  const fb = Buffer.alloc(width * height * 4);
  const { top, bottom, edge, accent, accent2 } = colors;
  const t = frames > 1 ? frame / frames : 0;
  const glows = animated
    ? [
      { x: 0.18 + 0.12 * Math.sin(t * Math.PI * 2), y: 0.12 + 0.06 * Math.cos(t * Math.PI * 2), r: 0.62, c: accent, a: 0.16 },
      { x: 0.84 + 0.08 * Math.cos(t * Math.PI * 2 + 1), y: 0.9 + 0.05 * Math.sin(t * Math.PI * 2 + 1), r: 0.7, c: accent2, a: 0.14 },
      { x: 0.55 + 0.2 * Math.sin(t * Math.PI * 4 + 2), y: 0.45 + 0.1 * Math.cos(t * Math.PI * 2 + 2), r: 0.5, c: mixRgb(accent, accent2, 0.5), a: 0.07 },
    ]
    : [
      { x: 0.12, y: 0.08, r: 0.6, c: accent, a: 0.13 },
      { x: 0.92, y: 0.95, r: 0.65, c: accent2, a: 0.12 },
    ];
  const edgeBand = Math.max(2, Math.min(width, height) * 0.14);
  for (let y = 0; y < height; y += 1) {
    const vy = y / Math.max(1, height - 1);
    let row = mixRgb(top, bottom, vy);
    for (let x = 0; x < width; x += 1) {
      const vx = x / Math.max(1, width - 1);
      let c = row;
      for (const g of glows) {
        const dx = (vx - g.x) * (width / height); const dy = vy - g.y;
        const d = Math.hypot(dx, dy) / g.r;
        if (d < 1) c = mixRgb(c, g.c, g.a * (1 - d) * (1 - d));
      }
      // Converge to the edge colour AND fade alpha to 0 at the border: the
      // terminal background (set to `edge` with OSC 11) shows through, so the
      // canvas meets the window padding without a seam even after the
      // terminal's bilinear upscale of this low-resolution frame.
      const e = Math.min(x, width - 1 - x, y, height - 1 - y) / edgeBand;
      let alpha = 255;
      if (e < 1) {
        const k = e * e * (3 - 2 * e);
        c = mixRgb(edge, c, k);
        alpha = Math.round(255 * Math.min(1, k * 1.15));
      }
      const o = (y * width + x) * 4;
      fb[o] = c[0]; fb[o + 1] = c[1]; fb[o + 2] = c[2]; fb[o + 3] = alpha;
    }
  }
  return { rgba: fb, width, height };
}
