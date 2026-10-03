// Anti-aliased coverage rasterizer (signed-area accumulation, non-zero fill)
// plus the small set of vector primitives the Pi canvas needs.
//
// Polylines are closed loops of [x0, y0, x1, y1, ...] in pixel space. The
// accumulation approach computes exact per-pixel area coverage for each edge
// and a single prefix sum resolves the fill, which is fast for glyph-sized
// and row-sized shapes and needs no sorting or edge lists.

export function rasterizePolylines(polylines, width, height) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const stride = w + 2;
  const acc = new Float32Array(stride * h + 2);
  const line = (x0, y0, x1, y1) => {
    if (y0 === y1) return;
    let dir = 1;
    if (y0 > y1) { dir = -1; [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
    if (y1 <= 0 || y0 >= h) return;
    const dxdy = (x1 - x0) / (y1 - y0);
    // Clip vertically.
    if (y0 < 0) { x0 -= y0 * dxdy; y0 = 0; }
    if (y1 > h) { y1 = h; }
    let x = x0;
    const yStart = Math.floor(y0);
    const yEnd = Math.min(h, Math.ceil(y1));
    for (let y = yStart; y < yEnd; y += 1) {
      const lineStart = y * stride;
      const dy = Math.min(y + 1, y1) - Math.max(y, y0);
      const xNext = x + dxdy * dy;
      const d = dy * dir;
      let xa = Math.min(x, xNext);
      let xb = Math.max(x, xNext);
      if (xa < 0) xa = 0;
      if (xb < 0) xb = 0;
      if (xa > w) xa = w;
      if (xb > w) xb = w;
      const xaFloor = Math.floor(xa);
      const xai = xaFloor;
      const xbCeil = Math.ceil(xb);
      const xbi = xbCeil;
      if (xbi <= xai + 1) {
        const xmf = 0.5 * (x + xNext) - xaFloor;
        acc[lineStart + xai] += d - d * xmf;
        acc[lineStart + xai + 1] += d * xmf;
      } else {
        const s = 1 / (xb - xa);
        const x0f = xa - xaFloor;
        const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
        const x1f = xb - xbCeil + 1;
        const am = 0.5 * s * x1f * x1f;
        acc[lineStart + xai] += d * a0;
        if (xbi === xai + 2) {
          acc[lineStart + xai + 1] += d * (1 - a0 - am);
        } else {
          const a1 = s * (1.5 - x0f);
          acc[lineStart + xai + 1] += d * (a1 - a0);
          for (let xi = xai + 2; xi < xbi - 1; xi += 1) acc[lineStart + xi] += d * s;
          const a2 = a1 + (xbi - xai - 3) * s;
          acc[lineStart + xbi - 1] += d * (1 - a2 - am);
        }
        acc[lineStart + xbi] += d * am;
      }
      x = xNext;
    }
  };
  for (const poly of polylines) {
    const n = poly.length;
    if (n < 6) continue;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      line(poly[i], poly[i + 1], poly[j], poly[j + 1]);
    }
  }
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    let sum = 0;
    const row = y * stride;
    for (let x = 0; x < w; x += 1) {
      sum += acc[row + x];
      const a = Math.abs(sum);
      alpha[y * w + x] = a >= 1 ? 255 : Math.round(a * 255);
    }
  }
  return { alpha, width: w, height: h };
}

