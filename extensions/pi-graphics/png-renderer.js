// Minimal PNG renderer used by the agent-utils Pi graphics theme/extension.
//
// Produces 8-bit RGBA PNG bytes from a synthesized pixel grid. The output is
// deliberately tiny (a few cells wide, a few cells tall) because it backs
// kitty graphics protocol placements anchored under Unicode placeholders -- it
// is not a general image library.
//
// The renderer is intentionally TypeScript-friendly (plain ESM, no
// dependencies, exhaustive typed-jsdoc shape) so the Pi extension can call it
// at runtime without bringing in node-canvas / sharp / ffmpeg.

import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE_RGBA = 6;
const BIT_DEPTH = 8;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * Convert a CSS-style #rrggbb / #rrggbbaa hex string or a bare integer to an
 * `[r, g, b, a]` tuple with 0-255 channels. Accepts shorthand `#rgb`/`#rgba`.
 */
export function parseColor(input) {
  if (Array.isArray(input)) {
    const [r = 0, g = 0, b = 0, a = 255] = input;
    return [clampByte(r), clampByte(g), clampByte(b), clampByte(a)];
  }
  if (input && typeof input === "object" && "r" in input) {
    return [clampByte(input.r), clampByte(input.g), clampByte(input.b), clampByte(input.a ?? 255)];
  }
  if (typeof input === "number") {
    const v = clampByte(input);
    return [v, v, v, 255];
  }
  if (typeof input !== "string") return [0, 0, 0, 0];
  let hex = input.trim();
  if (hex.startsWith("#")) hex = hex.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    hex = hex.split("").map((c) => `${c}${c}`).join("");
  }
  if (hex.length === 6) hex = `${hex}ff`;
  if (hex.length !== 8 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`Invalid color literal: ${input}`);
  }
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    Number.parseInt(hex.slice(6, 8), 16),
  ];
}

function clampByte(value) {
  const n = Math.round(Number(value) || 0);
  if (n < 0) return 0;
  if (n > 255) return 255;
  return n;
}

/**
 * Encode an RGBA pixel buffer (length = width*height*4) into PNG bytes.
 */
function validateRgbaFrame(pixels, width, height, label = "RGBA frame") {
  if (!Number.isInteger(width) || width <= 0) throw new Error(`${label} width must be a positive integer, got ${width}`);
  if (!Number.isInteger(height) || height <= 0) throw new Error(`${label} height must be a positive integer, got ${height}`);
  const expected = width * height * 4;
  if (!pixels || pixels.length !== expected) {
    throw new Error(`${label} pixel buffer length ${pixels?.length} does not match width*height*4 (${expected})`);
  }
}

function makeIhdr(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(BIT_DEPTH, 8);
  ihdr.writeUInt8(COLOR_TYPE_RGBA, 9);
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter: adaptive
  ihdr.writeUInt8(0, 12); // interlace: none
  return ihdr;
}

function deflateRgbaFrame(pixels, width, height) {
  const rowStride = width * 4;
  const filtered = Buffer.alloc(height * (rowStride + 1));
  for (let y = 0; y < height; y += 1) {
    filtered[y * (rowStride + 1)] = 0; // filter type none
    pixels.copy(filtered, y * (rowStride + 1) + 1, y * rowStride, (y + 1) * rowStride);
  }
  return deflateSync(filtered);
}

/**
 * Encode an RGBA pixel buffer (length = width*height*4) into PNG bytes.
 */
