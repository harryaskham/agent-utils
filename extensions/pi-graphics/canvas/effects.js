// Pixel effects for the Pi canvas: caret styles with typing-heat bloom,
// keystroke impulses, editor-card glow states, and the animated background.
// Everything renders straight RGBA buffers; the canvas controller decides
// when to upload, cycle and place them.

import { addRadialGlow } from "../png-renderer.js";
import { fillPaths, strokeArcPath } from "./raster.js";

export const CARET_STYLES = Object.freeze(["bloom", "glow", "beam", "block", "underline"]);
export const EDITOR_STATES = Object.freeze(["idle", "typing", "thinking", "working", "speaking"]);
export const BACKGROUNDS = Object.freeze(["aurora", "nebula", "waves", "grid", "stars", "static", "transparent", "none"]);
export const STREAM_EFFECTS = Object.freeze(["float", "fade", "none"]);
export const TYPE_IN_EFFECTS = Object.freeze(["pop", "rise", "fade", "none"]);
/** Default render scale (1/N of the window's pixels) per background type. */
export const BACKGROUND_SCALE = Object.freeze({ aurora: 8, nebula: 10, waves: 8, grid: 4, stars: 3, static: 8 });

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
// Geometry of the glow band (alpha falloff + perimeter parameter per pixel)
// depends only on size/margin/radius: cache it so each animation frame is a
// single multiply over the band's pixels.
const glowGeometryCache = new Map();
function glowGeometry(width, height, margin, radius) {
  const key = `${width}x${height}:${margin}:${radius}`;
  let geo = glowGeometryCache.get(key);
  if (geo) return geo;
  const w = Math.ceil(width + margin * 2); const h = Math.ceil(height + margin * 2);
  const cx = w / 2; const cy = h / 2;
  const hw = width / 2; const hh = height / 2;
  const r = Math.min(radius, hw, hh);
  const reach = Math.max(1, margin * 0.85);
  const idx = []; const base = []; const param = [];
  for (let y = 0; y < h; y += 1) {
    const py = Math.abs(y + 0.5 - cy) - hh + r;
    for (let x = 0; x < w; x += 1) {
      const px = Math.abs(x + 0.5 - cx) - hw + r;
      const outside = Math.hypot(Math.max(px, 0), Math.max(py, 0)) + Math.min(Math.max(px, py), 0) - r;
      if (outside < -2 || outside > reach) continue;
      const a = outside <= 0 ? 0.85 : Math.exp(-(outside / reach) * 3.5);
      if (a < 0.004) continue;
      idx.push(y * w + x); base.push(a);
      param.push((Math.atan2((y + 0.5 - cy) / Math.max(1, hh), (x + 0.5 - cx) / Math.max(1, hw)) / (Math.PI * 2) + 1) % 1);
    }
  }
  geo = { w, h, idx: Int32Array.from(idx), base: Float32Array.from(base), param: Float32Array.from(param) };
  glowGeometryCache.set(key, geo);
  while (glowGeometryCache.size > 4) glowGeometryCache.delete(glowGeometryCache.keys().next().value);
  return geo;
}

