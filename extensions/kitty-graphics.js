import { readFile } from "node:fs/promises";

const ESC = "\x1b";
const APC_START = `${ESC}_G`;
const APC_END = `${ESC}\\`;
const TMUX_DCS_START = `${ESC}Ptmux;`;
const TMUX_DCS_END = `${ESC}\\`;

const DEFAULT_CHUNK_SIZE = 4096;
const CONTROL_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const KITTY_PLACEHOLDER_CODEPOINT = 0x10eeee;
const KITTY_PLACEHOLDER = String.fromCodePoint(KITTY_PLACEHOLDER_CODEPOINT);
const ROW_COLUMN_DIACRITIC_CODEPOINTS = Object.freeze([
  "0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357",
  "035B 0363 0364 0365 0366 0367 0368 0369 036A 036B 036C 036D 036E 036F 0483 0484",
  "0485 0486 0487 0592 0593 0594 0595 0597 0598 0599 059C 059D 059E 059F 05A0 05A1",
  "05A8 05A9 05AB 05AC 05AF 05C4 0610 0611 0612 0613 0614 0615 0616 0617 0657 0658",
  "0659 065A 065B 065D 065E 06D6 06D7 06D8 06D9 06DA 06DB 06DC 06DF 06E0 06E1 06E2",
  "06E4 06E7 06E8 06EB 06EC 0730 0732 0733 0735 0736 073A 073D 073F 0740 0741 0743",
  "0745 0747 0749 074A 07EB 07EC 07ED 07EE 07EF 07F0 07F1 07F3 0816 0817 0818 0819",
  "081B 081C 081D 081E 081F 0820 0821 0822 0823 0825 0826 0827 0829 082A 082B 082C",
  "082D 0951 0953 0954 0F82 0F83 0F86 0F87 135D 135E 135F 17DD 193A 1A17 1A75 1A76",
  "1A77 1A78 1A79 1A7A 1A7B 1A7C 1B6B 1B6D 1B6E 1B6F 1B70 1B71 1B72 1B73 1CD0 1CD1",
  "1CD2 1CDA 1CDB 1CE0 1DC0 1DC1 1DC3 1DC4 1DC5 1DC6 1DC7 1DC8 1DC9 1DCB 1DCC 1DD1",
  "1DD2 1DD3 1DD4 1DD5 1DD6 1DD7 1DD8 1DD9 1DDA 1DDB 1DDC 1DDD 1DDE 1DDF 1DE0 1DE1",
  "1DE2 1DE3 1DE4 1DE5 1DE6 1DFE 20D0 20D1 20D4 20D5 20D6 20D7 20DB 20DC 20E1 20E7",
  "20E9 20F0 2CEF 2CF0 2CF1 2DE0 2DE1 2DE2 2DE3 2DE4 2DE5 2DE6 2DE7 2DE8 2DE9 2DEA",
  "2DEB 2DEC 2DED 2DEE 2DEF 2DF0 2DF1 2DF2 2DF3 2DF4 2DF5 2DF6 2DF7 2DF8 2DF9 2DFA",
  "2DFB 2DFC 2DFD 2DFE 2DFF A66F A67C A67D A6F0 A6F1 A8E0 A8E1 A8E2 A8E3 A8E4 A8E5",
].join(" ").split(" ").map((hex) => Number.parseInt(hex, 16)));

export const KITTY_UNICODE_PLACEHOLDER = KITTY_PLACEHOLDER;
export const MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE = ROW_COLUMN_DIACRITIC_CODEPOINTS.length - 1;

export function detectKittyPassthroughMode(env = process.env) {
  if (env.KITTY_IMAGE_PREVIEW_PASSTHROUGH) return env.KITTY_IMAGE_PREVIEW_PASSTHROUGH;
  if (env.TMUX) return "tmux";
  return "none";
}

export function shouldUseInMemoryTransfer(env = process.env) {
  const forced = env.KITTY_IMAGE_PREVIEW_TRANSFER_MODE;
  if (forced && forced !== "auto") return forced === "memory" || forced === "direct";
  // In tmux, direct/in-memory transport avoids terminal-side path visibility
  // surprises while still using tmux DCS passthrough for the escape stream.
  return Boolean(env.TMUX);
}

export function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

export function textToBase64(text) {
  return Buffer.from(String(text), "utf8").toString("base64");
}

export async function fileToBase64(filePath) {
  return bufferToBase64(await readFile(filePath));
}

export function parsePngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 24) return undefined;
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return undefined;
  const chunkType = buffer.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") return undefined;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

export async function readPngDimensions(filePath) {
  const buffer = await readFile(filePath);
  return parsePngDimensions(buffer);
}