export function encodeRgbaPng(pixels, width, height) {
  validateRgbaFrame(pixels, width, height, "encodeRgbaPng");
  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk("IHDR", makeIhdr(width, height)),
    makeChunk("IDAT", deflateRgbaFrame(pixels, width, height)),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeAnimationControl(numFrames, numPlays) {
  const chunk = Buffer.alloc(8);
  chunk.writeUInt32BE(numFrames, 0);
  chunk.writeUInt32BE(Math.max(0, Math.trunc(numPlays ?? 0)), 4);
  return chunk;
}

function makeFrameControl(sequence, width, height, delayMs) {
  const chunk = Buffer.alloc(26);
  chunk.writeUInt32BE(sequence, 0);
  chunk.writeUInt32BE(width, 4);
  chunk.writeUInt32BE(height, 8);
  chunk.writeUInt32BE(0, 12); // x offset
  chunk.writeUInt32BE(0, 16); // y offset
  chunk.writeUInt16BE(Math.max(1, Math.trunc(delayMs ?? 100)), 20);
  chunk.writeUInt16BE(1000, 22); // delay denominator: delay numerator is ms
  chunk.writeUInt8(0, 24); // APNG_DISPOSE_OP_NONE
  chunk.writeUInt8(0, 25); // APNG_BLEND_OP_SOURCE
  return chunk;
}

/**
 * Encode same-sized RGBA frames as APNG. Kitty accepts animated PNG payloads,
 * so this lets Pi render efficient pulse effects with one image transmission
 * instead of a stream of repeated static uploads.
 */
export function encodeRgbaApng(frames, width, height, { delayMs = 100, plays = 0 } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error("encodeRgbaApng requires at least one frame");
  if (frames.length > 256) throw new Error(`encodeRgbaApng supports at most 256 frames, got ${frames.length}`);
  for (const [index, frame] of frames.entries()) validateRgbaFrame(frame, width, height, `encodeRgbaApng frame ${index}`);

  const chunks = [
    PNG_SIGNATURE,
    makeChunk("IHDR", makeIhdr(width, height)),
    makeChunk("acTL", makeAnimationControl(frames.length, plays)),
  ];
  let sequence = 0;
  frames.forEach((frame, index) => {
    chunks.push(makeChunk("fcTL", makeFrameControl(sequence++, width, height, delayMs)));
    const compressed = deflateRgbaFrame(frame, width, height);
    if (index === 0) {
      chunks.push(makeChunk("IDAT", compressed));
    } else {
      const fdAT = Buffer.alloc(4 + compressed.length);
      fdAT.writeUInt32BE(sequence++, 0);
      compressed.copy(fdAT, 4);
      chunks.push(makeChunk("fdAT", fdAT));
    }
  });
  chunks.push(makeChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

/**
 * Allocate an empty RGBA pixel buffer pre-filled with `background`.
 */
export function makeCanvas(width, height, background = [0, 0, 0, 0]) {
  const [r, g, b, a] = parseColor(background);
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  }
  return pixels;
}

function blendOver(dst, dstOff, sr, sg, sb, sa) {
  if (sa === 0) return;
  if (sa === 255) {
    dst[dstOff] = sr;
    dst[dstOff + 1] = sg;
    dst[dstOff + 2] = sb;
    dst[dstOff + 3] = 255;
    return;
  }
  const dr = dst[dstOff];
  const dg = dst[dstOff + 1];
  const db = dst[dstOff + 2];
  const da = dst[dstOff + 3];
  const sAlpha = sa / 255;
  const dAlpha = da / 255;
  const outAlpha = sAlpha + dAlpha * (1 - sAlpha);
  if (outAlpha <= 0) {
    dst[dstOff] = 0;
    dst[dstOff + 1] = 0;
    dst[dstOff + 2] = 0;
    dst[dstOff + 3] = 0;
    return;
  }
  dst[dstOff] = Math.round((sr * sAlpha + dr * dAlpha * (1 - sAlpha)) / outAlpha);
  dst[dstOff + 1] = Math.round((sg * sAlpha + dg * dAlpha * (1 - sAlpha)) / outAlpha);
  dst[dstOff + 2] = Math.round((sb * sAlpha + db * dAlpha * (1 - sAlpha)) / outAlpha);
  dst[dstOff + 3] = Math.round(outAlpha * 255);
}

/** Set a single pixel using "over" alpha compositing. */
export function setPixel(pixels, width, x, y, color) {
  if (x < 0 || y < 0) return;
  const [sr, sg, sb, sa] = parseColor(color);
  const off = (y * width + x) * 4;
  if (off < 0 || off + 4 > pixels.length) return;
  blendOver(pixels, off, sr, sg, sb, sa);
}

/** Draw an axis-aligned filled rectangle into the canvas. */
export function fillRect(pixels, width, x, y, w, h, color) {
  const [sr, sg, sb, sa] = parseColor(color);
  const height = pixels.length / 4 / width;
  const x0 = Math.max(0, Math.trunc(x));
  const y0 = Math.max(0, Math.trunc(y));
  const x1 = Math.min(width, Math.trunc(x + w));
  const y1 = Math.min(height, Math.trunc(y + h));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      blendOver(pixels, (py * width + px) * 4, sr, sg, sb, sa);
    }
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function lerpColor(start, end, t) {
  const a = parseColor(start);
  const b = parseColor(end);
  const k = clamp01(t);
  return [
    Math.round(lerp(a[0], b[0], k)),
    Math.round(lerp(a[1], b[1], k)),
    Math.round(lerp(a[2], b[2], k)),
    Math.round(lerp(a[3], b[3], k)),
  ];
}

/**
 * Fill a horizontal gradient between `start` and `end` colors. Useful for
 * drawing translucent gradient borders, prompt enclosure lines, etc.
 */
export function fillHorizontalGradient(pixels, width, x, y, w, h, start, end) {
  const height = pixels.length / 4 / width;
  const x0 = Math.max(0, Math.trunc(x));
  const y0 = Math.max(0, Math.trunc(y));
  const x1 = Math.min(width, Math.trunc(x + w));
  const y1 = Math.min(height, Math.trunc(y + h));
  const span = Math.max(1, x1 - x0 - 1);
  for (let px = x0; px < x1; px += 1) {
    const color = lerpColor(start, end, (px - x0) / span);
    for (let py = y0; py < y1; py += 1) {
      blendOver(pixels, (py * width + px) * 4, color[0], color[1], color[2], color[3]);
    }
  }
}

/** Fill a vertical gradient between `top` and `bottom` colors. */
export function fillVerticalGradient(pixels, width, x, y, w, h, top, bottom) {
  const height = pixels.length / 4 / width;
  const x0 = Math.max(0, Math.trunc(x));
  const y0 = Math.max(0, Math.trunc(y));
  const x1 = Math.min(width, Math.trunc(x + w));
  const y1 = Math.min(height, Math.trunc(y + h));
  const span = Math.max(1, y1 - y0 - 1);
  for (let py = y0; py < y1; py += 1) {
    const color = lerpColor(top, bottom, (py - y0) / span);
    for (let px = x0; px < x1; px += 1) {
      blendOver(pixels, (py * width + px) * 4, color[0], color[1], color[2], color[3]);
    }
  }
}

/** Add a soft radial glow with quadratic falloff. */
export function addRadialGlow(pixels, width, centerX, centerY, radius, color, strength = 1) {
  const [r, g, b, a] = parseColor(color);
  const height = pixels.length / 4 / width;
  const rad = Math.max(1, Number(radius) || 1);
  const x0 = Math.max(0, Math.floor(centerX - rad));
  const y0 = Math.max(0, Math.floor(centerY - rad));
  const x1 = Math.min(width - 1, Math.ceil(centerX + rad));
  const y1 = Math.min(height - 1, Math.ceil(centerY + rad));
  const s = clamp01(strength);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = (x + 0.5 - centerX) / rad;
      const dy = (y + 0.5 - centerY) / rad;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const falloff = (1 - d2) * (1 - d2);
      blendOver(pixels, (y * width + x) * 4, r, g, b, Math.round(a * s * falloff));
    }
  }
}

/** Draw subtle horizontal scanlines to make static panels feel active. */
export function addScanlines(pixels, width, { every = 4, alpha = 18, color = "#ffffff" } = {}) {
  const height = pixels.length / 4 / width;
  const [r, g, b] = parseColor(color);
  const step = Math.max(2, Math.trunc(every));
  for (let y = 1; y < height; y += step) {
    for (let x = 0; x < width; x += 1) {
      blendOver(pixels, (y * width + x) * 4, r, g, b, Math.max(0, Math.min(255, Math.trunc(alpha))));
    }
  }
}

/** Render a 1-px stroked rectangle outline (top, bottom, left, right). */
export function strokeRect(pixels, width, x, y, w, h, color, thickness = 1) {
  const t = Math.max(1, Math.trunc(thickness));
  fillRect(pixels, width, x, y, w, t, color);
  fillRect(pixels, width, x, y + h - t, w, t, color);
  fillRect(pixels, width, x, y, t, h, color);
  fillRect(pixels, width, x + w - t, y, t, h, color);
}
