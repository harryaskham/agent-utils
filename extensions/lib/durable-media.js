// Durable media core (bd-647b05): image_share, audio_share and tendril_capture
// as pi-daemon Durable tools.
//
// A Durable tool shares media with the operator by returning
// `details.media: [{ path?, data?, mimeType, title?, description? }]`. pi-daemon
// stores each item with the session, shows it to clients as an AHP `contentRef`
// (ACP `resource_link`) and gives the model only the tool's text. Image content
// blocks in a result reach both the model and clients.
//
// The archive receipts are the ones the TUI tools write: images through
// lib/shared-images.js, audio through lib/shared-audio.js, so `ag gallery`,
// `ag audio` and `ag sync` see Durable shares too. Capture goes through the same
// Tendril core as the TUI `tendril_pi_*` tools (lib/tendril-capture.js), and
// optional host playback through the audio reel's playback engine.
//
// This module never imports a Pi TUI API. Tools receive pi-daemon's
// `(args, api, context)`: `api.callId`, `api.conversationId` and `api.env`
// (the session's ExecutionEnv: `cwd` and `exec`), and `context.abortSignal`.
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactIdentity, expandStatePath, sharedAudioRoot, sharedImagesRoot } from "./artifact-state.js";
import { sharedAudioEnabled, sharedImagesEnabled } from "./privacy.js";
import { archiveSharedImage, readSharedImageFile, sniffImageMime } from "./shared-images.js";
import {
  archiveSharedAudio, decodeInlineAudio, materializeAudio, parseWavHeader, sniffAudio,
  MAX_SHARED_AUDIO_BYTES, PCM_ENCODINGS,
} from "./shared-audio.js";
import {
  PNG_MIME, captureTendrilPngWith, createNodeExec, firstCaptureDisplayWith,
  resolveTendrilTargetWith, sanitizeFilenamePart,
} from "./tendril-capture.js";
import { AUDIO_BACKENDS, AudioPlayback, describeAudioOutput, normalizeOutputPatch, resolveAudioOutput } from "../audio-reel/playback.js";

export const DURABLE_MEDIA_EXTENSION_NAME = "agent-utils-media";
export const CAPTURE_MODES = Object.freeze(["look", "share", "both"]);
/** Captures default to this width so a shared screenshot stays under pi-daemon's 2 MiB item limit. */
export const DEFAULT_CAPTURE_MAX_WIDTH = 1600;

const MAX_TITLE = 512;
const MAX_DESCRIPTION = 4096;

