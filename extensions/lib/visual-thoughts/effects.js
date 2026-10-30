// Visual thoughts: transitions between two prepared rasters of one size.
//
// Each effect maps progress t (0..1, already eased) to a frame. Rasters are straight-alpha RGBA
// (Uint8Array); blending is premultiplied, so letterboxed and feathered images fade correctly.
// Per-transition maps (distances, noise) are computed once in the plan; each frame then costs a
// pass over the pixels, bilinear only where the effect displaces them. All randomness comes from
// the transition's seed, so a transition renders the same frames on any thread.

export const EFFECTS = Object.freeze(["fade", "ripple", "wave", "dissolve", "bloom", "drift"]);

/** A small seeded generator (mulberry32). */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Smooth value noise in [0,1] at `width`×`height`, `cells` lattice cells across the shorter side. */
export function valueNoise(width, height, random, cells = 6, octaves = 3) {
  const out = new Float32Array(width * height);
  let amplitude = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const scale = (cells * 2 ** octave) / Math.min(width, height);
    const gw = Math.ceil(width * scale) + 2;
    const gh = Math.ceil(height * scale) + 2;
    const grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i += 1) grid[i] = random();
    for (let y = 0; y < height; y += 1) {
      const fy = y * scale; const iy = fy | 0; const ty = fy - iy; const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < width; x += 1) {
        const fx = x * scale; const ix = fx | 0; const tx = fx - ix; const sx = tx * tx * (3 - 2 * tx);
        const a = grid[iy * gw + ix]; const b = grid[iy * gw + ix + 1];
        const c = grid[(iy + 1) * gw + ix]; const d = grid[(iy + 1) * gw + ix + 1];
        out[y * width + x] += amplitude * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= total;
  return out;
}

/**
 * A transition's fixed parameters, drawn from its seed: the effect (a named one, or any but a
 * plain fade for `random`), a centre, phases, and per-pixel maps.
 */
export function planTransition({ width, height, effect = "random", seed = 1 }) {
  const random = seeded(seed);
  const name = EFFECTS.includes(effect) ? effect : EFFECTS[1 + Math.floor(random() * (EFFECTS.length - 1))];
  const plan = {
    effect: name,
    width,
    height,
    cx: width * (0.25 + 0.5 * random()),
    cy: height * (0.25 + 0.5 * random()),
    phase: random() * Math.PI * 2,
    angle: random() * Math.PI * 2,
  };
  if (name === "dissolve" || name === "bloom") plan.noise = valueNoise(width, height, random, name === "bloom" ? 3 : 5, 3);
  if (name === "ripple") {
    const n = width * height;
    plan.dist = new Float32Array(n);
    plan.ux = new Float32Array(n);
    plan.uy = new Float32Array(n);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const dx = x - plan.cx; const dy = y - plan.cy;
        const d = Math.hypot(dx, dy) || 1;
        plan.dist[i] = d; plan.ux[i] = dx / d; plan.uy[i] = dy / d;
      }
    }
  }
  return plan;
}

// ── resampling into premultiplied float buffers ─────────────────────────────
// Rows and columns are resampled separately: an affine zoom/shift needs only a source position
// per column and per row, and the wave only a shift per row then per column.

/** Premultiply `src` (straight RGBA) into `dst` (Float32, 4 per pixel). */
function premultiply(src, dst) {
  for (let o = 0; o < src.length; o += 4) {
    const a = src[o + 3];
    dst[o] = src[o] * a; dst[o + 1] = src[o + 1] * a; dst[o + 2] = src[o + 2] * a; dst[o + 3] = a * 255;
  }
}

