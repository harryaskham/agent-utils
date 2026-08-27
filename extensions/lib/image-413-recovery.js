import { createHash } from "node:crypto";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";

export const IMAGE_413_ENTRY_TYPE = "agent-utils-image-413-recovery";
export const IMAGE_413_MESSAGE_TYPE = "agent-utils-image-413-message";
export const IMAGE_413_PREVIEW_DIR = ".pi/image-guard/previews";
export const IMAGE_413_ORIGINAL_DIR = ".pi/image-guard/originals";

export function isImagePayload413(status, errorMessage = "") {
  const text = String(errorMessage || "");
  return Number(status) === 413
    || /(?:OpenAI API error|HTTP(?: error)?)[^(\n]*\(413\)|\b413\b.*(?:request entity too large|payload too large)|(?:request entity too large|payload too large).*\b413\b/i.test(text);
}

export function hasImageContent(content) {
  return Array.isArray(content) && content.some((block) => block?.type === "image");
}

export function imageMessageKey(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  if (!content.some((block) => block?.type === "image")) return "";
  if (message?.toolCallId) return `tool:${message.toolCallId}`;
  const image = content.find((block) => block?.type === "image");
  if (!image) return "";
  const payload = String(image.data || image.source?.data || image.source?.path || image.path || "");
  return `image:${createHash("sha256").update(`${message.role || "unknown"}\0${payload.length}\0${payload.slice(0, 4096)}`).digest("hex").slice(0, 20)}`;
}

export function imagePathFromToolMessage(message) {
  const direct = message?.details?.path || message?.details?.originalPath || message?.details?.screenshotPath;
  if (direct) return String(direct);
  for (const block of message?.content || []) {
    if (block?.type !== "text") continue;
    const match = /(?:Saved screenshot|Saved image|Image path):\s*([^\r\n]+)/i.exec(String(block.text || ""));
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

export function latestImageToolCandidate(entries = []) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const message = entry?.type === "message" ? entry.message : entry;
    if (!hasImageContent(message?.content)) continue;
    const messageKey = imageMessageKey(message);
    if (!messageKey) continue;
    const image = message.content.find((block) => block?.type === "image");
    return {
      messageKey,
      toolCallId: message.toolCallId,
      path: imagePathFromToolMessage(message),
      imageData: image?.data || image?.source?.data || "",
      mimeType: image?.mimeType || image?.source?.mediaType || "image/png",
      toolName: message.toolName || message.role || "unknown",
    };
  }
  return null;
}

export function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function halfDimensions({ width, height }) {
  return { width: Math.max(1, Math.floor(Number(width) / 2)), height: Math.max(1, Math.floor(Number(height) / 2)) };
}

function exec(command, args, { execFileImpl = execFile, timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise) => {
    execFileImpl(command, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || ""), error });
    });
  });
}

async function dimensionsWithTools(path, options) {
  const identify = await exec("magick", ["identify", "-format", "%w %h", path], options);
  if (identify.ok) {
    const [width, height] = identify.stdout.trim().split(/\s+/).map(Number);
    if (width > 0 && height > 0) return { width, height, tool: "magick" };
  }
  const legacy = await exec("identify", ["-format", "%w %h", path], options);
  if (legacy.ok) {
    const [width, height] = legacy.stdout.trim().split(/\s+/).map(Number);
    if (width > 0 && height > 0) return { width, height, tool: "convert" };
  }
  if (process.platform === "darwin") {
    const sips = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], options);
    if (sips.ok) {
      const width = Number(/pixelWidth:\s*(\d+)/.exec(sips.stdout)?.[1]);
      const height = Number(/pixelHeight:\s*(\d+)/.exec(sips.stdout)?.[1]);
      if (width > 0 && height > 0) return { width, height, tool: "sips" };
    }
  }
  return null;
}

