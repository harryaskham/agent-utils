// Durable machine-local audio receipts for explicit agent audio shares.
//
// Mirrors the shared-image archive contract so `ag audio` / `ag sync` can pull
// it with the same rsync + sidecar validation: <root>/<agent>/aud-<id>.<ext>
// plus an atomically published `<file>.json` provenance sidecar (the commit
// marker). Only explicit shares reach this module; speech/TTS/narration audio
// is never captured here.
import { createHash, randomUUID } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { link, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import { sharedAudioEnabled } from "./privacy.js";
import { expandStatePath, sharedAudioRoot } from "./artifact-state.js";
import { imageAgentDirectory } from "./shared-images.js";

export const MAX_SHARED_AUDIO_BYTES = 256 * 1024 * 1024;
export const MAX_INLINE_AUDIO_BYTES = 64 * 1024 * 1024;
export const PCM_ENCODINGS = Object.freeze(["s16le", "s24le", "s32le", "f32le", "u8"]);

// Canonical MIME → archive extension. Order matters only for extension lookup.
export const AUDIO_MIME_EXTENSIONS = new Map([
  ["audio/wav", "wav"], ["audio/mpeg", "mp3"], ["audio/ogg", "ogg"], ["audio/opus", "opus"],
  ["audio/flac", "flac"], ["audio/mp4", "m4a"], ["audio/aac", "aac"], ["audio/webm", "webm"],
  ["audio/x-matroska", "mka"], ["audio/aiff", "aiff"], ["audio/midi", "mid"],
]);
const MIME_ALIASES = new Map([
  ["audio/x-wav", "audio/wav"], ["audio/wave", "audio/wav"], ["audio/vnd.wave", "audio/wav"],
  ["audio/mp3", "audio/mpeg"], ["audio/x-mp3", "audio/mpeg"], ["audio/x-flac", "audio/flac"],
  ["audio/x-m4a", "audio/mp4"], ["audio/m4a", "audio/mp4"], ["audio/x-aiff", "audio/aiff"],
  ["audio/x-midi", "audio/midi"], ["audio/mid", "audio/midi"], ["audio/x-aac", "audio/aac"],
  ["audio/x-opus", "audio/opus"],
]);
const EXTENSION_MIME = new Map([
  ["wav", "audio/wav"], ["wave", "audio/wav"], ["mp3", "audio/mpeg"], ["ogg", "audio/ogg"],
  ["oga", "audio/ogg"], ["opus", "audio/opus"], ["flac", "audio/flac"], ["m4a", "audio/mp4"],
  ["mp4", "audio/mp4"], ["aac", "audio/aac"], ["webm", "audio/webm"], ["mka", "audio/x-matroska"],
  ["aif", "audio/aiff"], ["aiff", "audio/aiff"], ["aifc", "audio/aiff"], ["mid", "audio/midi"], ["midi", "audio/midi"],
]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function normalizeAudioMime(value) {
  const mime = String(value || "").split(";")[0].trim().toLowerCase();
  return MIME_ALIASES.get(mime) || mime;
}

/// Content sniffing first; a declared audio/* type or the file extension is
/// only a fallback. Returns { mimeType, extension } or throws.
export function sniffAudio(bytes, declared, sourcePath = "") {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const ascii = (start, end) => b.subarray(start, end).toString("latin1");
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { mimeType: "audio/wav", extension: "wav" };
  if (ascii(0, 4) === "fLaC") return { mimeType: "audio/flac", extension: "flac" };
  if (ascii(0, 4) === "OggS") {
    const opus = b.subarray(0, 512).includes(Buffer.from("OpusHead"));
    return { mimeType: "audio/ogg", extension: opus ? "opus" : "ogg" };
  }
  if (ascii(0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(8, 12))) return { mimeType: "audio/aiff", extension: "aiff" };
  if (ascii(0, 4) === "MThd") return { mimeType: "audio/midi", extension: "mid" };
  if (ascii(4, 8) === "ftyp") return { mimeType: "audio/mp4", extension: "m4a" };
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return b.subarray(0, 128).includes(Buffer.from("webm"))
      ? { mimeType: "audio/webm", extension: "webm" }
      : { mimeType: "audio/x-matroska", extension: "mka" };
  }
  if (ascii(0, 3) === "ID3") return { mimeType: "audio/mpeg", extension: "mp3" };
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    // 11-bit frame sync: layer 00 is ADTS AAC, layers I–III are MPEG audio.
    return ((b[1] >> 1) & 3) === 0 ? { mimeType: "audio/aac", extension: "aac" } : { mimeType: "audio/mpeg", extension: "mp3" };
  }
  const mime = normalizeAudioMime(declared);
  if (AUDIO_MIME_EXTENSIONS.has(mime)) return { mimeType: mime, extension: AUDIO_MIME_EXTENSIONS.get(mime) };
  const fromExtension = EXTENSION_MIME.get(extname(sourcePath).slice(1).toLowerCase());
  if (fromExtension) return { mimeType: fromExtension, extension: AUDIO_MIME_EXTENSIONS.get(fromExtension) };
  throw new Error("Unsupported shared audio media type (expected WAV, MP3, OGG/Opus, FLAC, M4A/AAC, WebM, AIFF or MIDI; or raw PCM with pcm options)");
}

