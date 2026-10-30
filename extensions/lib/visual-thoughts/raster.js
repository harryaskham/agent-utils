// Visual thoughts: images prepared as a terminal backdrop, and crossfades between them.
//
// A generated image (about 1.5 megapixels) becomes a small raster the size of the backdrop at
// a low resolution (the terminal scales it up smoothly; a dreamy backdrop wants no detail):
// fitted (cover, contain or stretch), its edges feathered into transparency, and its alpha
// scaled by the opacity. Crossfades blend two prepared rasters; each frame is a small PNG.
import { deflateSync } from "node:zlib";

import { decodePng } from "../../pi-graphics/canvas/png-decode.js";

export const FITS = Object.freeze(["cover", "contain", "stretch"]);

/** A decoded PNG: { width, height, rgba } (straight alpha). */
export function decodeImage(png) {
  return decodePng(png);
}

/**
 * The raster size of a backdrop of `cols`×`rows` cells: `detail` pixels per column, rows at the
 * cell's aspect (height/width), bounded so a frame stays small.
 */
export function backdropRasterSize({ cols, rows, detail = 2, cellAspect = 2.1, maxPixels = 250_000 }) {
  let width = Math.max(8, Math.round(Math.max(1, cols) * Math.max(0.25, detail)));
  let height = Math.max(8, Math.round(Math.max(1, rows) * Math.max(0.25, detail) * Math.max(0.5, cellAspect)));
  const pixels = width * height;
  if (pixels > maxPixels) {
    const shrink = Math.sqrt(maxPixels / pixels);
    width = Math.max(8, Math.floor(width * shrink));
    height = Math.max(8, Math.floor(height * shrink));
  }
  return { width, height };
}

function smoothstep(edge, x) {
  if (edge <= 0) return 1;
  const t = Math.max(0, Math.min(1, x / edge));
  return t * t * (3 - 2 * t);
}

/**
 * Sample `src` (decoded) into a `width`×`height` raster: `fit` places it (cover crops to fill,
 * contain letterboxes with transparency, stretch fills), `feather` (a fraction of the shorter
 * side) fades the image's edges into transparency, and `opacity` scales its alpha. Downscaling
 * averages each target pixel's footprint; upscaling interpolates.
 */
