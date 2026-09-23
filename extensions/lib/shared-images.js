import { sharedImagesEnabled } from "./privacy.js";
import { createHash, randomUUID } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { link, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import { expandStatePath, sharedImagesRoot } from "./artifact-state.js";

export const MAX_SHARED_IMAGE_BYTES = 64 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ["image/png", "png"], ["image/apng", "apng"], ["image/jpeg", "jpg"],
  ["image/gif", "gif"], ["image/webp", "webp"], ["image/bmp", "bmp"],
  ["image/tiff", "tiff"], ["image/svg+xml", "svg"], ["image/avif", "avif"],
  ["image/heic", "heic"], ["image/heif", "heif"], ["image/x-icon", "ico"],
]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function imageAgentDirectory(name) {
  const raw = String(name || "unknown");
  const safe = raw.normalize("NFKC").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^\.+/, "").slice(0, 80) || "agent";
  return safe === raw ? safe : `${safe}-${digest(raw).slice(0, 12)}`;
}

function imageMime(bytes, declared, sourcePath = "") {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return declared === "image/apng" ? declared : "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (bytes.subarray(0, 2).toString() === "BM") return "image/bmp";
  if (MIME_EXTENSIONS.has(declared)) return declared;
  const extension = extname(sourcePath).slice(1).toLowerCase();
  for (const [mime, ext] of MIME_EXTENSIONS) if (ext === extension || (mime === "image/jpeg" && extension === "jpeg")) return mime;
  throw new Error("Unsupported shared image media type");
}

async function readImage(path) {
  if (!(await stat(path)).isFile()) throw new Error("Shared image source is not a regular file");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Shared image source is not a regular file");
    if (!info.size || info.size > MAX_SHARED_IMAGE_BYTES) throw new Error("Shared image must be 1 byte–64 MiB");
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("Shared image changed while copying; retry the share");
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}

async function publish(path, bytes) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function archiveSharedImage(image, provenance, { env = process.env, now = Date.now } = {}) {
  if (!sharedImagesEnabled(env)) return null;
  const sourcePath = image.path
    ? resolve(provenance.cwd || process.cwd(), image.path.startsWith("~") ? expandStatePath(image.path, env) : image.path.replace(/^@/, ""))
    : undefined;
  let bytes;
  if (sourcePath) bytes = await readImage(sourcePath);
  else {
    const data = image.data;
    if (typeof data !== "string" || data.length > Math.ceil(MAX_SHARED_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) throw new Error("Invalid or oversized shared image base64");
    bytes = Buffer.from(data, "base64");
  }
  if (!bytes.length || bytes.length > MAX_SHARED_IMAGE_BYTES) throw new Error("Shared image must be 1 byte–64 MiB");
  const mimeType = imageMime(bytes, image.mimeType || image.mediaType, sourcePath);
  const sha256 = digest(bytes);
  const agentDirectory = imageAgentDirectory(provenance.agent);
  const shareId = digest(JSON.stringify([provenance.session, provenance.eventId, provenance.index, sha256]));
  const filename = `img-${shareId}.${MIME_EXTENSIONS.get(mimeType)}`;
  const root = sharedImagesRoot(env);
  const directory = join(root, agentDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Archive agent directory must not be a symlink");
  const path = join(directory, filename);
  const metadataPath = `${path}.json`;
  // Sidecar publication is the commit point: incomplete/orphaned copies are
  // never listed. Stable event IDs make retries/reloads idempotent.
  const metadata = {
    version: 1, id: `${agentDirectory}/${filename}`, sha256, mimeType, bytes: bytes.length,
    timestamp: new Date(now()).toISOString(),
    agent: provenance.agent, agentDirectory, session: provenance.session, host: provenance.host,
    cwd: provenance.cwd, source: { kind: provenance.kind, tool: provenance.tool, eventId: provenance.eventId, index: provenance.index, path: sourcePath || provenance.sourcePath, label: image.label },
    ...(Number.isFinite(image.width) ? { width: image.width } : {}),
    ...(Number.isFinite(image.height) ? { height: image.height } : {}),
  };
  await publish(path, bytes);
  await publish(metadataPath, Buffer.from(`${JSON.stringify(metadata)}\n`));
  // Files are fsynced before publication; sync the directory where supported.
  const dir = await open(dirname(path), "r").catch(() => null);
  if (dir) { try { await dir.sync(); } catch {} finally { await dir.close(); } }
  return { id: metadata.id, path, metadataPath, sha256 };
}

export function inlineSharedImages(content = []) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type === "image") {
      const data = block.data || (block.source?.type === "base64" ? block.source.data : null);
      return data ? [{ data, mimeType: block.mimeType || block.source?.mediaType || block.source?.media_type }] : [];
    }
    if (block?.type === "resource" && block.resource?.mimeType?.startsWith("image/") && block.resource.blob) {
      return [{ data: block.resource.blob, mimeType: block.resource.mimeType }];
    }
    return [];
  });
}

export function localMarkdownImages(content = []) {
  const text = typeof content === "string" ? content : (Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text || "").join("\n") : "");
  const images = [];
  for (const match of text.matchAll(/!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
    const path = match[2] || match[3];
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || path.startsWith("#")) continue;
    images.push({ path, label: match[1] });
  }
  return images;
}