export function normalizePcmOptions(pcm = {}) {
  if (pcm === true) pcm = {};
  if (!pcm || typeof pcm !== "object" || Array.isArray(pcm)) throw new Error("pcm must be an object");
  const sampleRate = pcm.sampleRate === undefined ? 24000 : Number(pcm.sampleRate);
  const channels = pcm.channels === undefined ? 1 : Number(pcm.channels);
  const encoding = String(pcm.encoding || "s16le").toLowerCase();
  if (!Number.isInteger(sampleRate) || sampleRate < 1000 || sampleRate > 384000) throw new Error("pcm.sampleRate must be an integer 1000–384000");
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new Error("pcm.channels must be an integer 1–8");
  if (!PCM_ENCODINGS.includes(encoding)) throw new Error(`pcm.encoding must be one of ${PCM_ENCODINGS.join(", ")}`);
  return { sampleRate, channels, encoding };
}

const PCM_BITS = { u8: 8, s16le: 16, s24le: 24, s32le: 32, f32le: 32 };

/// Wrap raw little-endian PCM in a canonical RIFF/WAVE container (format 1 for
/// integer PCM, 3 for IEEE float). The data must be whole frames.
export function pcmToWav(pcm, options = {}) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const { sampleRate, channels, encoding } = normalizePcmOptions(options);
  const bits = PCM_BITS[encoding];
  const blockAlign = channels * (bits / 8);
  if (!data.length) throw new Error("PCM audio is empty");
  if (data.length % blockAlign !== 0) throw new Error(`PCM length ${data.length} is not a whole number of ${channels}-channel ${encoding} frames (${blockAlign} bytes)`);
  if (data.length > 0xffffffff - 44) throw new Error("PCM audio is too large for WAV");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(encoding === "f32le" ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/// Parse a RIFF/WAVE prefix. `totalBytes` bounds streamed/oversized data
/// chunk lengths. Returns null when this is not a parseable WAV.
export function parseWavHeader(prefix, totalBytes = prefix?.length ?? 0) {
  const b = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix || []);
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return null;
  let offset = 12, fmt = null;
  while (offset + 8 <= b.length) {
    const id = b.toString("latin1", offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= b.length) {
      let format = b.readUInt16LE(body);
      const bitsPerSample = b.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (format === 0xfffe && size >= 40 && body + 26 <= b.length) format = b.readUInt16LE(body + 24);
      fmt = { format, channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), blockAlign: b.readUInt16LE(body + 12), bitsPerSample };
    } else if (id === "data") {
      if (!fmt || !fmt.channels || !fmt.sampleRate || !fmt.blockAlign) return null;
      const available = Math.max(0, totalBytes - body);
      const dataBytes = Math.min(size === 0xffffffff || size === 0 ? available : size, available);
      const frames = Math.floor(dataBytes / fmt.blockAlign);
      return { ...fmt, dataOffset: body, dataBytes: frames * fmt.blockAlign, durationMs: Math.round(frames / fmt.sampleRate * 1000) };
    }
    offset = body + size + (size & 1);
  }
  return null;
}

/// Decode inline audio. `data` is base64 (optionally a data: URL). With `pcm`
/// options it is raw PCM and becomes a WAV container. Returns bytes + type.
export function decodeInlineAudio({ data, mimeType, pcm } = {}) {
  if (typeof data !== "string" || !data) throw new Error("Inline audio data must be a nonempty base64 string");
  let payload = data.trim(), declared = mimeType;
  const url = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(payload);
  if (url) { declared ||= url[1]; payload = payload.slice(url[0].length); }
  payload = payload.replace(/\s+/g, "");
  if (payload.length > Math.ceil(MAX_INLINE_AUDIO_BYTES / 3) * 4 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(payload)) throw new Error("Invalid or oversized inline audio base64 (64 MiB limit)");
  let bytes = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!bytes.length || bytes.length > MAX_INLINE_AUDIO_BYTES) throw new Error("Inline audio must decode to 1 byte–64 MiB");
  const raw = pcm !== undefined && pcm !== null && pcm !== false || /^audio\/(?:l16|pcm|x-pcm|raw)\b/i.test(String(declared || ""));
  if (raw) {
    const options = normalizePcmOptions(pcm === undefined || pcm === null ? {} : pcm);
    bytes = pcmToWav(bytes, options);
    return { bytes, mimeType: "audio/wav", extension: "wav", pcm: options };
  }
  return { bytes, ...sniffAudio(bytes, declared) };
}