const text = (lines) => [{ type: "text", text: lines.filter(Boolean).join("\n") }];
const optionalText = (value, max) => typeof value === "string" && value.trim() ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").trim().slice(0, max) : undefined;
const errorText = (error) => String(error?.message || error).slice(0, 300);
const formatBytes = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KiB` : `${bytes} B`;
const formatDuration = (ms) => {
  if (!Number.isFinite(ms)) return undefined;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Absolute path of `input` (`~`, `~/…` and a leading `@` accepted) from the session's cwd. */
export function resolveSharePath(input, cwd, env = process.env) {
  let value = String(input || "").trim().replace(/^@/, "");
  if (value === "~" || value.startsWith("~/")) value = expandStatePath(value, env);
  return path.resolve(cwd || process.cwd(), value);
}

/** Strict base64 from base64, base64url or a `data:` URL, plus the URL's declared type. */
export function normalizeBase64(data) {
  if (typeof data !== "string" || !data.trim()) throw new Error("data must be a nonempty base64 string");
  let payload = data.trim(), declared;
  const url = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(payload);
  if (url) { declared = url[1] || undefined; payload = payload.slice(url[0].length); }
  payload = payload.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(payload) || payload.length % 4 === 1) throw new Error("data is not valid base64");
  return { data: payload + "=".repeat((4 - (payload.length % 4)) % 4), declared };
}

function requireOneSource(params) {
  const hasPath = typeof params.path === "string" && params.path.trim() !== "";
  const hasData = typeof params.data === "string" && params.data.trim() !== "";
  if (hasPath === hasData) throw new Error("Provide exactly one of path or data");
  return hasPath;
}

/** Read up to `limit` leading bytes of a regular file and its size. */
async function readPrefix(file, limit, maxBytes, kind) {
  const handle = await open(file, "r");
  try {
    const meta = await handle.stat();
    if (!meta.isFile()) throw new Error(`${kind} path is not a regular file`);
    if (!meta.size || meta.size > maxBytes) throw new Error(`Shared ${kind.toLowerCase()} must be 1 byte–${Math.round(maxBytes / 1048576)} MiB`);
    const prefix = Buffer.alloc(Math.min(meta.size, limit));
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return { prefix: prefix.subarray(0, bytesRead), size: meta.size };
  } finally { await handle.close(); }
}

/**
 * `exec(command, args, { signal, timeout })` → `{ code, stdout, stderr }` over a
 * Durable ExecutionEnv, so Tendril runs with the session's environment (profile
 * and session env files) in its cwd. Without an env, falls back to Node.
 */
export function durableEnvExec(executionEnv, context, fallback = createNodeExec()) {
  if (!executionEnv || typeof executionEnv.exec !== "function") return fallback;
  return async (command, args, { timeout } = {}) => {
    let stdout = "", stderr = "";
    const result = await executionEnv.exec([command, ...args], {
      ...(executionEnv.cwd ? { cwd: executionEnv.cwd } : {}),
      ...(timeout ? { timeout: Math.max(1, Math.ceil(timeout / 1000)) } : {}),
      onOutput: (chunk, _context, info) => { if (info?.stream === "stderr") stderr += chunk; else stdout += chunk; },
    }, context);
    if (!result?.ok) return { code: 127, stdout, stderr: stderr || errorText(result?.error || "command failed") };
    return { code: result.value.exitCode, stdout, stderr };
  };
}

function receiptsFor(root) {
  return { root, count: 0, stored: [], errors: [] };
}

async function storeReceipt(receipts, archive) {
  try {
    const stored = await archive();
    if (stored) { receipts.count += 1; receipts.stored.push({ id: stored.id, path: stored.path, sha256: stored.sha256 }); }
  } catch (error) { receipts.errors.push(errorText(error)); }
  return receipts;
}

function archiveLine(receipts, disabledHint, synced) {
  if (receipts.stored[0]) return `Archived as ${receipts.stored[0].id} (${synced}).`;
  if (receipts.errors[0]) return `Archive failed: ${receipts.errors[0]}`;
  return receipts.root === null ? `Archive disabled (incognito or ${disabledHint}=0).` : "";
}

/**
 * The Durable media tools over injected effects. `exec` overrides the Tendril
 * runner (default: the session's ExecutionEnv); `playback` is an AudioPlayback-like
 * `{ play(item, options), dispose() }`; `executables` maps playback program
 * names (pacat, play, ffplay, ffmpeg) to absolute paths.
 */
export function createDurableMedia({
  env = process.env,
  exec,
  archiveImage = archiveSharedImage,
  archiveAudio = archiveSharedAudio,
  playback,
  executables = {},
  spawnImpl = nodeSpawn,
  platform = process.platform,
  scratchRoot = path.join(os.tmpdir(), "pi-durable-media"),
} = {}) {
  let player = playback;
  const getPlayer = () => {
    if (player) return player;
    const spawnPackaged = (command, args, options) => spawnImpl(executables[command] || command, args, options);
    player = new AudioPlayback({ spawnImpl: spawnPackaged, env: () => env, ffmpeg: executables.ffmpeg || "ffmpeg" });
    return player;
  };

  function call(api = {}, context) {
    const executionEnv = api.env;
    const cwd = executionEnv?.cwd || process.cwd();
    const conversation = String(api.conversationId || "conversation");
    // pi-daemon does not tell a tool its session; every session's root chat is
    // conversation "1". Name the session by its directory and conversation, and
    // (without a configured agent name) the agent by its directory, so
    // different sessions' shares do not all land in one `session-1` folder.
    const place = path.basename(cwd) || "root";
    const session = `${place}-${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}:${conversation}`;
    const identity = artifactIdentity(null, { cwd, sessionManager: { getSessionId: () => session, getSessionName: () => `pi-daemon-${place}` } }, env);
    const eventId = String(api.callId || `${conversation}:${Date.now()}`);
    return {
      cwd,
      identity,
      eventId,
      signal: context?.abortSignal,
      // Tools are not told their session, so the session's cwd and conversation
      // keep one session's scratch files apart from another's.
      scratch: path.join(scratchRoot, `${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}-${sanitizeFilenamePart(conversation)}`),
      exec: exec || durableEnvExec(executionEnv, context, createNodeExec({ env })),
    };
  }

  // ---- image_share ----------------------------------------------------------
  async function shareImage(params = {}, api, context) {
    const at = call(api, context);
    const hasPath = requireOneSource(params);
    let item, archived, name, mimeType, size;
    if (hasPath) {
      const file = resolveSharePath(params.path, at.cwd, env);
      const bytes = await readSharedImageFile(file);
      mimeType = sniffImageMime(bytes, params.mimeType, file);
      size = bytes.length;
      name = path.basename(file);
      item = { path: file, mimeType };
      archived = { path: file, label: params.label };
    } else {
      const { data, declared } = normalizeBase64(params.data);
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length) throw new Error("Image data is empty");
      mimeType = sniffImageMime(bytes, params.mimeType || declared);
      size = bytes.length;
      name = `image.${mimeType.split("/")[1].replace("svg+xml", "svg").replace("jpeg", "jpg")}`;
      item = { data, mimeType };
      archived = { data, mimeType, label: params.label };
    }
    const title = optionalText(params.title, MAX_TITLE) || optionalText(params.label, MAX_TITLE) || name;
    const description = optionalText(params.description, MAX_DESCRIPTION);
    // The gallery's caption: the label, else the title the agent gave.
    archived.label = optionalText(params.label, MAX_TITLE) || optionalText(params.title, MAX_TITLE);
    const receipts = receiptsFor(sharedImagesEnabled(env) ? sharedImagesRoot(env) : null);
    if (receipts.root !== null) {
      await storeReceipt(receipts, () => archiveImage(archived, {
        ...at.identity, kind: "tool", tool: "image_share", eventId: at.eventId, index: 0, sourcePath: item.path,
      }, { env }));
    }
    return {
      content: text([
        `Shared image ${JSON.stringify(title)} (${mimeType}, ${formatBytes(size)}) with the operator.`,
        archiveLine(receipts, "PI_SHARED_IMAGES_ENABLED", "synced by ag gallery / ag sync"),
      ]),
      details: { media: [{ ...item, title, ...(description ? { description } : {}) }], sharedImages: receipts },
    };
  }

  // ---- audio_share ----------------------------------------------------------
  async function shareAudio(params = {}, api, context) {
    const at = call(api, context);
    const hasPath = requireOneSource(params);
    let item, archived, name, mimeType, size, info = {}, playPath;
    if (hasPath) {
      const file = resolveSharePath(params.path, at.cwd, env);
      const { prefix, size: fileSize } = await readPrefix(file, 1024 * 1024, MAX_SHARED_AUDIO_BYTES, "Audio");
      mimeType = sniffAudio(prefix, params.mimeType, file).mimeType;
      const wav = mimeType === "audio/wav" ? parseWavHeader(prefix, fileSize) : null;
      if (wav) info = { durationMs: wav.durationMs, sampleRate: wav.sampleRate, channels: wav.channels };
      size = fileSize;
      name = path.basename(file);
      item = { path: file, mimeType };
      archived = { path: file };
      playPath = file;
    } else {
      const inline = decodeInlineAudio({ data: params.data, mimeType: params.mimeType, pcm: params.pcm });
      mimeType = inline.mimeType;
      size = inline.bytes.length;
      const wav = mimeType === "audio/wav" ? parseWavHeader(inline.bytes.subarray(0, 1024 * 1024), inline.bytes.length) : null;
      if (wav) info = { durationMs: wav.durationMs, sampleRate: wav.sampleRate, channels: wav.channels };
      name = `${inline.pcm ? "pcm" : "clip"}.${inline.extension}`;
      // PCM arrives as WAV, so clients receive a playable container.
      item = { data: inline.bytes.toString("base64"), mimeType };
      archived = { bytes: inline.bytes, mimeType };
      if (params.play) playPath = await materializeAudio(inline.bytes, inline.extension, at.scratch);
    }
    const title = optionalText(params.title, MAX_TITLE) || optionalText(params.label, MAX_TITLE) || name;
    const description = optionalText(params.description, MAX_DESCRIPTION);
    const durationMs = info.durationMs ?? (Number.isFinite(params.durationMs) ? Math.round(params.durationMs) : undefined);
    const receipts = receiptsFor(sharedAudioEnabled(env) ? sharedAudioRoot(env) : null);
    if (receipts.root !== null) {
      await storeReceipt(receipts, () => archiveAudio({
        ...archived, label: params.label || name, title: params.title, description, mimeType, durationMs,
        sampleRate: info.sampleRate ?? params.pcm?.sampleRate, channels: info.channels ?? params.pcm?.channels,
      }, {
        ...at.identity, kind: "tool", tool: "audio_share", eventId: at.eventId, index: 0, sourcePath: hasPath ? playPath : undefined,
      }, { env }));
    }
    let playing = null, playError = null;
    if (params.play) {
      try {
        const output = normalizeOutputPatch(params.output || {});
        const snapshot = await getPlayer().play({ key: at.eventId, path: playPath, label: title, durationMs }, { output, label: title });
        playing = describeAudioOutput(snapshot?.output || resolveAudioOutput(output, env, platform));
      } catch (error) { playError = errorText(error); }
    }
    const detail = [formatDuration(durationMs), mimeType, formatBytes(size)].filter(Boolean).join(", ");
    return {
      content: text([
        `Shared audio ${JSON.stringify(title)} (${detail}) with the operator.`,
        archiveLine(receipts, "PI_SHARED_AUDIO_ENABLED", "synced by ag audio / ag sync"),
        playError ? `Host playback failed: ${playError}` : playing ? `Playing on the host via ${playing}.` : "",
      ]),
      details: {
        media: [{ ...item, title, ...(description ? { description } : {}) }],
        sharedAudio: receipts,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(playing ? { playing } : {}),
        ...(playError ? { playError } : {}),
      },
    };
  }

  // ---- tendril_capture ------------------------------------------------------
  async function capture(params = {}, api, context) {
    const at = call(api, context);
    const mode = params.mode === undefined ? "look" : String(params.mode);
    if (!CAPTURE_MODES.includes(mode)) throw new Error(`mode must be one of ${CAPTURE_MODES.join(", ")}`);
    const rawKind = String(params.kind || (params.target ? "window" : "display")).toLowerCase();
    const kind = rawKind === "screen" ? "display" : rawKind;
    if (kind !== "window" && kind !== "display") throw new Error(`Unsupported Tendril target kind: ${params.kind}. Use window, display, or screen.`);
    const override = {};
    if (params.remote !== undefined) override.remote = params.remote;
    if (params.wslTunnel !== undefined) override.wslTunnel = params.wslTunnel;
    const bridge = Object.keys(override).length ? override : undefined;
    let target;
    if (params.target) target = await resolveTendrilTargetWith(at.exec, { kind, target: params.target, override: bridge, env }, at.signal);
    else if (kind === "display") target = await firstCaptureDisplayWith(at.exec, { override: bridge, env }, at.signal);
    else throw new Error("A window capture needs a target (id or unique name/title/app substring).");
    const dir = env.TENDRIL_SHARE_SCREENSHOT_DIR ? path.resolve(at.cwd, env.TENDRIL_SHARE_SCREENSHOT_DIR) : path.join(at.scratch, "captures");
    const captured = await captureTendrilPngWith(at.exec, {
      dir, kind, target, override: bridge, env,
      maxWidth: params.maxWidth ?? DEFAULT_CAPTURE_MAX_WIDTH,
      ...(params.maxHeight !== undefined ? { maxHeight: params.maxHeight } : {}),
    }, at.signal);
    const label = captured.target.label && captured.target.label !== captured.target.id ? ` (${captured.target.label})` : "";
    const title = optionalText(params.title, MAX_TITLE) || `Tendril ${kind} ${captured.target.label || captured.target.id}`;
    const description = optionalText(params.description, MAX_DESCRIPTION);
    const receipts = receiptsFor(sharedImagesEnabled(env) ? sharedImagesRoot(env) : null);
    if (receipts.root !== null) {
      await storeReceipt(receipts, () => archiveImage({ path: captured.outputPath, label: title }, {
        ...at.identity, kind: "tool", tool: "tendril_capture", eventId: at.eventId, index: 0, sourcePath: captured.outputPath,
      }, { env }));
    }
    const look = mode !== "share", share = mode !== "look";
    const lines = [
      `Captured Tendril ${kind} ${captured.target.id}${label}.`,
      optionalText(params.prompt, 2000) ? `Focus: ${optionalText(params.prompt, 2000)}` : "",
      `Saved screenshot: ${captured.outputPath}`,
      captured.sourceMachine?.remote ? `Source machine: ${captured.sourceMachine.host}` : "",
      share ? `Shared it with the operator as ${JSON.stringify(title)}.` : "",
      look ? "" : "Image content omitted (mode=share); use mode=look or both to see it.",
    ];
    return {
      content: [
        ...text(lines),
        ...(look ? [{ type: "image", data: captured.data, mimeType: PNG_MIME }] : []),
      ],
      details: {
        mode,
        outputPath: captured.outputPath,
        target: { kind, id: captured.target.id, label: captured.target.label || captured.target.id },
        sourceMachine: captured.sourceMachine,
        sharedImages: receipts,
        ...(share ? { media: [{ path: captured.outputPath, mimeType: PNG_MIME, title, ...(description ? { description } : {}) }] } : {}),
      },
    };
  }

  const tools = [
    {
      name: "image_share",
      description: "Intentionally share an image (a diagram, chart, render or photo you made or found) with the operator. Accepts a file path or base64 data. The operator's clients show it inline in the session; you see only a confirmation. It is also archived for ag gallery / ag sync.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Image file path, relative to the session's directory (~ and leading @ accepted)." },
          data: { type: "string", description: "Base64 (or data: URL) image bytes." },
          mimeType: { type: "string", description: "Declared type when sniffing is ambiguous, e.g. image/svg+xml." },
          label: { type: "string", description: "Short label; the title when title is omitted." },
          title: { type: "string", description: "Title shown with the image. Defaults to the label or file name." },
          description: { type: "string", description: "Optional context shown with the image." },
        },
        additionalProperties: false,
      },
      execute: shareImage,
    },
    {
      name: "audio_share",
      description: "Intentionally share an audio clip (a song you made, an example sound, a recording) with the operator. Accepts a file path (WAV/MP3/OGG/Opus/FLAC/M4A/AAC/WebM/AIFF/MIDI) or base64 data: encoded file bytes, or raw PCM when pcm is set (wrapped as WAV). The operator's clients can play it from the session; it is archived for ag audio / ag sync. Plays on the host only when play=true. Not for speech.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Audio file path, relative to the session's directory (~ and leading @ accepted)." },
          data: { type: "string", description: "Base64 (or data: URL) audio. Encoded file bytes, or raw PCM when pcm is set." },
          mimeType: { type: "string", description: "Declared type when sniffing is ambiguous, e.g. audio/mpeg. audio/L16 implies raw PCM." },
          pcm: {
            type: "object",
            description: "Treat data as raw interleaved PCM and wrap it as WAV.",
            properties: {
              sampleRate: { type: "number", description: "Samples per second. Default 24000." },
              channels: { type: "number", description: "Interleaved channels 1–8. Default 1." },
              encoding: { type: "string", enum: [...PCM_ENCODINGS], description: "Little-endian sample format. Default s16le." },
            },
            additionalProperties: false,
          },
          label: { type: "string", description: "Short label; the title when title is omitted." },
          title: { type: "string", description: "Optional human title, e.g. a song name." },
          description: { type: "string", description: "Optional context shown with the clip and archived." },
          durationMs: { type: "number", description: "Known duration when it cannot be probed." },
          play: { type: "boolean", description: "Also play it on the session's host now. Defaults to false." },
          output: {
            type: "object",
            description: "One-off host output routing for play=true.",
            properties: {
              backend: { type: "string", enum: [...AUDIO_BACKENDS], description: "auto, pulse, sox or ffplay." },
              server: { type: "string", description: "Pulse server, e.g. tcp:host:4713. Empty string = local default instead of PULSE_SERVER." },
              sink: { type: "string", description: "Pulse sink / sox device name. Empty string = default sink instead of PULSE_SINK." },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      execute: shareAudio,
    },
    {
      name: "tendril_capture",
      description: "Capture a screenshot of a Tendril window or display. mode=look (default) returns the image to you to inspect; mode=share shows it to the operator in the session without adding it to your context; mode=both does both. With no target it captures the first capture-capable display. Captures are limited to 1600 px wide unless maxWidth is set.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["window", "display", "screen"], description: "Target kind; screen is an alias for display. Defaults to window with a target, display without." },
          target: { type: "string", description: "Tendril target id or unique case-insensitive name/title/app substring." },
          mode: { type: "string", enum: [...CAPTURE_MODES], description: "look: image to you. share: image to the operator. both. Defaults to look." },
          prompt: { type: "string", description: "Optional focus note included in the result text." },
          title: { type: "string", description: "Title shown to the operator for a shared capture." },
          description: { type: "string", description: "Optional context shown to the operator with a shared capture." },
          maxWidth: { type: "number", description: `Maximum screenshot width in pixels. Defaults to ${DEFAULT_CAPTURE_MAX_WIDTH}.` },
          maxHeight: { type: "number", description: "Optional maximum screenshot height in pixels." },
          remote: { type: "string", description: "Per-call Tendril --remote host. Empty string forces the local bridge." },
          wslTunnel: { type: "boolean", description: "Per-call --wsl-tunnel override for this remote host." },
        },
        additionalProperties: false,
      },
      execute: capture,
    },
  ];

  return {
    tools,
    extension: { name: DURABLE_MEDIA_EXTENSION_NAME, tools },
    dispose() { try { player?.dispose?.(); } catch {} },
  };
}