/** Sample premultiplied `src` at source x `xs[x]` per column and source y `ys[y]` per row. */
function resampleAffine(src, width, height, xs, ys, dst, scratch) {
  const ix = scratch.ix; const wx = scratch.wx;
  for (let x = 0; x < width; x += 1) {
    let v = xs[x];
    if (v < 0) v = 0; else if (v > width - 1.001) v = width - 1.001;
    ix[x] = v | 0; wx[x] = v - (v | 0);
  }
  for (let y = 0; y < height; y += 1) {
    let v = ys[y];
    if (v < 0) v = 0; else if (v > height - 1.001) v = height - 1.001;
    const iy = v | 0; const fy = v - iy;
    const r0 = iy * width * 4; const r1 = r0 + width * 4;
    let o = y * width * 4;
    for (let x = 0; x < width; x += 1, o += 4) {
      const p0 = r0 + ix[x] * 4; const p1 = r1 + ix[x] * 4;
      const fx = wx[x];
      const w00 = (1 - fx) * (1 - fy); const w10 = fx * (1 - fy); const w01 = (1 - fx) * fy; const w11 = fx * fy;
      dst[o] = src[p0] * w00 + src[p0 + 4] * w10 + src[p1] * w01 + src[p1 + 4] * w11;
      dst[o + 1] = src[p0 + 1] * w00 + src[p0 + 5] * w10 + src[p1 + 1] * w01 + src[p1 + 5] * w11;
      dst[o + 2] = src[p0 + 2] * w00 + src[p0 + 6] * w10 + src[p1 + 2] * w01 + src[p1 + 6] * w11;
      dst[o + 3] = src[p0 + 3] * w00 + src[p0 + 7] * w10 + src[p1 + 3] * w01 + src[p1 + 7] * w11;
    }
  }
}

/** Shift each row of `src` by `rows[y]` pixels (into `mid`), then each column by `cols[x]` (into `dst`). */
function resampleWave(src, width, height, rows, cols, mid, dst) {
  for (let y = 0; y < height; y += 1) {
    const shift = rows[y];
    const base = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      let v = x + shift;
      if (v < 0) v = 0; else if (v > width - 1.001) v = width - 1.001;
      const i0 = v | 0; const f = v - i0;
      const p = base + i0 * 4; const o = base + x * 4;
      mid[o] = src[p] + (src[p + 4] - src[p]) * f;
      mid[o + 1] = src[p + 1] + (src[p + 5] - src[p + 1]) * f;
      mid[o + 2] = src[p + 2] + (src[p + 6] - src[p + 2]) * f;
      mid[o + 3] = src[p + 3] + (src[p + 7] - src[p + 3]) * f;
    }
  }
  const stride = width * 4;
  for (let x = 0; x < width; x += 1) {
    const shift = cols[x];
    for (let y = 0; y < height; y += 1) {
      let v = y + shift;
      if (v < 0) v = 0; else if (v > height - 1.001) v = height - 1.001;
      const i0 = v | 0; const f = v - i0;
      const p = i0 * stride + x * 4; const q = p + stride; const o = y * stride + x * 4;
      dst[o] = mid[p] + (mid[q] - mid[p]) * f;
      dst[o + 1] = mid[p + 1] + (mid[q + 1] - mid[p + 1]) * f;
      dst[o + 2] = mid[p + 2] + (mid[q + 2] - mid[p + 2]) * f;
      dst[o + 3] = mid[p + 3] + (mid[q + 3] - mid[p + 3]) * f;
    }
  }
}

/** Radial displacement (ripple) of premultiplied `src` by `amount[i]` along (ux, uy), where nonzero. */
function resampleRadial(src, width, height, plan, amount, dst) {
  dst.set(src);
  for (let i = 0; i < amount.length; i += 1) {
    const d = amount[i];
    if (d === 0) continue;
    const y = (i / width) | 0; const x = i - y * width;
    let sx = x + plan.ux[i] * d; let sy = y + plan.uy[i] * d;
    if (sx < 0) sx = 0; else if (sx > width - 1.001) sx = width - 1.001;
    if (sy < 0) sy = 0; else if (sy > height - 1.001) sy = height - 1.001;
    const ix = sx | 0; const iy = sy | 0; const fx = sx - ix; const fy = sy - iy;
    const p0 = (iy * width + ix) * 4; const p1 = p0 + width * 4;
    const w00 = (1 - fx) * (1 - fy); const w10 = fx * (1 - fy); const w01 = (1 - fx) * fy; const w11 = fx * fy;
    const o = i * 4;
    for (let c = 0; c < 4; c += 1) dst[o + c] = src[p0 + c] * w00 + src[p0 + 4 + c] * w10 + src[p1 + c] * w01 + src[p1 + 4 + c] * w11;
  }
}

// ── mixing ───────────────────────────────────────────────────────────────────
// Separate monomorphic loops (one per way the mix varies): JavaScriptCore (Bun, which runs TUI
// Pi) deoptimizes one shared loop that sees every effect's branches, by 10× and more.

function store(out, o, r, g, b, alpha) {
  if (alpha <= 128) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; return; }
  out[o] = (r * 255) / alpha; out[o + 1] = (g * 255) / alpha; out[o + 2] = (b * 255) / alpha; out[o + 3] = alpha / 255;
}