export function renderEditorGlow({ width, height, margin, radius, state = "idle", phase = 0, heat = 0, colors, intensity = 1 }) {
  const geo = glowGeometry(width, height, margin, radius);
  const { w, h } = geo;
  const fb = Buffer.alloc(w * h * 4);
  const pulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
  let color = colors.accent; let level = 0.32; let travel = null; let ripple = null;
  if (state === "typing") { color = heat > 0.5 ? mixRgb(colors.warm, [255, 240, 220], (heat - 0.5) * 2) : mixRgb(colors.accent, colors.warm, heat * 2); level = 0.35 + heat * 0.55; }
  else if (state === "thinking") { color = colors.thinking; level = 0.3 + pulse * 0.35; travel = { at: phase, span: 0.08, gain: 0.6 }; }
  else if (state === "working") { color = mixRgb(colors.accent, [255, 255, 255], 0.15); level = 0.36; travel = { at: phase, span: 0.14, gain: 1.4 }; }
  else if (state === "flare") { color = mixRgb(colors.accent, [255, 255, 255], 0.35); level = 0.55; }
  else if (state === "speaking") {
    color = colors.speech;
    const amp = Math.abs(Math.sin(phase * Math.PI * 6)) * 0.5 + Math.abs(Math.sin(phase * Math.PI * 14 + 1)) * 0.5;
    level = 0.3 + amp * 0.6;
    ripple = { phase, amp }; // waves travelling round the border
  } else { level = 0.22 + pulse * 0.1; }
  level *= Math.max(0, Number(intensity) || 0);
  const [cr, cg, cb] = color;
  const n = geo.idx.length;
  for (let k = 0; k < n; k += 1) {
    let a = geo.base[k];
    if (travel) {
      let dist = Math.abs(geo.param[k] - travel.at);
      if (dist > 0.5) dist = 1 - dist;
      if (dist < travel.span) a *= 1 + travel.gain * (1 - dist / travel.span);
    } else if (ripple) {
      a *= 0.7 + 0.3 * Math.sin((geo.param[k] * 8 - ripple.phase * 6) * Math.PI * 2);
    }
    const alpha = a * level;
    if (alpha < 0.004) continue;
    const o = geo.idx[k] * 4;
    fb[o] = cr; fb[o + 1] = cg; fb[o + 2] = cb; fb[o + 3] = Math.round(255 * Math.min(1, alpha));
  }
  return { rgba: fb, width: w, height: h };
}

const TAU = Math.PI * 2;

/** Edge factor: 0 at the image border → 1 inside the band (smoothstep). */
function edgeFactor(x, y, width, height, band) {
  const e = Math.min(x, width - 1 - x, y, height - 1 - y) / band;
  return e >= 1 ? 1 : e * e * (3 - 2 * e);
}

// Animated patterns. Every time term uses an integer multiple of TAU·t, so
// frame N == frame 0: a ring of frames loops seamlessly and the terminal can
// keep the whole period cached. Each pattern mixes into an RGB float buffer
// that already holds the static base; per-column/row terms are hoisted out of
// the pixel loop and nothing allocates per pixel.
function mixInto(rgb, i, r, g, b, a) {
  rgb[i] += (r - rgb[i]) * a; rgb[i + 1] += (g - rgb[i + 1]) * a; rgb[i + 2] += (b - rgb[i + 2]) * a;
}

