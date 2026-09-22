import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export const MAX_SHARED_IMAGE_BYTES = 8 * 1024 * 1024;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Validate the PNG container without inflating untrusted pixel data. APNG uses
// the same container; its bytes are preserved, not converted to a preview.
export function validateSharedPng(bytes) {
  const invalid = () => { throw new Error("Cannot share malformed PNG/APNG image."); };
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(SIGNATURE)) invalid();
  let offset = 8;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) invalid();
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) invalid();
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      const depth = bytes[offset + 16];
      const color = bytes[offset + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff
        || !depths[color]?.includes(depth) || bytes[offset + 18] !== 0
        || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) invalid();
    } else if (type === "IHDR") invalid();
    if (type === "IDAT" && length > 0) hasData = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length || !hasData) invalid();
      return;
    }
    offset = end;
  }
  invalid();
}

// Deliberately synchronous and bounded: freeze selection and bytes before any
// await lets gallery navigation or the two-buffer stream rotate/delete a frame.
// The final result owns the base64 string; it never depends on the file again.
export function shareCurrentImage(state, signal) {
  signal?.throwIfAborted();
  const item = state.items[state.index];
  if (!item) throw new Error("No current image to share. Add or select an image first.");
  const fd = openSync(item.path, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes;
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("Only regular PNG/APNG files can be shared.");
    if (info.size > MAX_SHARED_IMAGE_BYTES) throw new Error("Shared image exceeds the 8 MiB limit.");
    const buffer = Buffer.alloc(MAX_SHARED_IMAGE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_SHARED_IMAGE_BYTES) throw new Error("Shared image exceeds the 8 MiB limit.");
    bytes = buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
  validateSharedPng(bytes);
  signal?.throwIfAborted();
  return {
    content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }],
    details: { shared: true, label: item.label, byteLength: bytes.length },
  };
}