function mixUniform(pa, pb, m, out) {
  const j = 1 - m;
  for (let o = 0; o < out.length; o += 4) {
    store(out, o, pa[o] * j + pb[o] * m, pa[o + 1] * j + pb[o + 1] * m, pa[o + 2] * j + pb[o + 2] * m, pa[o + 3] * j + pb[o + 3] * m);
  }
}

function mixRows(pa, pb, mixRow, width, out) {
  const stride = width * 4;
  for (let row = 0, base = 0; base < out.length; row += 1, base += stride) {
    const m = mixRow[row]; const j = 1 - m;
    for (let o = base; o < base + stride; o += 4) {
      store(out, o, pa[o] * j + pb[o] * m, pa[o + 1] * j + pb[o + 1] * m, pa[o + 2] * j + pb[o + 2] * m, pa[o + 3] * j + pb[o + 3] * m);
    }
  }
}

function mixPixels(pa, pb, mix, glow, out) {
  for (let i = 0, o = 0; o < out.length; i += 1, o += 4) {
    const m = mix[i]; const j = 1 - m;
    const alpha = pa[o + 3] * j + pb[o + 3] * m;
    if (alpha <= 128) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
    let r = ((pa[o] * j + pb[o] * m) * 255) / alpha;
    let g = ((pa[o + 1] * j + pb[o + 1] * m) * 255) / alpha;
    let b = ((pa[o + 2] * j + pb[o + 2] * m) * 255) / alpha;
    const lift = glow[i];
    if (lift > 0) { r += (255 - r) * lift; g += (255 - g) * lift; b += (255 - b) * lift; }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = alpha / 255;
  }
}

// ── effects ──────────────────────────────────────────────────────────────────

function frameFade(plan, A, B, s, t, out) {
  mixUniform(A, B, t, out);
}

function frameDrift(plan, A, B, s, t, out) {
  const { width, height } = plan;
  const shorter = Math.min(width, height);
  const zA = 1 - 0.05 * t; const zB = 1 / (1 + 0.05 * (1 - t));
  const shA = shorter * 0.02 * t; const shB = -shorter * 0.02 * (1 - t);
  const cos = Math.cos(plan.angle); const sin = Math.sin(plan.angle);
  for (let x = 0; x < width; x += 1) { s.xsA[x] = plan.cx + (x - plan.cx) * zA + cos * shA; s.xsB[x] = plan.cx + (x - plan.cx) * zB + cos * shB; }
  for (let y = 0; y < height; y += 1) { s.ysA[y] = plan.cy + (y - plan.cy) * zA + sin * shA; s.ysB[y] = plan.cy + (y - plan.cy) * zB + sin * shB; }
  resampleAffine(A, width, height, s.xsA, s.ysA, s.pa, s);
  resampleAffine(B, width, height, s.xsB, s.ysB, s.pb, s);
  mixUniform(s.pa, s.pb, t, out);
}

function frameBloom(plan, A, B, s, t, out) {
  const { width, height } = plan;
  const pulse = Math.sin(Math.PI * t);
  const z = 0.04 * pulse; const zA = 1 - z * t; const zB = 1 + z * (1 - t);
  for (let x = 0; x < width; x += 1) { s.xsA[x] = plan.cx + (x - plan.cx) * zA; s.xsB[x] = plan.cx + (x - plan.cx) * zB; }
  for (let y = 0; y < height; y += 1) { s.ysA[y] = plan.cy + (y - plan.cy) * zA; s.ysB[y] = plan.cy + (y - plan.cy) * zB; }
  resampleAffine(A, width, height, s.xsA, s.ysA, s.pa, s);
  resampleAffine(B, width, height, s.xsB, s.ysB, s.pb, s);
  const glowAll = pulse * pulse * 0.14;
  const noise = plan.noise; const mix = s.mix; const glow = s.glow;
  for (let i = 0; i < mix.length; i += 1) {
    const n = noise[i];
    mix[i] = smooth(0, 1, t + (n - 0.5) * 0.35 * pulse);
    glow[i] = glowAll * (0.6 + 0.4 * n);
  }
  mixPixels(s.pa, s.pb, mix, glow, out);
}