const PATTERNS = {
  aurora(rgb, w, h, t, c, edge) {
    const tones = [c.accent, c.speech || c.accent2, c.accent2];
    const cols = [0, 1, 2].map(() => ({ center: new Float32Array(w), gain: new Float32Array(w) }));
    for (let x = 0; x < w; x += 1) {
      const vx = x / Math.max(1, w - 1);
      for (let k = 0; k < 3; k += 1) {
        cols[k].center[x] = 0.16 + k * 0.12
          + 0.07 * Math.sin(TAU * (vx * (1.1 + k * 0.37) + t * (k + 1)) + k)
          + 0.025 * Math.sin(TAU * (vx * (3.3 + k) - t * 2) + k * 1.7);
        const rays = 0.78 + 0.22 * Math.sin(TAU * (vx * (9 + k * 3) + t * (k % 2 ? 1 : -1)) + k) * Math.sin(TAU * (vx * 2.3 - t) + k);
        const sway = 0.55 + 0.45 * Math.sin(TAU * (vx * 0.7 + t * (k === 1 ? -1 : 1)) + k * 2.1);
        cols[k].gain[x] = rays * sway * (k === 1 ? 0.8 : 1);
      }
    }
    const up = [0.2, 0.23, 0.26].map((v) => 1 / (v * v)); const hem = 1 / (0.03 * 0.03);
    for (let y = 0; y < h; y += 1) {
      const vy = y / Math.max(1, h - 1);
      if (vy > 0.62) continue; // curtains live in the upper part of the window
      for (let x = 0; x < w; x += 1) {
        let r = 0; let g = 0; let b = 0; let a = 0;
        for (let k = 0; k < 3; k += 1) {
          const d = vy - cols[k].center[x];
          const sv = Math.exp(-d * d * (d < 0 ? up[k] : hem)) * cols[k].gain[x];
          if (sv < 0.003) continue;
          r += tones[k][0] * sv; g += tones[k][1] * sv; b += tones[k][2] * sv; a += sv;
        }
        if (a <= 0.003) continue;
        const i = (y * w + x) * 3;
        mixInto(rgb, i, r / a, g / a, b / a, Math.min(1, a) * 0.3 * edge[y * w + x]);
      }
    }
  },
  nebula(rgb, w, h, t, c, edge) {
    const aspect = w / Math.max(1, h);
    const blobs = [
      [0.25 + 0.12 * Math.sin(TAU * t), 0.3 + 0.1 * Math.cos(TAU * t), 0.42, c.accent],
      [0.75 + 0.1 * Math.cos(TAU * t * 2 + 1), 0.65 + 0.12 * Math.sin(TAU * t + 2), 0.5, c.accent2],
      [0.5 + 0.25 * Math.sin(TAU * t + 3), 0.5 + 0.2 * Math.sin(TAU * t * 2), 0.35, c.thinking || c.accent2],
      [0.15 + 0.08 * Math.cos(TAU * t * 3), 0.85 + 0.05 * Math.sin(TAU * t), 0.3, c.speech || c.accent],
    ];
    for (let y = 0; y < h; y += 1) {
      const vy = y / Math.max(1, h - 1);
      for (let x = 0; x < w; x += 1) {
        const vx = x / Math.max(1, w - 1);
        let r = 0; let g = 0; let b = 0; let a = 0;
        for (const [bx, by, br, col] of blobs) {
          const dx = (vx - bx) * aspect; const dy = vy - by;
          const d2 = (dx * dx + dy * dy) / (br * br);
          if (d2 >= 1) continue;
          const d = Math.sqrt(d2);
          const sv = (1 - d) * (1 - d) * (0.75 + 0.25 * Math.sin(TAU * (vx * 3 + vy * 2 + t) + bx * 9));
          r += col[0] * sv; g += col[1] * sv; b += col[2] * sv; a += sv;
        }
        if (a <= 0.003) continue;
        mixInto(rgb, (y * w + x) * 3, r / a, g / a, b / a, Math.min(1, a) * 0.22 * edge[y * w + x]);
      }
    }
  },
  waves(rgb, w, h, t, c, edge) {
    const bands = [0, 1, 2, 3].map((k) => ({ y0: new Float32Array(w), col: mixRgb(c.accent, c.accent2, k / 3), sharp: 1 / (0.012 + k * 0.004) ** 2, gain: 0.9 - k * 0.15 }));
    for (let x = 0; x < w; x += 1) {
      const vx = x / Math.max(1, w - 1);
      bands.forEach((band, k) => { band.y0[x] = 0.55 + k * 0.11 + 0.035 * Math.sin(TAU * (vx * (1.2 + k * 0.5) - t * (k + 1)) + k); });
    }
    const soft = 1 / (0.08 * 0.08);
    for (let y = Math.floor(h * 0.4); y < h; y += 1) {
      const vy = y / Math.max(1, h - 1);
      for (let x = 0; x < w; x += 1) {
        let r = 0; let g = 0; let b = 0; let a = 0;
        for (const band of bands) {
          const d = vy - band.y0[x]; const d2 = d * d;
          const sv = Math.exp(-d2 * band.sharp) * band.gain + Math.exp(-d2 * soft) * 0.12;
          if (sv < 0.003) continue;
          r += band.col[0] * sv; g += band.col[1] * sv; b += band.col[2] * sv; a += sv;
        }
        if (a <= 0.003) continue;
        mixInto(rgb, (y * w + x) * 3, r / a, g / a, b / a, Math.min(1, a) * 0.3 * edge[y * w + x]);
      }
    }
  },
  grid(rgb, w, h, t, c, edge) {
    // Perspective floor below a horizon, scrolling toward the viewer (one
    // grid spacing per loop, so the loop is seamless). Line widths are in
    // screen pixels and fade where lines get denser than a few pixels.
    const horizon = 0.42; const lanes = 6;
    for (let y = 0; y < h; y += 1) {
      const vy = y / Math.max(1, h - 1);
      if (vy <= horizon) {
        const glow = Math.exp(-(((horizon - vy) / 0.08) ** 2)) * 0.2;
        if (glow > 0.004) for (let x = 0; x < w; x += 1) mixInto(rgb, (y * w + x) * 3, ...c.accent2, glow * edge[y * w + x]);
        continue;
      }
      const dy = vy - horizon;
      const depth = 0.12 / dy;
      const z = depth + t;
      // Horizontal lines: distance in z → pixels via |dz/dy| (per pixel row).
      const dzdpx = (0.12 / (dy * dy)) / Math.max(1, h - 1);
      const lineZpx = Math.abs(z - Math.round(z)) / dzdpx;
      const sz = Math.exp(-((lineZpx / 0.9) ** 2)) * Math.min(1, 1 / (dzdpx * 6));
      // Vertical lanes: xw = (vx - 0.5)·depth·lanes → pixel spacing = 1/(depth·lanes/w).
      const pxPerLane = Math.max(1, w - 1) / (depth * lanes);
      const laneFade = Math.min(1, Math.max(0, (pxPerLane - 3) / 6));
      const fade = Math.min(1, dy * 3) * 0.3;
      const col = mixRgb(c.accent, c.accent2, Math.min(1, depth));
      for (let x = 0; x < w; x += 1) {
        const xw = ((x / Math.max(1, w - 1)) - 0.5) * depth * lanes;
        const lineXpx = Math.abs(xw - Math.round(xw)) * pxPerLane;
        const sv = Math.max(sz, Math.exp(-((lineXpx / 0.8) ** 2)) * laneFade) * fade;
        if (sv > 0.004) mixInto(rgb, (y * w + x) * 3, col[0], col[1], col[2], sv * edge[y * w + x]);
      }
    }
  },
  stars(rgb, w, h, t, c, edge, base) {
    // Sparse deterministic star positions cached with the base layer.
    if (!base.stars) {
      base.stars = [];
      for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
        let hsh = (x * 374761393 + y * 668265263) >>> 0;
        hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177) >>> 0;
        const v = (hsh & 0xffff) / 0xffff;
        if (v >= 0.985) base.stars.push({ i: y * w + x, phase: ((hsh >>> 16) & 0xff) / 255, speed: 1 + ((hsh >>> 24) & 3), bright: (v - 0.985) / 0.015, tone: (hsh >>> 8) & 1 ? c.accent : [235, 240, 248] });
      }
    }
    for (const star of base.stars) {
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(TAU * (t * star.speed + star.phase)));
      mixInto(rgb, star.i * 3, ...star.tone, tw * star.bright * 0.9 * edge[star.i]);
    }
  },
};