/** Rounded rectangle outline as a closed polyline (radius clamped). */
export function roundedRectPath(x, y, w, h, radius, segments = 6) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r <= 0.01) return [x, y, x + w, y, x + w, y + h, x, y + h];
  const pts = [];
  const corner = (cx, cy, start) => {
    for (let i = 0; i <= segments; i += 1) {
      const a = start + (i / segments) * (Math.PI / 2);
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return pts;
}

/** Rounded rectangle with independently rounded corners [tl, tr, br, bl]. */
export function roundedRectPathCorners(x, y, w, h, radii, segments = 6) {
  const clamp = (r) => Math.max(0, Math.min(r || 0, w / 2, h / 2));
  const [tl, tr, br, bl] = radii.map(clamp);
  const pts = [];
  const corner = (cx, cy, r, start, px, py) => {
    if (r <= 0.01) { pts.push(px, py); return; }
    for (let i = 0; i <= segments; i += 1) {
      const a = start + (i / segments) * (Math.PI / 2);
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  corner(x + w - tr, y + tr, tr, -Math.PI / 2, x + w, y);
  corner(x + w - br, y + h - br, br, 0, x + w, y + h);
  corner(x + bl, y + h - bl, bl, Math.PI / 2, x, y + h);
  corner(x + tl, y + tl, tl, Math.PI, x, y);
  return pts;
}

/** Filled circle polygon. */
export function circlePath(cx, cy, r, segments = 16) {
  const pts = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
}

/** A thick line segment as a closed quad (for vector box drawing). */
export function strokeSegmentPath(x0, y0, x1, y1, thickness) {
  const dx = x1 - x0; const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * thickness / 2;
  const ny = (dx / len) * thickness / 2;
  return [x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny];
}

/** Quarter arc stroke (for rounded box corners). */
export function strokeArcPath(cx, cy, radius, startAngle, endAngle, thickness, segments = 10) {
  const outer = []; const inner = [];
  const ro = radius + thickness / 2; const ri = Math.max(0, radius - thickness / 2);
  for (let i = 0; i <= segments; i += 1) {
    const a = startAngle + (i / segments) * (endAngle - startAngle);
    outer.push(cx + Math.cos(a) * ro, cy + Math.sin(a) * ro);
    inner.push(cx + Math.cos(a) * ri, cy + Math.sin(a) * ri);
  }
  const pts = [...outer];
  for (let i = inner.length - 2; i >= 0; i -= 2) pts.push(inner[i], inner[i + 1]);
  return pts;
}

/**
 * Composite a coverage mask into an RGBA8 framebuffer (source-over) with a
 * solid colour. `mask` is { alpha, width, height }; (dx, dy) integer offset.
 */
export function blendMask(fb, fbWidth, fbHeight, mask, dx, dy, r, g, b, a = 255) {
  const mw = mask.width; const mh = mask.height; const alpha = mask.alpha;
  const x0 = Math.max(0, dx); const y0 = Math.max(0, dy);
  const x1 = Math.min(fbWidth, dx + mw); const y1 = Math.min(fbHeight, dy + mh);
  for (let y = y0; y < y1; y += 1) {
    let mi = (y - dy) * mw + (x0 - dx);
    let fi = (y * fbWidth + x0) * 4;
    for (let x = x0; x < x1; x += 1, mi += 1, fi += 4) {
      const cov = alpha[mi];
      if (cov === 0) continue;
      const sa = (cov * a + 127) / 255 / 255;
      if (sa >= 0.999) { fb[fi] = r; fb[fi + 1] = g; fb[fi + 2] = b; fb[fi + 3] = 255; continue; }
      const da = fb[fi + 3] / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      const k = sa / oa;
      fb[fi] = fb[fi] + (r - fb[fi]) * k;
      fb[fi + 1] = fb[fi + 1] + (g - fb[fi + 1]) * k;
      fb[fi + 2] = fb[fi + 2] + (b - fb[fi + 2]) * k;
      fb[fi + 3] = oa * 255;
    }
  }
}

/** Fill an axis-aligned pixel rect (source-over, solid colour). */
export function fillRectRgba(fb, fbWidth, fbHeight, x, y, w, h, r, g, b, a = 255) {
  const x0 = Math.max(0, Math.round(x)); const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(fbWidth, Math.round(x + w)); const y1 = Math.min(fbHeight, Math.round(y + h));
  const sa = a / 255;
  for (let yy = y0; yy < y1; yy += 1) {
    let fi = (yy * fbWidth + x0) * 4;
    for (let xx = x0; xx < x1; xx += 1, fi += 4) {
      if (sa >= 0.999) { fb[fi] = r; fb[fi + 1] = g; fb[fi + 2] = b; fb[fi + 3] = 255; continue; }
      const da = fb[fi + 3] / 255;
      const oa = sa + da * (1 - sa);
      const k = oa > 0 ? sa / oa : 0;
      fb[fi] = fb[fi] + (r - fb[fi]) * k;
      fb[fi + 1] = fb[fi + 1] + (g - fb[fi + 1]) * k;
      fb[fi + 2] = fb[fi + 2] + (b - fb[fi + 2]) * k;
      fb[fi + 3] = oa * 255;
    }
  }
}

/** Rasterize polylines and blend into the framebuffer with a colour. */
export function fillPaths(fb, fbWidth, fbHeight, polylines, r, g, b, a = 255) {
  if (!polylines.length) return;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const poly of polylines) {
    for (let i = 0; i < poly.length; i += 2) {
      if (poly[i] < minX) minX = poly[i];
      if (poly[i] > maxX) maxX = poly[i];
      if (poly[i + 1] < minY) minY = poly[i + 1];
      if (poly[i + 1] > maxY) maxY = poly[i + 1];
    }
  }
  const ox = Math.max(0, Math.floor(minX)); const oy = Math.max(0, Math.floor(minY));
  const ex = Math.min(fbWidth, Math.ceil(maxX) + 1); const ey = Math.min(fbHeight, Math.ceil(maxY) + 1);
  if (ex <= ox || ey <= oy) return;
  const local = polylines.map((poly) => poly.map((v, i) => (i % 2 === 0 ? v - ox : v - oy)));
  const mask = rasterizePolylines(local, ex - ox, ey - oy);
  blendMask(fb, fbWidth, fbHeight, mask, ox, oy, r, g, b, a);
}