function frameWave(plan, A, B, s, t, out) {
  const { width, height } = plan;
  const shorter = Math.min(width, height);
  const pulse = Math.sin(Math.PI * t);
  const sway = pulse * shorter * 0.03;
  for (let y = 0; y < height; y += 1) {
    s.rows[y] = Math.sin((y / shorter) * 9 + plan.phase + t * 6) * sway; s.rowsB[y] = -s.rows[y] * 0.6;
    s.mixRow[y] = smooth(0.15, 0.85, t + 0.12 * Math.sin((y / shorter) * 4 + plan.phase));
  }
  for (let x = 0; x < width; x += 1) { s.cols[x] = Math.sin((x / shorter) * 5 + plan.phase * 0.7 - t * 4) * sway * 0.35; s.colsB[x] = -s.cols[x] * 0.6; }
  resampleWave(A, width, height, s.rows, s.cols, s.mid, s.pa);
  resampleWave(B, width, height, s.rowsB, s.colsB, s.mid, s.pb);
  mixRows(s.pa, s.pb, s.mixRow, width, out);
}

function frameRipple(plan, A, B, s, t, out) {
  const { width, height } = plan;
  const shorter = Math.min(width, height);
  const pulse = Math.sin(Math.PI * t);
  const front = t * (Math.hypot(width, height) + shorter * 0.3) - shorter * 0.15;
  const band = shorter * 0.18;
  const k = (12 / shorter) * Math.PI;
  const amp = shorter * 0.025 * pulse;
  const amount = s.amount; const mix = s.mix; const glow = s.glow; const dist = plan.dist;
  for (let i = 0; i < amount.length; i += 1) {
    const d = dist[i];
    const e = (d - front) / band;
    mix[i] = e <= -1 ? 1 : e >= 1 ? 0 : 1 - smooth(-1, 1, e);
    if (e > -3 && e < 3) {
      const near = Math.exp(-e * e);
      amount[i] = Math.sin((d - front) * k + plan.phase) * amp * near;
      glow[i] = near * pulse * 0.12;
    } else { amount[i] = 0; glow[i] = 0; }
  }
  resampleRadial(A, width, height, plan, amount, s.pa);
  resampleRadial(B, width, height, plan, amount, s.pb);
  mixPixels(s.pa, s.pb, mix, glow, out);
}

function frameDissolve(plan, A, B, s, t, out) {
  const pulse = Math.sin(Math.PI * t);
  const edge = 0.12;
  const front = t * (1 + 2 * edge) - edge;
  const noise = plan.noise; const mix = s.mix; const glow = s.glow;
  for (let i = 0; i < noise.length; i += 1) {
    const n = noise[i];
    mix[i] = smooth(n - edge, n + edge, front);
    const g = (front - n) / (edge * 0.6);
    glow[i] = g > -3 && g < 3 ? Math.exp(-g * g) * pulse * 0.12 : 0;
  }
  mixPixels(A, B, mix, glow, out);
}

const FRAMES = Object.freeze({ fade: frameFade, drift: frameDrift, bloom: frameBloom, wave: frameWave, ripple: frameRipple, dissolve: frameDissolve });

/**
 * Prepared state for rendering one transition's frames: the two rasters premultiplied once (a
 * missing `a` is transparent), and scratch buffers reused for every frame.
 */
export function createTransitionRenderer(plan, a, b) {
  const pixels = plan.width * plan.height;
  const n = pixels * 4;
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  if (a) premultiply(a.rgba, A);
  premultiply(b.rgba, B);
  // Every buffer a frame needs, allocated once: frames allocate nothing.
  const scratch = {
    pa: new Float32Array(n), pb: new Float32Array(n), mid: new Float32Array(n),
    amount: new Float32Array(pixels), mix: new Float32Array(pixels), glow: new Float32Array(pixels),
    xsA: new Float32Array(plan.width), xsB: new Float32Array(plan.width), ysA: new Float32Array(plan.height), ysB: new Float32Array(plan.height),
    rows: new Float32Array(plan.height), rowsB: new Float32Array(plan.height), cols: new Float32Array(plan.width), colsB: new Float32Array(plan.width),
    mixRow: new Float32Array(plan.height),
    ix: new Int32Array(plan.width), wx: new Float32Array(plan.width),
  };
  const draw = FRAMES[plan.effect] || frameFade;
  return {
    plan,
    /** Frame at `t` into `out` (straight RGBA, Uint8Array). */
    frame(t, out = new Uint8Array(n)) { draw(plan, A, B, scratch, t, out); return out; },
  };
}

/** One frame (convenience for tests and one-offs: prepares the rasters each call). */
export function renderTransition(plan, a, b, t, out) {
  return createTransitionRenderer(plan, a, b).frame(t, out);
}
