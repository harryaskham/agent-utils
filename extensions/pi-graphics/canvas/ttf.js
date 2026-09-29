// Minimal dependency-free TrueType (glyf) reader for the Pi graphics canvas.
//
// Supports what a terminal renderer needs: cmap formats 4 and 12, horizontal
// metrics, simple and composite glyf outlines (quadratic B-splines), and a
// TrueType Collection face index. CFF-flavoured OpenType fonts are rejected so
// callers can fall back to another face.

function tag(view, offset) {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

export class TrueTypeFont {
  constructor(buffer, { faceIndex = 0 } = {}) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let base = 0;
    if (tag(this.view, 0) === "ttcf") {
      const count = this.view.getUint32(8);
      const index = Math.max(0, Math.min(count - 1, faceIndex));
      base = this.view.getUint32(12 + index * 4);
    }
    const numTables = this.view.getUint16(base + 4);
    this.tables = new Map();
    for (let i = 0; i < numTables; i += 1) {
      const record = base + 12 + i * 16;
      this.tables.set(tag(this.view, record), { offset: this.view.getUint32(record + 8), length: this.view.getUint32(record + 12) });
    }
    if (!this.tables.has("glyf") || !this.tables.has("loca")) throw new Error("font has no TrueType glyf outlines (CFF fonts are unsupported)");
    const head = this.table("head");
    this.unitsPerEm = this.view.getUint16(head + 18);
    this.indexToLocFormat = this.view.getInt16(head + 50);
    const hhea = this.table("hhea");
    this.ascender = this.view.getInt16(hhea + 4);
    this.descender = this.view.getInt16(hhea + 6);
    this.lineGap = this.view.getInt16(hhea + 8);
    this.numberOfHMetrics = this.view.getUint16(hhea + 34);
    this.numGlyphs = this.view.getUint16(this.table("maxp") + 4);
    const os2 = this.tables.get("OS/2");
    if (os2 && os2.length >= 78) {
      // Prefer typographic metrics when the font asks for them (USE_TYPO_METRICS).
      const fsSelection = this.view.getUint16(os2.offset + 62);
      if (fsSelection & 0x80) {
        this.ascender = this.view.getInt16(os2.offset + 68);
        this.descender = this.view.getInt16(os2.offset + 70);
        this.lineGap = this.view.getInt16(os2.offset + 72);
      }
    }
    this.cmap = this.parseCmap();
    this.glyphCache = new Map();
  }

  table(name) {
    const entry = this.tables.get(name);
    if (!entry) throw new Error(`font is missing ${name} table`);
    return entry.offset;
  }

  parseCmap() {
    const cmap = this.table("cmap");
    const count = this.view.getUint16(cmap + 2);
    const candidates = [];
    for (let i = 0; i < count; i += 1) {
      const record = cmap + 4 + i * 8;
      const platform = this.view.getUint16(record);
      const encoding = this.view.getUint16(record + 2);
      const offset = cmap + this.view.getUint32(record + 4);
      const format = this.view.getUint16(offset);
      let score = 0;
      if (format === 12 && (platform === 3 && encoding === 10 || platform === 0)) score = 4;
      else if (format === 4 && platform === 3 && encoding === 1) score = 3;
      else if (format === 4 && platform === 0) score = 2;
      if (score) candidates.push({ score, offset, format });
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) throw new Error("font has no usable Unicode cmap");
    const view = this.view;
    if (best.format === 12) {
      const groups = view.getUint32(best.offset + 12);
      const starts = new Uint32Array(groups);
      const ends = new Uint32Array(groups);
      const glyphs = new Uint32Array(groups);
      for (let i = 0; i < groups; i += 1) {
        const g = best.offset + 16 + i * 12;
        starts[i] = view.getUint32(g);
        ends[i] = view.getUint32(g + 4);
        glyphs[i] = view.getUint32(g + 8);
      }
      return (codepoint) => {
        let lo = 0; let hi = groups - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (codepoint < starts[mid]) hi = mid - 1;
          else if (codepoint > ends[mid]) lo = mid + 1;
          else return glyphs[mid] + (codepoint - starts[mid]);
        }
        return 0;
      };
    }
    const segX2 = view.getUint16(best.offset + 6);
    const segCount = segX2 / 2;
    const endsAt = best.offset + 14;
    const startsAt = endsAt + segX2 + 2;
    const deltasAt = startsAt + segX2;
    const rangesAt = deltasAt + segX2;
    return (codepoint) => {
      if (codepoint > 0xffff) return 0;
      let lo = 0; let hi = segCount - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const end = view.getUint16(endsAt + mid * 2);
        if (codepoint > end) { lo = mid + 1; continue; }
        const start = view.getUint16(startsAt + mid * 2);
        if (codepoint < start) { hi = mid - 1; continue; }
        const delta = view.getInt16(deltasAt + mid * 2);
        const rangeOffset = view.getUint16(rangesAt + mid * 2);
        if (rangeOffset === 0) return (codepoint + delta) & 0xffff;
        const glyphAt = rangesAt + mid * 2 + rangeOffset + (codepoint - start) * 2;
        const glyph = view.getUint16(glyphAt);
        return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
      }
      return 0;
    };
  }

  glyphIndex(codepoint) {
    return this.cmap(codepoint) || 0;
  }

  hasGlyph(codepoint) {
    return this.glyphIndex(codepoint) !== 0;
  }

  advanceWidth(glyphIndex) {
    const hmtx = this.table("hmtx");
    const index = Math.min(glyphIndex, this.numberOfHMetrics - 1);
    return this.view.getUint16(hmtx + index * 4);
  }

  glyphLocation(glyphIndex) {
    const loca = this.table("loca");
    if (glyphIndex < 0 || glyphIndex >= this.numGlyphs) return null;
    let start; let end;
    if (this.indexToLocFormat === 0) {
      start = this.view.getUint16(loca + glyphIndex * 2) * 2;
      end = this.view.getUint16(loca + glyphIndex * 2 + 2) * 2;
    } else {
      start = this.view.getUint32(loca + glyphIndex * 4);
      end = this.view.getUint32(loca + glyphIndex * 4 + 4);
    }
    return end > start ? { offset: this.table("glyf") + start, length: end - start } : null;
  }

  /**
   * Glyph outline as contours of points {x, y, on} in font units (y up).
   * Composite glyphs are flattened with their transforms.
   */
  glyphContours(glyphIndex, depth = 0) {
    if (depth === 0 && this.glyphCache.has(glyphIndex)) return this.glyphCache.get(glyphIndex);
    const location = this.glyphLocation(glyphIndex);
    let contours = [];
    if (location && depth < 8) {
      const view = this.view;
      const offset = location.offset;
      const numberOfContours = view.getInt16(offset);
      if (numberOfContours >= 0) contours = this.simpleGlyph(offset, numberOfContours);
      else contours = this.compositeGlyph(offset, depth);
    }
    if (depth === 0) {
      this.glyphCache.set(glyphIndex, contours);
      if (this.glyphCache.size > 4096) this.glyphCache.delete(this.glyphCache.keys().next().value);
    }
    return contours;
  }

  simpleGlyph(offset, numberOfContours) {
    const view = this.view;
    let p = offset + 10;
    const endPts = [];
    for (let i = 0; i < numberOfContours; i += 1) { endPts.push(view.getUint16(p)); p += 2; }
    const numPoints = numberOfContours ? endPts[endPts.length - 1] + 1 : 0;
    const instructionLength = view.getUint16(p); p += 2 + instructionLength;
    const flags = new Uint8Array(numPoints);
    for (let i = 0; i < numPoints;) {
      const flag = view.getUint8(p++);
      flags[i++] = flag;
      if (flag & 8) {
        let repeat = view.getUint8(p++);
        while (repeat-- > 0 && i < numPoints) flags[i++] = flag;
      }
    }
    const xs = new Int32Array(numPoints);
    const ys = new Int32Array(numPoints);
    let value = 0;
    for (let i = 0; i < numPoints; i += 1) {
      const flag = flags[i];
      if (flag & 2) { const d = view.getUint8(p++); value += flag & 16 ? d : -d; }
      else if (!(flag & 16)) { value += view.getInt16(p); p += 2; }
      xs[i] = value;
    }
    value = 0;
    for (let i = 0; i < numPoints; i += 1) {
      const flag = flags[i];
      if (flag & 4) { const d = view.getUint8(p++); value += flag & 32 ? d : -d; }
      else if (!(flag & 32)) { value += view.getInt16(p); p += 2; }
      ys[i] = value;
    }
    const contours = [];
    let start = 0;
    for (const end of endPts) {
      const contour = [];
      for (let i = start; i <= end; i += 1) contour.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
      if (contour.length) contours.push(contour);
      start = end + 1;
    }
    return contours;
  }

  compositeGlyph(offset, depth) {
    const view = this.view;
    let p = offset + 10;
    const contours = [];
    let flags;
    do {
      flags = view.getUint16(p);
      const glyphIndex = view.getUint16(p + 2);
      p += 4;
      let dx; let dy;
      if (flags & 1) { dx = view.getInt16(p); dy = view.getInt16(p + 2); p += 4; }
      else { dx = view.getInt8(p); dy = view.getInt8(p + 1); p += 2; }
      if (!(flags & 2)) { dx = 0; dy = 0; } // point-matching anchors: unsupported, treat as no offset
      let a = 1; let b = 0; let c = 0; let d = 1;
      const f2dot14 = (at) => view.getInt16(at) / 16384;
      if (flags & 8) { a = d = f2dot14(p); p += 2; }
      else if (flags & 0x40) { a = f2dot14(p); d = f2dot14(p + 2); p += 4; }
      else if (flags & 0x80) { a = f2dot14(p); b = f2dot14(p + 2); c = f2dot14(p + 4); d = f2dot14(p + 6); p += 8; }
      for (const contour of this.glyphContours(glyphIndex, depth + 1)) {
        contours.push(contour.map((pt) => ({ x: pt.x * a + pt.y * c + dx, y: pt.x * b + pt.y * d + dy, on: pt.on })));
      }
    } while (flags & 0x20);
    return contours;
  }
}