export async function identifyImageDimensions(path, options = {}) {
  try {
    const handle = await open(path, "r");
    try {
      const header = Buffer.alloc(24);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const png = pngDimensions(header.subarray(0, bytesRead));
      if (png) return { ...png, tool: "png-header" };
    } finally { await handle.close(); }
  } catch {}
  return dimensionsWithTools(path, options);
}

function previewName(path, info, dimensions) {
  const hash = createHash("sha256")
    .update(`${path}\0${info.size}\0${info.mtimeMs}\0${dimensions.width}x${dimensions.height}`)
    .digest("hex").slice(0, 12);
  const base = basename(path).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "image";
  return `${base}.${hash}.half.png`;
}

export async function materializeEmbeddedImage(candidate, { cwd = process.cwd(), originalDir = resolve(cwd, IMAGE_413_ORIGINAL_DIR) } = {}) {
  const data = String(candidate?.imageData || "");
  if (!data) return { ok: false, error: "embedded image data is unavailable" };
  try {
    await mkdir(originalDir, { recursive: true });
    const extension = /jpe?g/i.test(candidate?.mimeType || "") ? "jpg" : /webp/i.test(candidate?.mimeType || "") ? "webp" : "png";
    const path = join(originalDir, `${candidate.messageKey.replace(/[^a-zA-Z0-9._-]+/g, "-")}.${extension}`);
    await writeFile(path, Buffer.from(data, "base64"));
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export async function createHalfImagePreview(originalPath, {
  cwd = process.cwd(),
  previewDir = resolve(cwd, IMAGE_413_PREVIEW_DIR),
  execFileImpl = execFile,
  timeoutMs = 15_000,
} = {}) {
  const input = resolve(cwd, String(originalPath || ""));
  try {
    const [info, dimensions] = await Promise.all([stat(input), identifyImageDimensions(input, { execFileImpl, timeoutMs })]);
    if (!dimensions) return { ok: false, originalPath: input, error: "could not determine image dimensions" };
    const half = halfDimensions(dimensions);
    await mkdir(previewDir, { recursive: true });
    const output = join(previewDir, previewName(input, info, half));
    let result = await exec("magick", [input, "-auto-orient", "-resize", `${half.width}x${half.height}!`, "-strip", output], { execFileImpl, timeoutMs });
    if (!result.ok) result = await exec("convert", [input, "-auto-orient", "-resize", `${half.width}x${half.height}!`, "-strip", output], { execFileImpl, timeoutMs });
    if (!result.ok && process.platform === "darwin") {
      result = await exec("sips", ["-s", "format", "png", "-z", String(half.height), String(half.width), input, "--out", output], { execFileImpl, timeoutMs });
    }
    if (!result.ok) return { ok: false, originalPath: input, width: dimensions.width, height: dimensions.height, error: "magick/convert/sips resize failed" };
    const outputInfo = await stat(output);
    return {
      ok: true,
      originalPath: input,
      previewPath: output,
      originalWidth: dimensions.width,
      originalHeight: dimensions.height,
      width: half.width,
      height: half.height,
      bytes: outputInfo.size,
    };
  } catch (error) {
    return { ok: false, originalPath: input, error: error?.message || String(error) };
  }
}

export function imageRecoveryMessage({ errorMessage, previewPath, resizeError }) {
  const error = String(errorMessage || "413 Request Entity Too Large").replace(/[\r\n]+/g, " ").trim();
  if (previewPath) return `Image read failed: ${error}. A resized version is available at: ${previewPath}`;
  return `Image read failed: ${error}. Resizing also failed: ${String(resizeError || "no resize tool available").replace(/[\r\n]+/g, " ").trim()}`;
}

export function replaceRecoveredImageMessage(message, recovery) {
  const recoveryKey = recovery.messageKey || (recovery.toolCallId ? `tool:${recovery.toolCallId}` : "");
  if (!message || imageMessageKey(message) !== recoveryKey || !hasImageContent(message.content)) return message;
  return {
    ...message,
    content: [{ type: "text", text: recovery.message }],
    details: { ...(message.details || {}), image413Recovery: { ...recovery, replaced: true } },
  };
}