function normalizeControlValue(value) {
  if (value === undefined || value === null || value === false) return undefined;
  if (value === true) return "1";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Invalid kitty graphics numeric control value: ${value}`);
    return String(Math.trunc(value));
  }
  const stringValue = String(value);
  if (/[;,\x1b]/.test(stringValue)) {
    throw new Error(`Invalid kitty graphics control value contains a reserved character: ${stringValue}`);
  }
  return stringValue;
}

export function controlDataToString(control = {}) {
  const parts = [];
  for (const [key, rawValue] of Object.entries(control)) {
    if (!CONTROL_KEY_RE.test(key)) throw new Error(`Invalid kitty graphics control key: ${key}`);
    const value = normalizeControlValue(rawValue);
    if (value !== undefined) parts.push(`${key}=${value}`);
  }
  return parts.join(",");
}

export function wrapForPassthrough(sequence, passthrough = "auto", env = process.env) {
  const mode = passthrough === "auto" ? detectKittyPassthroughMode(env) : passthrough;
  if (mode === "tmux") {
    return `${TMUX_DCS_START}${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${TMUX_DCS_END}`;
  }
  if (mode === "none" || mode === "off" || mode === false) return sequence;
  throw new Error(`Unsupported kitty graphics passthrough mode: ${mode}`);
}

function normalizeUnsignedInteger(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid kitty graphics ${name}: ${value}`);
  return Math.trunc(number);
}

function diacriticForValue(value, name) {
  const index = normalizeUnsignedInteger(value, name);
  const codepoint = ROW_COLUMN_DIACRITIC_CODEPOINTS[index];
  if (codepoint === undefined) {
    throw new Error(`Kitty graphics ${name} ${index} exceeds Unicode placeholder limit ${MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE}`);
  }
  return String.fromCodePoint(codepoint);
}

function colorBytesForId(value, name) {
  const id = normalizeUnsignedInteger(value, name);
  const low24 = id % 0x1000000;
  return {
    id,
    low24,
    highByte: Math.floor(id / 0x1000000),
    red: (low24 >> 16) & 0xff,
    green: (low24 >> 8) & 0xff,
    blue: low24 & 0xff,
  };
}

function sgrTrueColor(prefix, value, name) {
  const color = colorBytesForId(value, name);
  return `${ESC}[${prefix};2;${color.red};${color.green};${color.blue}m`;
}

function placeholderPlacementId(placementId) {
  if (placementId === undefined || placementId === null || placementId === 0) return 0;
  const normalized = normalizeUnsignedInteger(placementId, "placeholder placement id");
  return normalized % 0x1000000 || 1;
}

export function shouldUseUnicodePlaceholders({ placementMode = "auto", passthrough = "auto", env = process.env } = {}) {
  if (placementMode === "unicode") return true;
  if (placementMode === "cursor" || placementMode === "display") return false;
  if (placementMode !== "auto") throw new Error(`Unsupported kitty graphics placement mode: ${placementMode}`);
  const mode = passthrough === "auto" ? detectKittyPassthroughMode(env) : passthrough;
  return mode === "tmux";
}

export function serializeKittyGraphicsCommand(control, payloadBase64 = "", options = {}) {
  const controlData = controlDataToString(control);
  const raw = `${APC_START}${controlData}${payloadBase64 ? ";" : ""}${payloadBase64}${APC_END}`;
  return wrapForPassthrough(raw, options.passthrough ?? "auto", options.env ?? process.env);
}

export function chunkBase64(payloadBase64, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!payloadBase64) return [""];
  const chunks = [];
  for (let offset = 0; offset < payloadBase64.length; offset += chunkSize) {
    chunks.push(payloadBase64.slice(offset, offset + chunkSize));
  }
  return chunks;
}

export function serializeKittyGraphicsChunks(control, payloadBase64 = "", options = {}) {
  const chunkSize = Math.max(512, Math.trunc(options.chunkSize ?? DEFAULT_CHUNK_SIZE));
  const chunks = chunkBase64(payloadBase64, chunkSize);
  if (chunks.length <= 1) {
    return serializeKittyGraphicsCommand(control, payloadBase64, options);
  }

  return chunks
    .map((chunk, index) => {
      const more = index < chunks.length - 1 ? 1 : 0;
      const chunkControl = index === 0 ? { ...control, m: more } : { m: more };
      return serializeKittyGraphicsCommand(chunkControl, chunk, options);
    })
    .join("");
}

export function buildPngDisplayCommand({
  imageId,
  placementId,
  pngBase64,
  filePath,
  columns,
  rows,
  zIndex,
  quiet = 2,
  passthrough = "auto",
  chunkSize,
  transmitOnly = false,
  env = process.env,
} = {}) {
  if (!pngBase64 && !filePath) throw new Error("buildPngDisplayCommand requires pngBase64 or filePath");
  const control = {
    a: transmitOnly ? "t" : "T",
    f: 100,
    t: pngBase64 ? "d" : "f",
    i: imageId,
    p: placementId,
    c: columns,
    r: rows,
    z: zIndex,
    q: quiet,
  };
  const payload = pngBase64 ?? textToBase64(filePath);
  return serializeKittyGraphicsChunks(control, payload, { passthrough, chunkSize, env });
}