export function audioInfoFromBytes(bytes, mimeType) {
  if (mimeType !== "audio/wav") return {};
  const wav = parseWavHeader(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)), bytes.length);
  return wav ? { durationMs: wav.durationMs, sampleRate: wav.sampleRate, channels: wav.channels, bitsPerSample: wav.bitsPerSample } : {};
}

export async function readAudioFile(path, max = MAX_SHARED_AUDIO_BYTES) {
  if (!(await stat(path)).isFile()) throw new Error("Shared audio source is not a regular file");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Shared audio source is not a regular file");
    if (!info.size || info.size > max) throw new Error(`Shared audio must be 1 byte–${Math.round(max / 1048576)} MiB`);
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("Shared audio changed while copying; retry the share");
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

async function syncDirectory(path) {
  const dir = await open(path, "r").catch(() => null);
  if (dir) { try { await dir.sync(); } catch {} finally { await dir.close(); } }
}

/// Write inline/transcoded bytes to a private session scratch file so the
/// player always has a local path, even when archiving is disabled.
export async function materializeAudio(bytes, extension, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `clip-${digest(bytes).slice(0, 24)}.${extension}`);
  await publish(path, bytes);
  return path;
}

const optionalText = (value, max) => typeof value === "string" && value.trim() ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").trim().slice(0, max) : undefined;
const finite = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value)) : undefined;

/// Archive explicitly shared audio. `audio` is { path } or { bytes, mimeType }
/// plus optional label/title/description/durationMs/sampleRate/channels.
export async function archiveSharedAudio(audio, provenance, { env = process.env, now = Date.now } = {}) {
  if (!sharedAudioEnabled(env)) return null;
  const sourcePath = audio.path
    ? resolve(provenance.cwd || process.cwd(), audio.path.startsWith("~") ? expandStatePath(audio.path, env) : audio.path.replace(/^@/, ""))
    : undefined;
  const bytes = sourcePath ? await readAudioFile(sourcePath) : Buffer.isBuffer(audio.bytes) ? audio.bytes : null;
  if (!bytes) throw new Error("Shared audio requires a path or decoded bytes");
  if (!bytes.length || bytes.length > MAX_SHARED_AUDIO_BYTES) throw new Error("Shared audio must be 1 byte–256 MiB");
  const { mimeType, extension } = sniffAudio(bytes, audio.mimeType, sourcePath);
  const sha256 = digest(bytes);
  const agentDirectory = imageAgentDirectory(provenance.agent);
  const shareId = digest(JSON.stringify([provenance.session, provenance.eventId, provenance.index, sha256]));
  const filename = `aud-${shareId}.${extension}`;
  const root = sharedAudioRoot(env);
  const directory = join(root, agentDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Archive agent directory must not be a symlink");
  const path = join(directory, filename);
  const detected = audioInfoFromBytes(bytes, mimeType);
  const metadata = {
    version: 1, id: `${agentDirectory}/${filename}`, sha256, mimeType, bytes: bytes.length,
    timestamp: new Date(now()).toISOString(),
    agent: provenance.agent, agentDirectory, session: provenance.session, host: provenance.host,
    cwd: provenance.cwd,
    source: { kind: provenance.kind, tool: provenance.tool, eventId: provenance.eventId, index: provenance.index, path: sourcePath || provenance.sourcePath, label: optionalText(audio.label, 512) },
    ...(optionalText(audio.title, 512) ? { title: optionalText(audio.title, 512) } : {}),
    ...(optionalText(audio.description, 4096) ? { description: optionalText(audio.description, 4096) } : {}),
    ...(finite(detected.durationMs ?? audio.durationMs) !== undefined ? { durationMs: finite(detected.durationMs ?? audio.durationMs) } : {}),
    ...(finite(detected.sampleRate ?? audio.sampleRate) ? { sampleRate: finite(detected.sampleRate ?? audio.sampleRate) } : {}),
    ...(finite(detected.channels ?? audio.channels) ? { channels: finite(detected.channels ?? audio.channels) } : {}),
  };
  // Audio bytes first; the sidecar publication is the commit marker that
  // makes the clip visible to ag. Stable event IDs keep retries idempotent.
  await publish(path, bytes);
  await publish(`${path}.json`, Buffer.from(`${JSON.stringify(metadata)}\n`));
  await syncDirectory(dirname(path));
  return { id: metadata.id, path, metadataPath: `${path}.json`, sha256, mimeType, bytes: bytes.length, durationMs: metadata.durationMs };
}