/**
 * Convert TrueType contours into flattened polylines in pixel space.
 * `transform(x, y)` maps font units to pixels. Quadratic segments are
 * subdivided adaptively (tolerance in pixels).
 */
export function flattenContours(contours, transform, tolerance = 0.2) {
  const polylines = [];
  for (const contour of contours) {
    const n = contour.length;
    if (n < 2) continue;
    // Start on an on-curve point; an all-off-curve contour starts at the
    // implied midpoint between its first two control points.
    let startIndex = contour.findIndex((pt) => pt.on);
    let start;
    let control = null;
    let steps = n;
    if (startIndex < 0) {
      const a = contour[0]; const b = contour[1];
      start = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      startIndex = 1;
      control = transform(b.x, b.y);
      steps = n - 1;
    } else start = contour[startIndex];
    const out = [];
    const [sx, sy] = transform(start.x, start.y);
    out.push(sx, sy);
    let prevX = sx; let prevY = sy;
    const emitQuad = (cx, cy, ex, ey) => {
      const ddx = prevX - 2 * cx + ex;
      const ddy = prevY - 2 * cy + ey;
      const dd = Math.hypot(ddx, ddy);
      const steps = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(dd / (tolerance * 8)))));
      for (let s = 1; s <= steps; s += 1) {
        const t = s / steps; const u = 1 - t;
        out.push(u * u * prevX + 2 * u * t * cx + t * t * ex, u * u * prevY + 2 * u * t * cy + t * t * ey);
      }
      prevX = ex; prevY = ey;
    };
    for (let k = 1; k <= steps; k += 1) {
      const pt = contour[(startIndex + k) % n];
      const [px, py] = transform(pt.x, pt.y);
      if (k === steps && pt === start) {
        // closing on the starting on-curve point
        if (control) emitQuad(control[0], control[1], px, py);
        control = null;
        break;
      }
      if (pt.on) {
        if (control) { emitQuad(control[0], control[1], px, py); control = null; }
        else { out.push(px, py); prevX = px; prevY = py; }
      } else if (control) {
        const mx = (control[0] + px) / 2; const my = (control[1] + py) / 2;
        emitQuad(control[0], control[1], mx, my);
        control = [px, py];
      } else control = [px, py];
    }
    if (control) emitQuad(control[0], control[1], sx, sy);
    polylines.push(out);
  }
  return polylines;
}