export function buildPngVirtualPlacementCommand({
  imageId,
  placementId,
  pngBase64,
  filePath,
  columns,
  rows,
  quiet = 2,
  passthrough = "auto",
  chunkSize,
  env = process.env,
} = {}) {
  if (!pngBase64 && !filePath) throw new Error("buildPngVirtualPlacementCommand requires pngBase64 or filePath");
  const control = {
    a: "T",
    f: 100,
    t: pngBase64 ? "d" : "f",
    i: imageId,
    p: placeholderPlacementId(placementId),
    U: 1,
    c: columns,
    r: rows,
    q: quiet,
  };
  const payload = pngBase64 ?? textToBase64(filePath);
  return serializeKittyGraphicsChunks(control, payload, { passthrough, chunkSize, env });
}

export function buildKittyUnicodePlaceholderCell({ imageId, placementId, row = 0, column = 0, includeColumn = true } = {}) {
  const imageColor = colorBytesForId(imageId, "placeholder image id");
  const diacritics = [diacriticForValue(row, "placeholder row")];
  if (includeColumn || imageColor.highByte > 0) diacritics.push(diacriticForValue(column, "placeholder column"));
  if (imageColor.highByte > 0) diacritics.push(diacriticForValue(imageColor.highByte, "placeholder image id high byte"));
  return `${KITTY_PLACEHOLDER}${diacritics.join("")}`;
}

export function buildKittyUnicodePlaceholderLines({
  imageId,
  placementId,
  columns,
  rows,
  width = columns,
  caption = "",
} = {}) {
  const columnCount = Math.max(1, normalizeUnsignedInteger(columns ?? 1, "placeholder columns"));
  const rowCount = Math.max(1, normalizeUnsignedInteger(rows ?? 1, "placeholder rows"));
  const lineWidth = Math.max(columnCount, normalizeUnsignedInteger(width ?? columnCount, "placeholder line width"));
  const imageColor = colorBytesForId(imageId, "placeholder image id");
  diacriticForValue(imageColor.highByte, "placeholder image id high byte");
  const placementColorId = placeholderPlacementId(placementId);
  const prefix = `${sgrTrueColor(38, imageId, "placeholder image id")}${placementColorId ? sgrTrueColor(58, placementColorId, "placeholder placement id") : ""}`;
  const reset = `${ESC}[39;59m`;
  return Array.from({ length: rowCount }, (_unused, row) => {
    const firstCell = buildKittyUnicodePlaceholderCell({
      imageId,
      placementId,
      row,
      column: 0,
      includeColumn: imageColor.highByte > 0,
    });
    const placeholders = `${firstCell}${KITTY_PLACEHOLDER.repeat(Math.max(0, columnCount - 1))}`;
    const suffix = row === 0 && caption && columnCount < lineWidth
      ? ` ${String(caption).slice(0, Math.max(0, lineWidth - columnCount - 1))}`
      : "";
    const visibleLength = columnCount + suffix.length;
    return `${prefix}${placeholders}${reset}${suffix}${" ".repeat(Math.max(0, lineWidth - visibleLength))}`;
  });
}

export function buildPlaceCommand({
  imageId,
  placementId,
  columns,
  rows,
  zIndex,
  quiet = 2,
  passthrough = "auto",
  env = process.env,
} = {}) {
  return serializeKittyGraphicsCommand(
    {
      a: "p",
      i: imageId,
      p: placementId,
      c: columns,
      r: rows,
      z: zIndex,
      q: quiet,
    },
    "",
    { passthrough, env },
  );
}

export function buildDeleteCommand({
  imageId,
  placementId,
  deleteMode = imageId ? "i" : "A",
  quiet = 2,
  passthrough = "auto",
  env = process.env,
} = {}) {
  return serializeKittyGraphicsCommand(
    {
      a: "d",
      d: deleteMode,
      i: imageId,
      p: placementId,
      q: quiet,
    },
    "",
    { passthrough, env },
  );
}

export function stableKittyImageId(input) {
  // 31-bit positive integer, avoiding zero because many terminal protocols use
  // zero as an omitted/default id sentinel.
  const text = String(input ?? "kitty-image-preview");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 1) || 1;
}

export function estimateRowsForImage({ imageWidth, imageHeight, columns, maxRows = 24, minRows = 4 } = {}) {
  if (!imageWidth || !imageHeight || !columns) return Math.max(minRows, Math.min(maxRows, 16));
  // Terminal cells are usually about twice as tall as they are wide in pixel
  // terms, so an image with square pixels needs roughly half as many rows as
  // columns for a square visual footprint.
  const estimated = Math.ceil((imageHeight / imageWidth) * columns * 0.5);
  return Math.max(minRows, Math.min(maxRows, estimated));
}

export function isSupportedKittyPngPath(filePath) {
  return /\.(png|apng)$/i.test(String(filePath));
}