// Static base (vertical gradient + corner glows) and edge factors, cached per
// size/theme: only the animated pattern is recomputed per frame.
const baseCache = new Map();
function backgroundBase(width, height, colors, patterned) {
  const key = `${width}x${height}:${patterned ? 1 : 0}:${colors.top}:${colors.bottom}:${colors.edge}:${colors.accent}:${colors.accent2}`;
  let base = baseCache.get(key);
  if (base) return base;
  const { top, bottom, accent, accent2 } = colors;
  const aspect = width / Math.max(1, height);
  const glows = [
    { x: 0.12, y: 0.08, r: 0.6, c: accent, a: patterned ? 0.07 : 0.13 },
    { x: 0.92, y: 0.95, r: 0.65, c: accent2, a: patterned ? 0.06 : 0.12 },
  ];
  const rgb = new Float32Array(width * height * 3);
  const edge = new Float32Array(width * height);
  const band = Math.max(2, Math.min(width, height) * 0.14);
  for (let y = 0; y < height; y += 1) {
    const vy = y / Math.max(1, height - 1);
    const row = mixRgb(top, bottom, vy);
    for (let x = 0; x < width; x += 1) {
      const vx = x / Math.max(1, width - 1);
      const i = (y * width + x) * 3;
      rgb[i] = row[0]; rgb[i + 1] = row[1]; rgb[i + 2] = row[2];
      for (const g of glows) {
        const d = Math.hypot((vx - g.x) * aspect, vy - g.y) / g.r;
        if (d < 1) mixInto(rgb, i, g.c[0], g.c[1], g.c[2], g.a * (1 - d) * (1 - d));
      }
      edge[y * width + x] = edgeFactor(x, y, width, height, band);
    }
  }
  base = { rgb, edge, stars: null };
  baseCache.set(key, base);
  while (baseCache.size > 3) baseCache.delete(baseCache.keys().next().value);
  return base;
}

