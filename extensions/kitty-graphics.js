import { readFile } from "node:fs/promises";

const ESC = "\x1b";
const APC_START = `${ESC}_G`;
const APC_END = `${ESC}\\`;
const TMUX_DCS_START = `${ESC}Ptmux;`;
const TMUX_DCS_END = `${ESC}\\`;

const DEFAULT_CHUNK_SIZE = 4096;
const CONTROL_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

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