export function prepareBackdrop(src, { width, height, fit = "cover", feather = 0.1, opacity = 0.25 }) {
  const out = new Uint8Array(width * height * 4);
  const sw = src.width;
  const sh = src.height;
  const rgba = src.rgba;
  // The source rectangle drawn and where it lands (target pixels).
  let sx0 = 0; let sy0 = 0; let scw = sw; let sch = sh;
  let ox = 0; let oy = 0; let iw = width; let ih = height;
  if (fit === "cover") {
    const scale = Math.max(width / sw, height / sh);
    scw = width / scale; sch = height / scale;
    sx0 = (sw - scw) / 2; sy0 = (sh - sch) / 2;
  } else if (fit === "contain") {
    const scale = Math.min(width / sw, height / sh);
    iw = sw * scale; ih = sh * scale;
    ox = (width - iw) / 2; oy = (height - ih) / 2;
  }
  const fx = scw / iw;
  const fy = sch / ih;
  const edge = Math.max(0, feather) * Math.min(iw, ih);
  const alphaScale = Math.max(0, Math.min(1, opacity));
  const xStart = Math.max(0, Math.floor(ox)); const xEnd = Math.min(width, Math.ceil(ox + iw));
  const yStart = Math.max(0, Math.floor(oy)); const yEnd = Math.min(height, Math.ceil(oy + ih));
  for (let y = yStart; y < yEnd; y += 1) {
    const ty = y + 0.5 - oy;
    const v0 = sy0 + (y - oy) * fy;
    const v1 = v0 + fy;
    const edgeY = smoothstep(edge, Math.min(ty, ih - ty));
    for (let x = xStart; x < xEnd; x += 1) {
      const tx = x + 0.5 - ox;
      const u0 = sx0 + (x - ox) * fx;
      const u1 = u0 + fx;
      let r = 0; let g = 0; let b = 0; let a = 0;
      if (fx >= 1 || fy >= 1) {
        // Box average over the footprint's whole source pixels.
        const xa = Math.max(0, Math.floor(u0)); const xb = Math.min(sw, Math.max(xa + 1, Math.ceil(u1)));
        const ya = Math.max(0, Math.floor(v0)); const yb = Math.min(sh, Math.max(ya + 1, Math.ceil(v1)));
        let n = 0;
        for (let sy = ya; sy < yb; sy += 1) {
          let s = (sy * sw + xa) * 4;
          for (let sx = xa; sx < xb; sx += 1, s += 4) {
            const sa = rgba[s + 3];
            r += rgba[s] * sa; g += rgba[s + 1] * sa; b += rgba[s + 2] * sa; a += sa; n += 1;
          }
        }
        if (a > 0) { r /= a; g /= a; b /= a; }
        a /= Math.max(1, n);
      } else {
        // Bilinear at the footprint's centre.
        const cu = Math.min(sw - 1, Math.max(0, (u0 + u1) / 2 - 0.5));
        const cv = Math.min(sh - 1, Math.max(0, (v0 + v1) / 2 - 0.5));
        const ix = Math.floor(cu); const iy = Math.floor(cv);
        const ax = cu - ix; const ay = cv - iy;
        const ix2 = Math.min(sw - 1, ix + 1); const iy2 = Math.min(sh - 1, iy + 1);
        const p00 = (iy * sw + ix) * 4; const p10 = (iy * sw + ix2) * 4;
        const p01 = (iy2 * sw + ix) * 4; const p11 = (iy2 * sw + ix2) * 4;
        const w00 = (1 - ax) * (1 - ay); const w10 = ax * (1 - ay); const w01 = (1 - ax) * ay; const w11 = ax * ay;
        r = rgba[p00] * w00 + rgba[p10] * w10 + rgba[p01] * w01 + rgba[p11] * w11;
        g = rgba[p00 + 1] * w00 + rgba[p10 + 1] * w10 + rgba[p01 + 1] * w01 + rgba[p11 + 1] * w11;
        b = rgba[p00 + 2] * w00 + rgba[p10 + 2] * w10 + rgba[p01 + 2] * w01 + rgba[p11 + 2] * w11;
        a = rgba[p00 + 3] * w00 + rgba[p10 + 3] * w10 + rgba[p01 + 3] * w01 + rgba[p11 + 3] * w11;
      }
      const o = (y * width + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
      out[o + 3] = a * alphaScale * edgeY * smoothstep(edge, Math.min(tx, iw - tx));
    }
  }
  return { width, height, rgba: out };
}

/**
 * The crossfade of two prepared rasters of one size at `t` (0: `from`, 1: `to`), blended with
 * premultiplied alpha so differently shaped (letterboxed) images fade correctly. A missing
 * `from` fades `to` in from nothing.
 */
export function blendBackdrops(from, to, t, out = new Uint8Array(to.width * to.height * 4)) {
  const k = Math.max(0, Math.min(1, t));
  const b = to.rgba;
  if (!from) {
    for (let i = 0; i < b.length; i += 4) {
      out[i] = b[i]; out[i + 1] = b[i + 1]; out[i + 2] = b[i + 2]; out[i + 3] = b[i + 3] * k;
    }
    return { width: to.width, height: to.height, rgba: out };
  }
  if (from.width !== to.width || from.height !== to.height) throw new Error("blendBackdrops: rasters differ in size");
  const a = from.rgba;
  const j = 1 - k;
  for (let i = 0; i < b.length; i += 4) {
    const aa = a[i + 3] * j;
    const ba = b[i + 3] * k;
    const alpha = aa + ba;
    if (alpha <= 0) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; continue; }
    out[i] = (a[i] * aa + b[i] * ba) / alpha;
    out[i + 1] = (a[i + 1] * aa + b[i + 1] * ba) / alpha;
    out[i + 2] = (a[i + 2] * aa + b[i + 2] * ba) / alpha;
    out[i + 3] = alpha;
  }
  return { width: to.width, height: to.height, rgba: out };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A raster as PNG bytes. Rows use the Sub filter (each byte minus its left neighbour's), which
 * suits smooth imagery: a soft backdrop compresses to a fraction of its raw size quickly.
 */
export function encodeBackdropPng({ width, height, rgba }, { level = 3 } = {}) {
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    const src = y * stride;
    filtered[row] = 1;
    for (let x = 0; x < stride; x += 1) {
      filtered[row + 1 + x] = (rgba[src + x] - (x >= 4 ? rgba[src + x - 4] : 0)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filtered, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
