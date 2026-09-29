// Minimal PNG decoder (non-interlaced, 8-bit; gray, gray+alpha, RGB, RGBA,
// palette) used by the pixel canvas to composite Pi's own inline images.
import { inflateSync } from "node:zlib";

export function decodePng(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length < 33 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0; let height = 0; let depth = 0; let colorType = 0; let interlace = 0;
  let palette = null; let transparency = null;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = raw[p++];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4; const i = x * channels;
      if (colorType === 6) { out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2]; out[o + 3] = cur[i + 3]; }
      else if (colorType === 2) { out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2]; out[o + 3] = 255; }
      else if (colorType === 0) { out[o] = out[o + 1] = out[o + 2] = cur[i]; out[o + 3] = 255; }
      else if (colorType === 4) { out[o] = out[o + 1] = out[o + 2] = cur[i]; out[o + 3] = cur[i + 1]; }
      else {
        const idx = cur[i];
        out[o] = palette?.[idx * 3] ?? 0; out[o + 1] = palette?.[idx * 3 + 1] ?? 0; out[o + 2] = palette?.[idx * 3 + 2] ?? 0;
        out[o + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
      }
    }
    cur.copy(prev);
  }
  return { width, height, rgba: out };
}

/** Bilinear sample of a decoded image into a destination rectangle. */
export function drawScaledImage(fb, fbWidth, fbHeight, image, dx, dy, dw, dh, { srcY = 0, srcH = image.height } = {}) {
  const x0 = Math.max(0, Math.floor(dx)); const y0 = Math.max(0, Math.floor(dy));
  const x1 = Math.min(fbWidth, Math.ceil(dx + dw)); const y1 = Math.min(fbHeight, Math.ceil(dy + dh));
  const sx = image.width / dw; const sy = srcH / dh;
  for (let y = y0; y < y1; y += 1) {
    const fy = Math.min(image.height - 1, Math.max(0, srcY + (y - dy + 0.5) * sy - 0.5));
    const iy = Math.floor(fy); const ty = fy - iy; const iy2 = Math.min(image.height - 1, iy + 1);
    for (let x = x0; x < x1; x += 1) {
      const fx = Math.min(image.width - 1, Math.max(0, (x - dx + 0.5) * sx - 0.5));
      const ix = Math.floor(fx); const tx = fx - ix; const ix2 = Math.min(image.width - 1, ix + 1);
      const o = (y * fbWidth + x) * 4;
      const s = (iy * image.width + ix) * 4; const s2 = (iy * image.width + ix2) * 4;
      const s3 = (iy2 * image.width + ix) * 4; const s4 = (iy2 * image.width + ix2) * 4;
      const px = [0, 1, 2, 3].map((k) => {
        const top = image.rgba[s + k] * (1 - tx) + image.rgba[s2 + k] * tx;
        const bottom = image.rgba[s3 + k] * (1 - tx) + image.rgba[s4 + k] * tx;
        return top * (1 - ty) + bottom * ty;
      });
      const sa = px[3] / 255;
      if (sa <= 0) continue;
      const da = fb[o + 3] / 255;
      const oa = sa + da * (1 - sa);
      const k = sa / oa;
      fb[o] = fb[o] + (px[0] - fb[o]) * k;
      fb[o + 1] = fb[o + 1] + (px[1] - fb[o + 1]) * k;
      fb[o + 2] = fb[o + 2] + (px[2] - fb[o + 2]) * k;
      fb[o + 3] = oa * 255;
    }
  }
}