/**
 * Background frame (low resolution; the terminal upscales it smoothly).
 * type: aurora | nebula | waves | grid | stars | static. phase ∈ [0, 1).
 * Edges converge to `colors.edge` with alpha → 0 so the terminal padding
 * (set to the same colour with OSC 11) shows through without a seam.
 */
export function renderBackground({ width, height, type = "aurora", phase = 0, frame, frames, colors, animated }) {
  if (frame !== undefined && frames) phase = frame / frames; // legacy callers
  if (animated === false && type === "aurora") type = "static";
  const pattern = PATTERNS[type] || null;
  const base = backgroundBase(width, height, colors, Boolean(pattern));
  const rgb = Float32Array.from(base.rgb);
  const t = ((phase % 1) + 1) % 1;
  if (pattern) pattern(rgb, width, height, t, colors, base.edge, base);
  const fb = Buffer.alloc(width * height * 4);
  const [er, eg, eb] = colors.edge;
  for (let p = 0, i = 0, o = 0; p < width * height; p += 1, i += 3, o += 4) {
    const k = base.edge[p];
    if (k < 1) {
      fb[o] = Math.round(er + (rgb[i] - er) * k); fb[o + 1] = Math.round(eg + (rgb[i + 1] - eg) * k); fb[o + 2] = Math.round(eb + (rgb[i + 2] - eb) * k);
      fb[o + 3] = Math.round(255 * Math.min(1, k * 1.15));
    } else {
      fb[o] = Math.round(rgb[i]); fb[o + 1] = Math.round(rgb[i + 1]); fb[o + 2] = Math.round(rgb[i + 2]); fb[o + 3] = 255;
    }
  }
  return { rgba: fb, width, height };
}

/**
 * Activity tint layered above the background: a soft wash rising from the
 * editor (bottom) in the activity colour. level ∈ [0, 1].
 */
export function renderActivityTint({ width, height, color, level = 1, anchorY = 0.86 }) {
  const fb = Buffer.alloc(width * height * 4);
  const edgeBand = Math.max(2, Math.min(width, height) * 0.14);
  const aspect = width / Math.max(1, height);
  for (let y = 0; y < height; y += 1) {
    const vy = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const vx = x / Math.max(1, width - 1);
      // Light rising from the editor: strongest just above it, a whisper of
      // colour across the rest of the window.
      const d = Math.hypot((vx - 0.5) * aspect * 0.4, (vy - anchorY) * 1.6);
      const s = Math.exp(-((d / 0.42) ** 2)) * 0.13 + 0.018;
      const a = s * level * edgeFactor(x, y, width, height, edgeBand);
      if (a < 0.004) continue;
      const o = (y * width + x) * 4;
      fb[o] = color[0]; fb[o + 1] = color[1]; fb[o + 2] = color[2]; fb[o + 3] = Math.round(255 * Math.min(1, a));
    }
  }
  return { rgba: fb, width, height };
}
