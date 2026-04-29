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
export function encodeRgbaPng(pixels, width, height) {
  if (!Number.isInteger(width) || width <= 0) throw new Error(`encodeRgbaPng width must be a positive integer, got ${width}`);
  if (!Number.isInteger(height) || height <= 0) throw new Error(`encodeRgbaPng height must be a positive integer, got ${height}`);
  const expected = width * height * 4;
  if (pixels.length !== expected) {
    throw new Error(`encodeRgbaPng pixel buffer length ${pixels.length} does not match width*height*4 (${expected})`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(BIT_DEPTH, 8);
  ihdr.writeUInt8(COLOR_TYPE_RGBA, 9);
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter: adaptive
  ihdr.writeUInt8(0, 12); // interlace: none

  const rowStride = width * 4;
  const filtered = Buffer.alloc(height * (rowStride + 1));
  for (let y = 0; y < height; y += 1) {
    filtered[y * (rowStride + 1)] = 0; // filter type none
    pixels.copy(filtered, y * (rowStride + 1) + 1, y * rowStride, (y + 1) * rowStride);
  }
  const idat = deflateSync(filtered);

  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", idat),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
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

/**
 * Fill a horizontal gradient between `start` and `end` colors. Useful for
 * drawing translucent gradient borders, prompt enclosure lines, etc.
 */
export function fillHorizontalGradient(pixels, width, x, y, w, h, start, end) {
  const startColor = parseColor(start);
  const endColor = parseColor(end);
  const height = pixels.length / 4 / width;
  const x0 = Math.max(0, Math.trunc(x));
  const y0 = Math.max(0, Math.trunc(y));
  const x1 = Math.min(width, Math.trunc(x + w));
  const y1 = Math.min(height, Math.trunc(y + h));
  const span = Math.max(1, x1 - x0 - 1);
  for (let px = x0; px < x1; px += 1) {
    const t = (px - x0) / span;
    const r = Math.round(lerp(startColor[0], endColor[0], t));
    const g = Math.round(lerp(startColor[1], endColor[1], t));
    const b = Math.round(lerp(startColor[2], endColor[2], t));
    const a = Math.round(lerp(startColor[3], endColor[3], t));
    for (let py = y0; py < y1; py += 1) {
      blendOver(pixels, (py * width + px) * 4, r, g, b, a);
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
