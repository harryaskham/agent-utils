// Pi Realtime Agent extension.
//
// Registers OpenAI Realtime as a real first-class Pi provider via
// `pi.registerProvider({ streamSimple })`. Selecting the model
// `openai-realtime/gpt-realtime-2` makes Pi's normal agent loop drive a
// persistent WSS realtime session: tools (built-ins, MCP, skills), system
// prompt, history persistence, approvals, compaction — all inherited from
// Pi automatically. Audio output and microphone capture are kept as a
// side-channel: when audio is enabled the realtime session also speaks the
// reply through ffplay/pacat; /rt-listen pumps mic PCM into
// `input_audio_buffer.append`. Full realtime turns trigger the Pi loop with a
// hidden custom message so `response.create` is grounded in the committed audio;
// STT-only mode forwards transcripts through `pi.sendUserMessage()`.
//
// Smoke test plan
// ---------------
//  1. /model openai-realtime/gpt-realtime-2
//  2. type "hello"                              → text reply (and audio if /rt-on)
//  3. type "list files in current dir"          → tool_call to ls/bash
//  4. type "read package.json and tell me deps" → multi-tool flow
//  5. /rt-listen vad, speak                     → committed audio → hidden custom trigger → reply
//  6. MCP tool (e.g. slack_search_messages)     → appears in tool list, callable
//  7. /skill:foo                                → pi expands first, realtime gets text
//  8. switch mid-session: /model litellm-anthropic/claude-opus-4-7 → reply →
//     /model openai-realtime/gpt-realtime-2 → prior history replayed into WSS,
//     conversation continues.
//
// Commands
// --------
//   /rt                        Switch to openai-realtime/gpt-realtime-2, audio on, pre-warm WSS.
//   /rt-on                     Enable audio output (text-and-audio modality).
//   /rt-off                    Disable audio output (text-only Realtime).
//   /rt-audio [on|off|toggle]  Same as on/off.
//   /rt-listen [ptt|vad]       Start mic capture → committed audio response.
//   /rt-stop                   Stop mic and commit PTT audio; if no mic, close WSS.
//   /rt-cancel                 Stop mic without committing audio.
//   /rt-status                 Show realtime status.
//   /rt-play [latest|rt-N]     Replay cached per-turn PCM audio.
//   /rt-reasoning <effort>     off|minimal|low|medium|high (only sent through proxy
//                              when PI_RT_SEND_REASONING=1, or when in direct-Azure mode).
//   /rt-hide-status            Hide status widget.
//
// Env
// ---
//   OPENAI_API_KEY / PI_RT_API_KEY
//   OPENAI_BASE_URL / PI_RT_BASE_URL              (default https://api.openai.com)
//   OPENAI_REALTIME_MODEL / PI_RT_MODEL           (default gpt-realtime-2)
//   OPENAI_REALTIME_TRANSCRIPTION_MODEL / PI_RT_TRANSCRIPTION_MODEL
//   OPENAI_TTS_VOICE / PI_RT_VOICE                (default marin)
//   TTS_REALTIME_BUFFER_MS / PI_RT_BUFFER_MS      initial playback prebuffer (default 180)
//   PI_RT_PLAYBACK_CHUNK_MS                       continuous jitter-buffer flush interval (default 80)
//   PI_RT_RECORD_CMD                              shell -> raw pcm16 24k mono stdout
//   PI_RT_PLAYBACK_CMD                            shell reading raw pcm16 24k mono stdin
//   PI_RT_AUDIO_BACKEND=pulse|auto|coreaudio|sox|ffplay|ffmpeg
//                                                  default pulse. This is intentional: the
//                                                  common Pi voice setup uses Pulse even on
//                                                  macOS, often with a phone as sink/source.
//                                                  Pulse honors PULSE_SERVER / PULSE_SINK /
//                                                  PULSE_SOURCE. Use auto only for local
//                                                  fallback routing outside that setup.
//   PI_RT_DISABLE_AUDIO=1                         disable playback by default
//   PI_RT_DIRECT_AZURE=1                          bypass LiteLLM proxy
//   PI_RT_AZURE_ENDPOINT                          azure cognitive services endpoint
//   PI_RT_AZURE_API_KEY                           azure key
//   PI_RT_AZURE_DEPLOYMENT                        deployment name (defaults to model)
//   PI_RT_AZURE_API_VERSION                       default 2025-04-01-preview
//   PI_RT_AZURE_PROTOCOL=v1|beta                  default v1
//   PI_RT_REASONING_EFFORT=off|minimal|low|medium|high
//   PI_RT_SEND_REASONING=1                        explicitly send reasoning.effort through proxy
//   PI_RT_VAD_THRESHOLD                           server VAD sensitivity threshold (default 0.7)
//   PI_RT_VAD_SILENCE_MS                          server VAD stop-after-silence (default 1100)
//   PI_RT_VAD_PREFIX_PADDING_MS                   server VAD prefix padding (default 300)
//   PI_RT_DEBUG=1                                 verbose event logging

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { parseEnvStyleArgs } from "./lib/env-args.js";
import { ToolSchema } from "./lib/tool-schema.js";

const RT_CUSTOM_TYPE = "realtime-agent";
const DEFAULT_MODEL = "gpt-realtime-2";
const REALTIME_API = "openai-realtime";
const REALTIME_INSTRUCTIONS_PREFIX = "You are running inside an OpenAI Realtime audio session. For microphone turns, the committed input audio is already present in the realtime conversation; the transcript visible in Pi is a UI/history trigger, not your only input. Do not tell the user you only receive text transcripts when full realtime mode is active.";
const REALTIME_AUDIO_TURN_MESSAGE = "Realtime audio input committed; starting audio-native response.";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
const DEFAULT_VOICE = "marin";

// Sensible defaults for this extension. Anything already set in the env wins,
// so users can still override per-launch. These match the recommended config
// for the canonical Pi + realtime experience: Pulse is deliberately first-class
// even on macOS because many operator setups route voice through a phone-backed
// Pulse sink/source rather than local CoreAudio devices.
function setEnvDefault(key, value) {
  if (process.env[key] === undefined || process.env[key] === "") {
    process.env[key] = value;
  }
}
setEnvDefault("PI_RT_AUDIO_BACKEND", "pulse");
setEnvDefault("PI_RT_VAD_THRESHOLD", "0.7");
setEnvDefault("PI_RT_VAD_SILENCE_MS", "1100");
setEnvDefault("PI_RT_TRANSCRIPTION_MODEL", "whisper-1");
setEnvDefault("PI_RT_TRANSCRIPTION_LANGUAGE", "en");
setEnvDefault("PI_RT_MODEL", DEFAULT_MODEL);
const REALTIME_VOICES = new Set([
  "alloy", "ash", "ballad", "coral", "echo",
  "sage", "shimmer", "verse", "marin", "cedar",
]);
const REALTIME_AUDIO_BACKENDS = new Set([
  "pulse", "pulseaudio", "pacat", "paplay", "parec",
  "auto", "coreaudio", "audiotoolbox", "sox", "rec", "play", "ffplay", "ffmpeg",
]);
const REALTIME_REASONING_EFFORTS = new Set(["off", "minimal", "low", "medium", "high"]);
const REALTIME_START_MODES = new Set(["vad", "ptt", "nolisten"]);
const REALTIME_MIC_MODES = new Set(["vad", "ptt", "off", "stop", "cancel"]);
const REALTIME_STT_MODES = new Set(["start", "vad", "ptt", "stop", "off", "cancel"]);
const REALTIME_AUDIO_MODES = new Set(["on", "off", "toggle"]);
const REALTIME_WIDGET_MODES = new Set(["show", "hide", "on", "off"]);
const REALTIME_STATUS_MODES = new Set(["compact", "full"]);
const REALTIME_LISTEN_MODES = new Set(["vad", "ptt", "continuous"]);
const REALTIME_USAGE = "Usage: /rt start [vad|ptt|nolisten], /rt stop, /rt mic [vad|ptt|off], /rt listen [vad|ptt|continuous], /rt audio [on|off|toggle], /rt stt [vad|ptt|stop], /rt widget [show|hide], /rt status [compact|full], /rt doctor, /rt voice <voice>, /rt trans <model>, /rt speed <0.25..1.5>, /rt thresh <0..1>, /rt backend <backend>, /rt reasoning <effort>, /rt summary [true|false], /rt chime [true|false]. Env-style args are also supported: /rt backend=pulse server=host:4713 source=source.bluetooth sink=... trans=gpt-realtime-whisper speed=1.1 thresh=0.85 summary=true fork=true chime=false start=vad";
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const SAMPLE_WIDTH = 2;
const TOOL_OUTPUT_CAP = 16_000;
const REALTIME_CONTEXT_WINDOW_TOKENS = 128_000;
const SUMMARY_FALLBACK_MESSAGE_CAP = 40;
const SUMMARY_FALLBACK_TEXT_CAP = 1_200;
const REALTIME_SUMMARY_TEXT_CAP = 24_000;

let realtimeWebSocketConstructor = null;
let realtimeWebSocketOpenState = 1;

export function setRealtimeWebSocketConstructor(ctor) {
  realtimeWebSocketConstructor = ctor;
  realtimeWebSocketOpenState = Number.isFinite(Number(ctor?.OPEN)) ? ctor.OPEN : 1;
  return realtimeWebSocketConstructor;
}

async function getRealtimeWebSocketConstructor() {
  if (realtimeWebSocketConstructor) return realtimeWebSocketConstructor;
  const mod = await import("ws");
  return setRealtimeWebSocketConstructor(mod.default || mod.WebSocket || mod);
}

function isRealtimeWebSocketOpen(ws) {
  return !!ws && ws.readyState === realtimeWebSocketOpenState;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function envBool(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function b64(buf) { return Buffer.from(buf).toString("base64"); }

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "https://api.openai.com").replace(/\/+$/, "").replace(/\/v1$/, "");
}

function realtimeUrl(baseUrl, model) {
  const wsBase = normalizeBaseUrl(baseUrl).replace(/^http/, "ws");
  return `${wsBase}/v1/realtime?model=${encodeURIComponent(model)}`;
}

function azureRealtimeUrl(endpoint, deployment, apiVersion, protocol = "v1") {
  const base = String(endpoint || "").replace(/\/+$/, "").replace(/^http/, "ws");
  if (protocol === "beta") {
    return `${base}/openai/realtime?api-version=${encodeURIComponent(apiVersion)}&deployment=${encodeURIComponent(deployment)}`;
  }
  return `${base}/openai/v1/realtime?model=${encodeURIComponent(deployment)}&api-version=${encodeURIComponent(apiVersion)}`;
}

function pcmBytesForMs(ms) {
  return Math.floor(SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH * ms / 1000);
}

function synthTone({ frequency = 660, durationMs = 90, gain = 0.16 } = {}) {
  const samples = Math.max(1, Math.floor(SAMPLE_RATE * durationMs / 1000));
  const pcm = Buffer.alloc(samples * SAMPLE_WIDTH);
  const fadeSamples = Math.max(1, Math.floor(samples * 0.12));
  for (let i = 0; i < samples; i++) {
    const fadeIn = Math.min(1, i / fadeSamples);
    const fadeOut = Math.min(1, (samples - i - 1) / fadeSamples);
    const envelope = Math.max(0, Math.min(fadeIn, fadeOut));
    const value = Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE) * gain * envelope;
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(value * 32767))), i * SAMPLE_WIDTH);
  }
  return pcm;
}

function concatPcm(...buffers) { return Buffer.concat(buffers.filter(Boolean)); }

function chimePcm(kind) {
  if (kind === "listen") return concatPcm(synthTone({ frequency: 660, durationMs: 70 }), synthTone({ frequency: 880, durationMs: 70 }));
  if (kind === "speech-start") return synthTone({ frequency: 880, durationMs: 85, gain: 0.14 });
  if (kind === "speech-end") return synthTone({ frequency: 440, durationMs: 90, gain: 0.14 });
  return synthTone({ frequency: 660, durationMs: 80 });
}

function truncateToolOutput(text, max = TOOL_OUTPUT_CAP) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[truncated ${s.length - max} chars]`;
}

function parseBooleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Expected boolean value, got: ${value}`);
}

function parseRealtimeSpeed(value, fallback = 1.0) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.25 || n > 1.5) throw new Error(`Expected realtime speed between 0.25 and 1.5, got: ${value}`);
  return n;
}

function parseVadThreshold(value, fallback = 0.7) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`Expected realtime VAD threshold between 0 and 1, got: ${value}`);
  return n;
}

function estimateRealtimeTokensForText(text) {
  const s = String(text ?? "");
  // Same order-of-magnitude heuristic Pi uses for preflight-style guards: a
  // token is usually ~4 chars in English/code-ish text. Add a small floor so
  // role/content wrappers are not free.
  return Math.ceil(s.length / 4) + 4;
}

function messageTextContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function messageToSummaryLine(msg) {
  if (!msg) return "";
  if (msg.role === "toolResult") {
    const out = truncateToolOutput(messageTextContent(msg.content), 500);
    return `toolResult ${msg.toolCallId || "<unknown>"}${msg.isError ? " error" : ""}: ${out}`;
  }
  const text = messageTextContent(msg.content).trim();
  if (text) return `${msg.role}: ${truncateToolOutput(text, SUMMARY_FALLBACK_TEXT_CAP)}`;
  return `${msg.role}: <non-text or empty message>`;
}

function estimateRealtimeContextTokens(context = {}) {
  let total = estimateRealtimeTokensForText(context.systemPrompt || "");
  for (const msg of context.messages || []) {
    total += estimateRealtimeTokensForText(messageTextContent(msg.content));
    if (msg.role === "toolResult") total += estimateRealtimeTokensForText(msg.toolCallId || "");
  }
  for (const tool of context.tools || []) {
    total += estimateRealtimeTokensForText(JSON.stringify(tool));
  }
  return total;
}

function extractExistingCompactionSummaries(messages = []) {
  const summaries = [];
  for (const msg of messages) {
    const text = messageTextContent(msg.content);
    if (!text) continue;
    const matches = [...text.matchAll(/<summary>\n?([\s\S]*?)\n?<\/summary>/g)];
    for (const match of matches) {
      const summary = String(match[1] || "").trim();
      if (summary) summaries.push(summary);
    }
  }
  return summaries;
}

function capRealtimeSummaryText(text) {
  const s = String(text || "");
  if (s.length <= REALTIME_SUMMARY_TEXT_CAP) return s;
  return `${s.slice(0, REALTIME_SUMMARY_TEXT_CAP)}\n\n[realtime summary truncated ${s.length - REALTIME_SUMMARY_TEXT_CAP} chars]`;
}

function buildRealtimeSummaryText(messages = []) {
  const existing = extractExistingCompactionSummaries(messages);
  if (existing.length) {
    return capRealtimeSummaryText([
      "Realtime compact context mode is enabled. Use this existing Pi compaction/branch summary as prior conversation context instead of full history. This is background context only; do not read it aloud or answer it directly.",
      ...existing.slice(-2).map((summary, idx, arr) => `\n## Summary ${idx + 1}/${arr.length}\n${summary}`),
    ].join("\n"));
  }

  const lines = messages.slice(-SUMMARY_FALLBACK_MESSAGE_CAP).map(messageToSummaryLine).filter(Boolean);
  return capRealtimeSummaryText([
    "Realtime compact context mode is enabled. No saved Pi compaction summary was present in the model context, so this is a compact role-by-role fallback summary of recent history instead of full replay. This is background context only; do not read it aloud or answer it directly.",
    `Included recent messages: ${lines.length}/${messages.length}`,
    "",
    ...lines,
  ].join("\n"));
}

function splitCurrentTurn(messages = []) {
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  if (lastUserIndex === -1) return { history: messages, currentTurn: [] };
  return { history: messages.slice(0, lastUserIndex), currentTurn: messages.slice(lastUserIndex) };
}

function estimateRealtimeSummaryContextTokens(context = {}) {
  const { history, currentTurn } = splitCurrentTurn(context.messages || []);
  const summaryText = buildRealtimeSummaryText(history);
  return estimateRealtimeContextTokens({
    systemPrompt: `${context.systemPrompt || ""}\n\n${summaryText}`,
    tools: context.tools || [],
    messages: currentTurn,
  });
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0.0s";
  return `${(ms / 1000).toFixed(1)}s`;
}

function audioDurationMs(buffer) {
  return Math.round((buffer.length / (SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH)) * 1000);
}

async function eventDataToString(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data && typeof data.text === "function") return await data.text();
  return String(data);
}

function numberEnv(name, fallback) {
  const value = Number(env(name) ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function shouldAutoRestartMicMode(mode) {
  return mode === "vad" || mode === "continuous";
}

function agentBaseDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function agentSettingsPath() {
  return join(agentBaseDir(), "settings.json");
}

function realtimeDevLinkDir() {
  return join(agentBaseDir(), "extensions", "agent-utils-realtime-dev");
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateAgentUtilsCheckout(path) {
  const root = resolve(path || ".");
  const packageJson = join(root, "package.json");
  const realtimeExtension = join(root, "extensions", "realtime-agent.js");
  if (!existsSync(packageJson)) throw new Error(`No package.json found at ${root}`);
  if (!existsSync(realtimeExtension)) throw new Error(`No realtime extension found at ${realtimeExtension}`);
  const pkg = readJsonFile(packageJson);
  if (pkg.name !== "agent-utils") throw new Error(`Expected package.json name "agent-utils" at ${root}, got ${pkg.name || "<missing>"}`);
  return { root, realtimeExtension };
}

function installRealtimeDevLink(sourceRoot) {
  const source = validateAgentUtilsCheckout(sourceRoot);
  const linkDir = realtimeDevLinkDir();
  rmSync(linkDir, { recursive: true, force: true });
  mkdirSync(linkDir, { recursive: true });
  writeFileSync(join(linkDir, "package.json"), `${JSON.stringify({
    name: "agent-utils-realtime-dev",
    private: true,
    pi: { extensions: ["./extensions/realtime-agent.js"] },
  }, null, 2)}\n`);
  symlinkSync(join(source.root, "extensions"), join(linkDir, "extensions"), "dir");
  return { linkDir, sourceRoot: source.root, extension: source.realtimeExtension };
}

function removeRealtimeDevLink() {
  const linkDir = realtimeDevLinkDir();
  const existed = existsSync(linkDir);
  rmSync(linkDir, { recursive: true, force: true });
  return { linkDir, existed };
}

function realtimeDevLinkStatus() {
  const linkDir = realtimeDevLinkDir();
  const extensionLink = join(linkDir, "extensions");
  if (!existsSync(linkDir)) return { linkDir, linked: false };
  let target = null;
  try {
    const stat = lstatSync(extensionLink);
    if (stat.isSymbolicLink()) target = readlinkSync(extensionLink);
  } catch {}
  return { linkDir, linked: true, target, extension: join(extensionLink, "realtime-agent.js") };
}

function readDefaultModelSettings() {
  const path = agentSettingsPath();
  try {
    if (!existsSync(path)) return null;
    const json = JSON.parse(readFileSync(path, "utf8"));
    return { path, provider: json.defaultProvider, model: json.defaultModel };
  } catch { return null; }
}

function restoreDefaultModelSettings(snapshot) {
  if (!snapshot?.path) return;
  try {
    if (!existsSync(snapshot.path)) return;
    const json = JSON.parse(readFileSync(snapshot.path, "utf8"));
    if (snapshot.provider !== undefined) json.defaultProvider = snapshot.provider;
    if (snapshot.model !== undefined) json.defaultModel = snapshot.model;
    writeFileSync(snapshot.path, `${JSON.stringify(json, null, 2)}\n`);
  } catch {}
}

function restoreDefaultModelSettingsSoon(snapshot) {
  restoreDefaultModelSettings(snapshot);
  setTimeout(() => restoreDefaultModelSettings(snapshot), 50).unref?.();
  setTimeout(() => restoreDefaultModelSettings(snapshot), 250).unref?.();
}

export function buildServerVadTurnDetection(options = {}) {
  return {
    type: "server_vad",
    create_response: false,
    interrupt_response: true,
    threshold: options.threshold ?? numberEnv("PI_RT_VAD_THRESHOLD", 0.7),
    prefix_padding_ms: options.prefixPaddingMs ?? numberEnv("PI_RT_VAD_PREFIX_PADDING_MS", 300),
    silence_duration_ms: options.silenceMs ?? numberEnv("PI_RT_VAD_SILENCE_MS", 1100),
  };
}

// ---------------------------------------------------------------------------
// AssistantMessageEventStream — minimal hand-rolled fallback that matches
// pi-ai's protocol. We avoid importing @mariozechner/pi-ai because it is not
// declared in extensions/package.json; pi's loader resolves it at runtime
// for handler arguments but not for our `import`.  Keeping a local impl is
// also nice for stability.
// ---------------------------------------------------------------------------

class AssistantMessageEventStream {
  constructor() {
    this._queue = [];
    this._waiting = [];
    this._done = false;
    this._finalResult = null;
    this._finalResolve = null;
    this._finalPromise = new Promise((r) => (this._finalResolve = r));
  }

  push(event) {
    if (this._done) return;
    if (event.type === "done" || event.type === "error") {
      this._done = true;
      const final = event.type === "done" ? event.message : event.error;
      this._finalResult = final;
      this._finalResolve(final);
    }
    const waiter = this._waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this._queue.push(event);
  }

  end(result) {
    this._done = true;
    if (result !== undefined && this._finalResolve) {
      this._finalResult = result;
      this._finalResolve(result);
    }
    while (this._waiting.length > 0) {
      const w = this._waiting.shift();
      w({ value: undefined, done: true });
    }
  }

  result() { return this._finalPromise; }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this._queue.length > 0) {
        yield this._queue.shift();
      } else if (this._done) {
        return;
      } else {
        const r = await new Promise((resolve) => this._waiting.push(resolve));
        if (r.done) return;
        yield r.value;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Audio backend selection (kept identical to previous version)
// ---------------------------------------------------------------------------

function defaultRecordCommand() {
  if (process.env.PI_RT_RECORD_CMD) return process.env.PI_RT_RECORD_CMD;
  const backend = (process.env.PI_RT_AUDIO_BACKEND || "").toLowerCase();
  const inputDevice = process.env.PI_RT_INPUT_DEVICE || process.env.PI_RT_MIC_DEVICE || "0";
  if (["pulse", "pulseaudio", "pacat", "parec"].includes(backend)) {
    return "parec --raw --format=s16le --rate=24000 --channels=1";
  }
  if (["sox", "rec"].includes(backend)) {
    return "rec -q -t raw -b 16 -e signed-integer -r 24000 -c 1 -";
  }
  if (["coreaudio", "audiotoolbox", "ffmpeg"].includes(backend)) {
    // avfoundation audio input indexes can be listed with:
    //   ffmpeg -f avfoundation -list_devices true -i ""
    // Index 0 is often the current/default input, but macOS does not expose a
    // stable "default" token here. Override with PI_RT_INPUT_DEVICE.
    return `ffmpeg -hide_banner -loglevel error -f avfoundation -i ':${inputDevice}' -ac 1 -ar 24000 -f s16le -`;
  }
  if (process.env.PULSE_SERVER) {
    return "parec --raw --format=s16le --rate=24000 --channels=1";
  }
  return "rec -q -t raw -b 16 -e signed-integer -r 24000 -c 1 -";
}

function defaultPlaybackCommand() {
  if (process.env.PI_RT_PLAYBACK_CMD) return process.env.PI_RT_PLAYBACK_CMD;
  const backend = (process.env.PI_RT_AUDIO_BACKEND || "").toLowerCase();
  const outDevice = process.env.PI_RT_OUTPUT_DEVICE || process.env.PI_RT_SPEAKER_DEVICE || "";
  // Explicit backend always wins over PULSE_SERVER. The default is explicitly
  // set to pulse above; only the separate auto mode should infer Pulse merely
  // because PULSE_SERVER exists.
  if (["pulse", "pulseaudio", "pacat", "paplay"].includes(backend)) {
    return "pacat --playback --raw --format=s16le --rate=24000 --channels=1";
  }
  if (backend === "sox" || backend === "play") {
    return "play -q -t raw -b 16 -e signed-integer -r 24000 -c 1 -";
  }
  if (backend === "audiotoolbox") {
    // ffmpeg's AudioToolbox muxer allows picking a CoreAudio output device by
    // index. List devices via /rt-devices. Without an explicit device the
    // system default output is used.
    const idx = outDevice ? `-audio_device_index ${outDevice} ` : "";
    return `ffmpeg -hide_banner -loglevel error -f s16le -ar 24000 -ac 1 -i - -f audiotoolbox ${idx}-`;
  }
  if (["coreaudio", "ffplay", "ffmpeg"].includes(backend)) {
    // ffplay routes through SDL/CoreAudio and follows the macOS system default
    // output. ffmpeg 8 ffplay no longer accepts `-ac 1`; use `-ch_layout mono`.
    return "ffplay -nodisp -autoexit -loglevel error -f s16le -ar 24000 -ch_layout mono -i -";
  }
  if (process.env.PULSE_SERVER) {
    return "pacat --playback --raw --format=s16le --rate=24000 --channels=1";
  }
  return "ffplay -nodisp -autoexit -loglevel error -f s16le -ar 24000 -ch_layout mono -i -";
}

function runShellStream(command) {
  const proc = spawn("/bin/sh", ["-lc", command], { stdio: ["pipe", "pipe", "pipe"] });
  // Default error handlers so an EPIPE / exit never bubbles into an
  // Unhandled 'error' event that takes down the host.
  proc.on("error", () => {});
  proc.stdin?.on("error", () => {});
  proc.stdout?.on("error", () => {});
  proc.stderr?.on("error", () => {});
  return proc;
}

function playPcmBuffer(buffer, command, notify, debug = false) {
  return new Promise((resolve) => {
    const proc = runShellStream(command || defaultPlaybackCommand());
    proc.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s && debug) notify?.(`replay: ${s}`, "warning");
    });
    proc.on("exit", () => resolve());
    proc.on("close", () => resolve());
    try {
      proc.stdin.write(buffer);
      proc.stdin.end();
    } catch {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// AudioPlayer — buffered PCM16 playback
// ---------------------------------------------------------------------------

class AudioPlayer {
  constructor(config, notify) {
    this.config = config;
    this.notify = notify;
    this.proc = null;
    this.buffer = [];
    this.bufferBytes = 0;
    this.flushed = false;
    this.flushTimer = null;
  }

  get enabled() { return !!this.config.audioEnabled; }

  clearFlushTimer() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  resetResponse() {
    this.clearFlushTimer();
    this.buffer = [];
    this.bufferBytes = 0;
    this.flushed = false;
  }

  ensureProcess() {
    if (!this.enabled) return null;
    if (this.proc && !this.proc.killed && this.proc.stdin?.writable) return this.proc;
    const cmd = this.config.playbackCommand || defaultPlaybackCommand();
    this.proc = runShellStream(cmd);
    this.proc.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s) {
        // Never notify from playback stderr. ffplay/pacat can emit repeated
        // diagnostics per chunk; surfacing them as Pi notifications can clutter
        // the UI and, in some modes, perturb the turn loop. Keep for /rt-status.
        this.config.lastPlaybackError = s;
      }
    });
    this.config.lastPlaybackCommand = cmd;
    this.config.lastPlaybackStartedAt = Date.now();
    this.proc.on("exit", (code, signal) => {
      this.config.lastPlaybackExit = `${code ?? "?"}${signal ? `/${signal}` : ""}`;
      this.proc = null;
    });
    return this.proc;
  }

  play(chunk) {
    if (!this.enabled || !chunk || chunk.length === 0) return;
    this.buffer.push(chunk);
    this.bufferBytes += chunk.length;

    // Initial prebuffer absorbs startup jitter before we begin writing to the
    // playback process. After that, keep batching continuously; realtime audio
    // deltas can be very small and writing each one separately to ffplay/pacat
    // is prone to choppy output.
    const bufferMs = Number(this.config.bufferMs || 0);
    if (!this.flushed && bufferMs > 0 && this.bufferBytes < pcmBytesForMs(bufferMs)) return;

    if (!this.flushed) {
      this.flushed = true;
      this.drainBuffer();
      this.ensureFlushTimer();
      return;
    }

    this.ensureFlushTimer();
    const maxBufferedMs = Math.max(bufferMs || 0, Number(this.config.playbackChunkMs || 80) * 3);
    if (maxBufferedMs > 0 && this.bufferBytes >= pcmBytesForMs(maxBufferedMs)) {
      this.drainBuffer();
    }
  }

  ensureFlushTimer() {
    if (this.flushTimer || !this.enabled) return;
    const interval = Math.max(20, Number(this.config.playbackChunkMs || 80));
    this.flushTimer = setInterval(() => this.drainBuffer(), interval);
    this.flushTimer.unref?.();
  }

  drainBuffer() {
    if (this.bufferBytes <= 0) return;
    const joined = Buffer.concat(this.buffer, this.bufferBytes);
    this.buffer = [];
    this.bufferBytes = 0;
    this.write(joined);
  }

  flush() {
    if (!this.enabled) return;
    this.drainBuffer();
    this.clearFlushTimer();
  }

  write(chunk) {
    const proc = this.ensureProcess();
    if (!proc?.stdin?.writable) return;
    try { proc.stdin.write(chunk); } catch {}
  }

  interrupt() {
    this.clearFlushTimer();
    this.buffer = [];
    this.bufferBytes = 0;
    this.flushed = false;
    if (this.proc) {
      try { this.proc.kill("SIGKILL"); } catch {}
      this.proc = null;
    }
  }

  close() {
    this.clearFlushTimer();
    if (this.proc) {
      try { this.proc.stdin?.end(); } catch {}
      try { this.proc.kill("SIGTERM"); } catch {}
      this.proc = null;
    }
  }
}

// ---------------------------------------------------------------------------
// RealtimeStateController — single explicit lifecycle state for connection,
// microphone, visible phase, and widget visibility. Runtime config still owns
// tunable settings such as model, voice, and audio enablement; this controller
// owns the session state machine that the UI and commands observe.
// ---------------------------------------------------------------------------

export class RealtimeStateController {
  constructor() {
    this.connection = "off";             // off|connecting|connected|error
    this.phase = "idle";                 // idle|connecting|thinking|speaking|recording|transcribing(STT-only)|replaying|error
    this.micMode = null;                 // null|ptt|vad|continuous
    this.widgetVisible = false;
  }

  setConnection(connection) {
    this.connection = connection || "off";
    if (this.connection === "connecting") this.phase = "connecting";
    if (this.connection === "off" && this.phase !== "replaying") this.phase = "idle";
    if (this.connection === "error") this.phase = "error";
  }

  setPhase(phase) {
    this.phase = phase || "idle";
    if (this.phase === "connecting") this.connection = "connecting";
    if (this.phase === "error") this.connection = "error";
  }

  setMicMode(mode) { this.micMode = mode || null; }
  setWidgetVisible(visible) { this.widgetVisible = !!visible; }

  get connected() { return this.connection === "connected"; }
  get connecting() { return this.connection === "connecting"; }

  mode({ sttOnly = false } = {}) {
    if (this.connection === "off") return "off";
    if (this.connection === "connecting") return "connecting";
    if (this.connection === "error") return "error";
    if (this.phase === "recording" && this.micMode) return sttOnly ? `stt:${this.micMode}` : `listen:${this.micMode}`;
    if (this.phase === "transcribing") return "transcribing";
    if (this.phase === "thinking") return "responding";
    if (this.phase === "speaking") return "speaking";
    if (this.phase === "replaying") return "replaying";
    return sttOnly ? "stt" : "connected";
  }

  snapshot(extra = {}) {
    return {
      connection: this.connection,
      connected: this.connected,
      connecting: this.connecting,
      phase: this.phase,
      micMode: this.micMode,
      widgetVisible: this.widgetVisible,
      mode: this.mode(extra),
      ...extra,
    };
  }
}

// ---------------------------------------------------------------------------
// RealtimeSession — owns the persistent WSS, translates events into
// AssistantMessageEvents.  One per Pi session; `streamSimple()` is the
// per-turn entry point.
// ---------------------------------------------------------------------------

class RealtimeSession {
  constructor(pi, config) {
    this.pi = pi;
    this.config = config;
    this.state = new RealtimeStateController();
    this.ws = null;
    this.connected = false;
    this.connecting = null;
    this.sessionShape = "beta";              // "ga" | "beta", set by session.created
    this.systemPromptApplied = null;
    this.toolsAppliedKey = null;             // hash-ish key of last tools list
    this.audioModeApplied = null;            // "audio" | "text" most recently
    this.forwardedMessageCount = 0;
    this.callIdsEmittedByModel = new Set();  // call_ids the WSS already has
    this.realtimeCallIdByOriginal = new Map();
    this.player = new AudioPlayer(config, (m, l) => this.notify(m, l));
    this.mic = null;
    this.micMode = null;
    this.lastCtx = null;
    this.lastResponseError = null;
    this.reasoningRejected = false;
    this.speedRejected = false;
    this.current = null;                     // active per-response state
    this.audioClips = new Map();             // clipId -> { id, pcm, durationMs, text, timestamp }
    this.latestClipId = null;
    this.nextClipId = 1;
    this.replayProc = null;
    // Spoken user turns are already present in the realtime conversation as
    // audio items. We still inject the transcript into Pi via pi.sendUserMessage
    // for UI/history/tool-loop purposes, but must not forward that transcript
    // back to WSS as an additional text user message.
    this.pendingSpokenTranscripts = [];
    this.spokenUserSkipCount = 0;
    this.pendingCommitTimer = null;
    this.micRestartTimer = null;
    this.micRestartAttempts = 0;
    this.pendingAudioTurnPending = false;
    this.lastMicBytes = 0;
    this.micMuteUntilTs = 0;
    this.lastTurnInputMode = null;           // null|audio|transcript|text
    this.pendingTranscriptText = "";
    this.phase = "idle";
    this.lastReasoningPayload = null;        // for reasoning auto-retry
    this.lastResponseObject = null;
    this.chimeChain = Promise.resolve();
  }

  clearMicRestartTimer() {
    if (this.micRestartTimer) {
      clearTimeout(this.micRestartTimer);
      this.micRestartTimer = null;
    }
  }

  scheduleMicRestart(reason = "microphone capture stopped") {
    this.clearMicRestartTimer();
    const mode = this.config.desiredListenMode;
    if (!this.config.autoReconnect || !this.connected || this.mic || !shouldAutoRestartMicMode(mode)) return;
    const maxAttempts = Number(env("PI_RT_MIC_RESTART_MAX_ATTEMPTS") || 20);
    if (this.micRestartAttempts >= maxAttempts) {
      this.notify(`Realtime mic stopped and restart attempts exhausted: ${reason}`, "error");
      this.updateStatus();
      return;
    }
    const attempt = ++this.micRestartAttempts;
    const delay = Math.min(10_000, 500 * (2 ** Math.max(0, attempt - 1)));
    this.notify(`Realtime mic stopped; restarting ${mode} capture in ${formatDurationMs(delay)} (${reason})`, attempt === 1 ? "warning" : "info");
    this.micRestartTimer = setTimeout(async () => {
      this.micRestartTimer = null;
      if (!this.config.autoReconnect || this.mic || !this.connected || !shouldAutoRestartMicMode(this.config.desiredListenMode)) return;
      try { await this.startMic(this.lastCtx, this.config.desiredListenMode === "continuous" ? "continuous" : "vad", { restarted: true }); }
      catch (e) { this.scheduleMicRestart(e.message || String(e)); }
    }, delay);
    this.micRestartTimer.unref?.();
    this.updateStatus();
  }

  clearReconnectTimer() {
    if (this.config.reconnectTimer) clearTimeout(this.config.reconnectTimer);
    this.config.reconnectTimer = null;
    this.config.nextReconnectAt = null;
  }

  scheduleReconnect(reason = "Realtime WebSocket closed") {
    if (!this.config.autoReconnect || this.config.reconnectTimer) return;
    const maxAttempts = Number.isFinite(this.config.reconnectMaxAttempts) ? this.config.reconnectMaxAttempts : 5;
    if ((this.config.reconnectAttempts || 0) >= maxAttempts) {
      this.config.lastDisconnectReason = `${reason}; reconnect attempts exhausted`;
      this.notify("Realtime disconnected; reconnect attempts exhausted", "error");
      this.updateStatus();
      return;
    }
    const attempt = (this.config.reconnectAttempts || 0) + 1;
    this.config.reconnectAttempts = attempt;
    this.config.lastDisconnectReason = reason;
    const baseDelay = Number.isFinite(this.config.reconnectBaseDelayMs) ? this.config.reconnectBaseDelayMs : 1000;
    const delay = Math.min(30_000, baseDelay * (2 ** Math.max(0, attempt - 1)));
    this.config.nextReconnectAt = Date.now() + delay;
    this.notify(`Realtime disconnected; reconnecting in ${formatDurationMs(delay)} (attempt ${attempt}/${maxAttempts})`, "warning");
    this.updateStatus();
    this.config.reconnectTimer = setTimeout(async () => {
      this.config.reconnectTimer = null;
      this.config.nextReconnectAt = null;
      if (!this.config.autoReconnect) return;
      try {
        await this.connect(this.lastCtx);
        const mode = this.config.desiredListenMode;
        if (mode && mode !== "off" && mode !== "nolisten" && !this.mic) {
          await this.startMic(this.lastCtx, mode === "ptt" ? "ptt" : "vad");
        }
      } catch (e) {
        this.scheduleReconnect(e.message || String(e));
      }
    }, delay);
  }

  get connected() { return this.state.connected; }
  set connected(value) { this.state.setConnection(value ? "connected" : "off"); }
  get phase() { return this.state.phase; }
  set phase(value) { this.state.setPhase(value); }
  get micMode() { return this.state.micMode; }
  set micMode(value) { this.state.setMicMode(value); }

  // -------------------------------------------------------------------------
  // Status / context
  // -------------------------------------------------------------------------

  notify(msg, level = "info") {
    try { this.lastCtx?.ui?.notify?.(msg, level); } catch {}
  }

  showTranscriptStatus(text, { pending = false, notify = false } = {}) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return;
    const line = `${pending ? "◇ … " : "◇ "}${truncateVisible(trimmed, pending ? 110 : 120)}`;
    try { this.lastCtx?.ui?.setStatus?.("rt-transcript", line); } catch {}
    if (notify) {
      try { this.lastCtx?.ui?.notify?.(line, "info"); } catch {}
    }
  }

  playChime(kind) {
    if (!this.config.chimeEnabled || !this.config.audioEnabled) return;
    const pcm = chimePcm(kind);
    const command = this.config.playbackCommand || defaultPlaybackCommand();
    this.chimeChain = this.chimeChain
      .catch(() => {})
      .then(() => playPcmBuffer(pcm, command, undefined, false).catch(() => {}));
    this.chimeChain.catch(() => {});
  }

  setPhase(phase) {
    this.phase = phase || "idle";
    this.updateStatus();
  }

  statusText() {
    const conn = this.connected ? "●" : (this.connecting ? "◐" : "○");
    const audio = this.config.audioEnabled ? "audio:on" : "audio:off";
    const mic = this.mic ? `mic:${this.micMode || "on"}` : "mic:off";
    const mode = this.state.mode({ sttOnly: this.config.sttOnly });
    const phase = mode && mode !== "off" && mode !== "connected" ? ` ${mode}` : "";
    return `${conn} rt ${this.config.model} ${audio} ${mic}${phase}`;
  }

  updateStatus(ctx = this.lastCtx) {
    try { ctx?.ui?.setStatus?.("realtime", this.statusText()); } catch {}
    try {
      if (this.config.statusWidgetVisible) {
        ctx?.ui?.setWidget?.("realtime-status", statusLines(this, this.config), { placement: "belowEditor" });
      }
    } catch {}
  }

  showStatusWidget(ctx = this.lastCtx) {
    this.config.statusWidgetVisible = true;
    this.state.setWidgetVisible(true);
    this.updateStatus(ctx);
  }

  hideStatusWidget(ctx = this.lastCtx) {
    this.config.statusWidgetVisible = false;
    this.state.setWidgetVisible(false);
    try { ctx?.ui?.setWidget?.("realtime-status", undefined); } catch {}
  }

  clearRealtimeUi(ctx = this.lastCtx) {
    this.config.statusWidgetVisible = false;
    this.state.setWidgetVisible(false);
    try { ctx?.ui?.setWidget?.("realtime-status", undefined); } catch {}
    try { ctx?.ui?.setStatus?.("realtime", undefined); } catch {}
    try { ctx?.ui?.setStatus?.("rt-audio", undefined); } catch {}
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  async connect(ctx) {
    this.lastCtx = ctx || this.lastCtx;
    this.updateStatus();
    if (this.connected && this.ws) return;
    if (this.connecting) return this.connecting;

    this.connecting = this._connect(ctx).catch((e) => {
      try { this.ws?.close(); } catch {}
      this.ws = null;
      this.connected = false;
      throw e;
    }).finally(() => {
      this.connecting = null;
      this.updateStatus();
    });
    return this.connecting;
  }

  async _connect(ctx) {
    const apiKey = this.config.directAzure
      ? env("PI_RT_AZURE_API_KEY", "AZURE_CANADACENTRAL_API_KEY", "AZURE_OPENAI_API_KEY")
      : env("PI_RT_API_KEY", "OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error(this.config.directAzure
        ? "No Azure realtime API key. Set PI_RT_AZURE_API_KEY or AZURE_CANADACENTRAL_API_KEY."
        : "No OpenAI API key. Set OPENAI_API_KEY or PI_RT_API_KEY.");
    }
    if (this.config.directAzure && !this.config.azureEndpoint) {
      throw new Error("Azure direct mode needs PI_RT_AZURE_ENDPOINT or AZURE_CANADACENTRAL_ENDPOINT.");
    }
    const url = this.config.directAzure
      ? azureRealtimeUrl(this.config.azureEndpoint, this.config.azureDeployment || this.config.model, this.config.azureApiVersion, this.config.azureProtocol)
      : realtimeUrl(this.config.baseUrl, this.config.model);
    this.setPhase("connecting");
    this.notify(`Connecting realtime: ${this.config.directAzure ? "azure:" : ""}${this.config.model}`, "info");

    const headers = this.config.directAzure
      ? { "api-key": apiKey, "User-Agent": "Python/3.13 websockets/15.0.1" }
      : {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Beta": "realtime=v1",
          // Mirror Python websockets UA — some OpenAI-compatible WS proxies
          // are sensitive to ws' default UA.
          "User-Agent": "Python/3.13 websockets/15.0.1",
        };

    const WebSocketImpl = await getRealtimeWebSocketConstructor();
    const ws = new WebSocketImpl(url, {
      perMessageDeflate: false,
      handshakeTimeout: 15000,
      headers,
    });
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("Realtime WebSocket open timed out")), 15000);
      ws.once("open", () => { clearTimeout(timer); resolveOpen(); });
      ws.once("error", (e) => { clearTimeout(timer); rejectOpen(new Error(`Realtime WebSocket error: ${e.message || "unknown"}`)); });
    });

    const first = await this.recvOnce(12000);
    if (first.type === "error") throw new Error(JSON.stringify(first.error || first));
    if (first.type !== "session.created") {
      this.notify(`Expected session.created, got ${first.type}`, "warning");
    }
    this.sessionShape =
      first.session?.type === "realtime" || first.session?.output_modalities ? "ga" : "beta";

    this.connected = true;
    this.config.reconnectAttempts = 0;
    this.config.lastDisconnectReason = null;
    this.clearReconnectTimer();
    this.setPhase("idle");
    // session.update happens lazily on the first streamSimple call once we have
    // the actual systemPrompt + tools.
    this.installReceiveLoop();
    this.notify(`Realtime connected (${this.config.model})`, "info");
  }

  recvOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws) return reject(new Error("No websocket"));
      const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for realtime event")); }, timeoutMs);
      const onMessage = async (data) => {
        cleanup();
        try { resolve(JSON.parse(await eventDataToString(data))); }
        catch (e) { reject(e); }
      };
      const onClose = () => { cleanup(); reject(new Error("WebSocket closed")); };
      const onError = (e) => { cleanup(); reject(new Error(`WebSocket error: ${e.message || "unknown"}`)); };
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("close", onClose);
        ws.off("error", onError);
      };
      ws.once("message", onMessage);
      ws.once("close", onClose);
      ws.once("error", onError);
    });
  }

  send(obj) {
    if (!isRealtimeWebSocketOpen(this.ws)) {
      throw new Error("Realtime WebSocket is not open");
    }
    this.ws.send(JSON.stringify(obj));
  }

  installReceiveLoop() {
    const ws = this.ws;
    if (!ws) return;
    ws.on("message", async (data) => {
      let msg;
      try { msg = JSON.parse(await eventDataToString(data)); }
      catch (e) { this.notify(`Bad realtime message: ${e.message}`, "warning"); return; }
      try { this.handleEvent(msg); }
      catch (e) { this.notify(`Realtime handler error: ${e.message}`, "error"); }
    });
    ws.on("close", () => {
      this.connected = false;
      this.setPhase("idle");
      this.player.close();
      this.failPending(new Error("Realtime WebSocket closed"));
      this.updateStatus();
      this.scheduleReconnect("Realtime WebSocket closed");
    });
    ws.on("error", (e) => {
      const err = new Error(`Realtime WebSocket error: ${e.message || "unknown"}`);
      this.setPhase("error");
      this.notify(err.message, "error");
      this.failPending(err);
      this.scheduleReconnect(err.message);
    });
  }

  failPending(err) {
    if (!this.current) {
      this.pendingAudioTurnPending = false;
      if (this.phase === "speaking" || this.phase === "thinking") this.setPhase("idle");
      return;
    }
    const { stream, partial } = this.current;
    partial.stopReason = "error";
    partial.errorMessage = err.message || String(err);
    stream.push({ type: "error", reason: "error", error: partial });
    stream.end(partial);
    this.current = null;
    this.pendingAudioTurnPending = false;
    if (this.phase === "speaking" || this.phase === "thinking") this.setPhase("idle");
  }

  // -------------------------------------------------------------------------
  // session.update — instructions + tools + audio mode
  // -------------------------------------------------------------------------

  toolsListKey(tools) {
    if (!tools || !tools.length) return "[]";
    return JSON.stringify(tools.map((t) => [t.name, t.description, t.parameters]));
  }

  buildToolsForRealtime(tools) {
    if (!tools || !tools.length) return [];
    return tools.map((t) => {
      // Pi tools carry TypeBox-shaped JSON schema, which is fine for realtime —
      // realtime accepts a plain Object schema with type/properties/required.
      const schema = t.parameters || { type: "object", properties: {}, required: [] };
      return {
        type: "function",
        name: t.name,
        description: t.description || "",
        parameters: {
          type: "object",
          properties: schema.properties ?? {},
          required: schema.required ?? [],
          ...(schema.additionalProperties !== undefined ? { additionalProperties: schema.additionalProperties } : {}),
        },
      };
    });
  }

  audioModeNow() {
    return this.config.audioEnabled ? "audio" : "text";
  }

  realtimeInstructions(systemPrompt = "") {
    const text = String(systemPrompt || "").trim();
    return text ? `${REALTIME_INSTRUCTIONS_PREFIX}\n\n${text}` : REALTIME_INSTRUCTIONS_PREFIX;
  }

  currentTurnDetection() {
    // Server VAD: speak, fall silent, server commits + transcribes the segment.
    // create_response stays false so Pi still owns the response turn (so tools,
    // history, approvals all flow through the normal agent loop).
    if (this.mic && (this.micMode === "vad" || this.micMode === "continuous")) {
      return buildServerVadTurnDetection({ threshold: this.config.vadThreshold });
    }
    return null;
  }

  sendTurnDetectionUpdate() {
    if (!this.connected || !isRealtimeWebSocketOpen(this.ws)) return;
    const turnDetection = this.currentTurnDetection();
    const sessionPayload = this.sessionShape === "ga"
      ? { type: "realtime", audio: { input: { turn_detection: turnDetection } } }
      : { turn_detection: turnDetection };
    try { this.send({ type: "session.update", session: sessionPayload }); } catch {}
  }

  async maybeApplySession({ systemPrompt, tools }) {
    const audioMode = this.audioModeNow();
    const toolsKey = this.toolsListKey(tools);
    const sysChanged = systemPrompt !== this.systemPromptApplied;
    const toolsChanged = toolsKey !== this.toolsAppliedKey;
    const audioChanged = audioMode !== this.audioModeApplied;
    if (!sysChanged && !toolsChanged && !audioChanged) return;

    const realtimeTools = this.buildToolsForRealtime(tools);
    const transcription = this.config.transcriptionModel
      ? {
          model: this.config.transcriptionModel,
          language: env("PI_RT_TRANSCRIPTION_LANGUAGE") || "en",
          ...(env("PI_RT_TRANSCRIPTION_PROMPT") ? { prompt: env("PI_RT_TRANSCRIPTION_PROMPT") } : {}),
        }
      : null;
    const sessionPayload = this.sessionShape === "ga"
      ? {
          type: "realtime",
          output_modalities: audioMode === "audio" ? ["audio"] : ["text"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: SAMPLE_RATE },
              transcription,
              turn_detection: this.currentTurnDetection(),
            },
            output: {
              format: { type: "audio/pcm", rate: SAMPLE_RATE },
              voice: this.config.voice,
              ...(this.config.speed && this.config.speed !== 1 ? { speed: this.config.speed } : {}),
            },
          },
          tools: realtimeTools,
          tool_choice: realtimeTools.length ? "auto" : "none",
        }
      : {
          modalities: audioMode === "audio" ? ["audio", "text"] : ["text"],
          voice: this.config.voice,
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: transcription,
          turn_detection: this.currentTurnDetection(),
          tools: realtimeTools,
          tool_choice: realtimeTools.length ? "auto" : "none",
        };

    sessionPayload.instructions = this.realtimeInstructions(systemPrompt);

    this.send({ type: "session.update", session: sessionPayload });

    this.systemPromptApplied = systemPrompt || null;
    this.toolsAppliedKey = toolsKey;
    this.audioModeApplied = audioMode;
  }

  realtimeCallId(originalId) {
    const raw = String(originalId || "");
    if (!raw) return null;
    // Tool calls emitted by the live realtime model already exist in the
    // server-side conversation under this exact call_id. Tool results must use
    // that same id; remapping them creates "tool_call_id not found" errors.
    if (this.callIdsEmittedByModel.has(raw)) return raw;
    const existing = this.realtimeCallIdByOriginal.get(raw);
    if (existing) return existing;
    if (raw.length <= 32) {
      this.realtimeCallIdByOriginal.set(raw, raw);
      return raw;
    }
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    const id = `call_${hash.toString(36)}_${this.realtimeCallIdByOriginal.size.toString(36)}`.slice(0, 32);
    this.realtimeCallIdByOriginal.set(raw, id);
    return id;
  }

  // -------------------------------------------------------------------------
  // History forwarding — push the new tail of context.messages into WSS
  // -------------------------------------------------------------------------

  textContentJoined(content) {
    if (!content) return "";
    if (typeof content === "string") return content;
    return content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }

  normalizeTranscript(text) {
    return String(text || "").trim().replace(/\s+/g, " ");
  }

  markSpokenTranscript(text) {
    const normalized = this.normalizeTranscript(text);
    if (!normalized) return;
    this.pendingSpokenTranscripts.push({ text: normalized, timestamp: Date.now() });
    this.spokenUserSkipCount += 1;
    // Bound the queue and discard stale entries.
    const cutoff = Date.now() - 5 * 60 * 1000;
    this.pendingSpokenTranscripts = this.pendingSpokenTranscripts
      .filter((t) => t.timestamp >= cutoff)
      .slice(-20);
  }

  triggerCommittedAudioTurn() {
    if (this.pendingAudioTurnPending) return;
    this.pendingAudioTurnPending = true;
    this.lastTurnInputMode = "audio";
    try {
      this.pi.sendMessage?.({
        customType: RT_CUSTOM_TYPE,
        content: REALTIME_AUDIO_TURN_MESSAGE,
        display: false,
        details: { role: "audio-turn", inputMode: "audio" },
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch (e) {
      this.notify(`sendMessage failed: ${e.message}`, "warning");
    }
  }

  consumeSpokenTranscript(text) {
    const normalized = this.normalizeTranscript(text);
    if (!normalized) return false;
    const idx = this.pendingSpokenTranscripts.findIndex((t) => t.text === normalized);
    if (idx === -1) return false;
    this.pendingSpokenTranscripts.splice(idx, 1);
    return true;
  }

  forwardMessage(msg) {
    if (msg.role === "user") {
      const text = this.textContentJoined(msg.content);
      // If this user message came from mic transcription, the realtime session
      // already has the actual audio item. Do not duplicate it as text.
      // Counter-based dedup is robust to text normalization differences between
      // the transcription event and Pi's sendUserMessage payload.
      if (this.spokenUserSkipCount > 0) {
        this.spokenUserSkipCount -= 1;
        this.consumeSpokenTranscript(text);
        return;
      }
      if (this.consumeSpokenTranscript(text)) return;
      // realtime doesn't accept image content for input — drop with a note.
      if (Array.isArray(msg.content) && msg.content.some((c) => c?.type === "image")) {
        this.notify("Realtime: dropped image content from user message (unsupported)", "warning");
      }
      if (!text.trim()) return;
      this.send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      });
      return;
    }

    if (msg.role === "assistant") {
      // Walk content in order; emit text and tool_calls separately.
      for (const c of (msg.content || [])) {
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          this.send({
            type: "conversation.item.create",
            item: { type: "message", role: "assistant", content: [{ type: "text", text: c.text }] },
          });
        } else if (c?.type === "toolCall") {
          // Skip tool_calls the model already emitted in this WSS — they
          // are already in the conversation history server-side.
          if (this.callIdsEmittedByModel.has(c.id)) continue;
          const callId = this.realtimeCallId(c.id);
          if (!callId) continue;
          this.send({
            type: "conversation.item.create",
            item: {
              type: "function_call",
              call_id: callId,
              name: c.name,
              arguments: JSON.stringify(c.arguments || {}),
            },
          });
        }
      }
      return;
    }

    if (msg.role === "toolResult") {
      const output = truncateToolOutput(this.textContentJoined(msg.content));
      const callId = this.realtimeCallId(msg.toolCallId);
      if (!callId) return;
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: msg.isError ? `[error]\n${output}` : output,
        },
      });
      return;
    }
  }

  forwardNewMessages(messages) {
    const tail = messages.slice(this.forwardedMessageCount);
    for (const msg of tail) this.forwardMessage(msg);
    this.forwardedMessageCount = messages.length;
  }

  forwardSummaryMessages(messages) {
    if (this.forwardedMessageCount > 0) {
      this.forwardNewMessages(messages);
      return;
    }
    const { currentTurn } = splitCurrentTurn(messages);
    for (const msg of currentTurn) this.forwardMessage(msg);
    this.forwardedMessageCount = messages.length;
  }

  // -------------------------------------------------------------------------
  // streamSimple — main entry point. Pi calls this once per turn.
  // -------------------------------------------------------------------------

  streamSimple(model, context, options) {
    // We must return synchronously; do the async part in an IIFE.
    const stream = new AssistantMessageEventStream();
    this._driveTurn(model, context, options, stream).catch((e) => {
      const partial = this._makeBasePartial(model);
      partial.stopReason = "error";
      partial.errorMessage = e?.message || String(e);
      stream.push({ type: "error", reason: "error", error: partial });
      stream.end(partial);
    });
    return stream;
  }

  _makeBasePartial(model) {
    return {
      role: "assistant",
      content: [],
      api: REALTIME_API,
      provider: "openai-realtime",
      model: model?.id || this.config.model,
      responseModel: undefined,
      responseId: undefined,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  async _driveTurn(model, context, options, stream) {
    // 0. Safety: refuse to drive non-realtime models. Pi shouldn't route them
    // here based on provider registration, but if a stale model selection or
    // misconfig points at us, fail loudly instead of opening a WSS to a
    // non-realtime model id.
    if (!isRealtimeModel(model)) {
      const partial = this._makeBasePartial(model);
      partial.stopReason = "error";
      partial.errorMessage = `realtime-agent: model ${model?.provider}/${model?.id} is not a realtime model`;
      stream.push({ type: "error", reason: "unsupported", error: partial });
      stream.end(partial);
      return;
    }
    // The Pi-selected model is authoritative. Env vars only provide the
    // startup default; if the user runs `/model openai-realtime/gpt-realtime-2`
    // we must connect the WSS to that exact model, not OPENAI_REALTIME_MODEL.
    const selectedModel = model?.id || this.config.model || DEFAULT_MODEL;
    if (selectedModel !== this.config.model) {
      const wasConnected = this.connected;
      if (wasConnected) await this.close(false);
      this.config.model = selectedModel;
      // In non-explicit Azure mode, keep deployment aligned with the selected
      // model. If PI_RT_AZURE_DEPLOYMENT was set, leave it alone.
      if (!env("PI_RT_AZURE_DEPLOYMENT", "AZURE_CANADACENTRAL_DEPLOYMENT")) {
        this.config.azureDeployment = selectedModel;
      }
    }

    const contextWindow = Number(model?.contextWindow || REALTIME_CONTEXT_WINDOW_TOKENS);
    const fullContextTokens = estimateRealtimeContextTokens(context || {});
    const estimatedTokens = this.config.summaryContext ? estimateRealtimeSummaryContextTokens(context || {}) : fullContextTokens;
    if (estimatedTokens > contextWindow) {
      const mode = this.config.summaryContext ? "summary context" : "full history";
      const advice = this.config.summaryContext
        ? "Compact the Pi session first or reduce the current turn before retrying realtime."
        : "Run /rt summary=true to send a compact summary instead of full history.";
      const message = `Realtime ${mode} is too large for ${selectedModel}: estimated ${estimatedTokens.toLocaleString()} tokens exceeds ${contextWindow.toLocaleString()} token context. ${advice}`;
      this.notify(message, "error");
      throw new Error(message);
    }

    // 1. Ensure WSS
    if (!this.connected) await this.connect(this.lastCtx);

    // 2. session.update if anything changed
    const { history: summaryHistory } = this.config.summaryContext ? splitCurrentTurn(context?.messages || []) : { history: [] };
    const summaryText = this.config.summaryContext ? buildRealtimeSummaryText(summaryHistory) : "";
    const systemPrompt = summaryText.trim()
      ? `${context?.systemPrompt || ""}\n\n${summaryText}`
      : (context?.systemPrompt || "");
    await this.maybeApplySession({
      systemPrompt,
      tools: context?.tools || [],
    });

    // 3. Forward new messages
    if (this.config.summaryContext) this.forwardSummaryMessages(context?.messages || []);
    else this.forwardNewMessages(context?.messages || []);

    // 4. Build per-response state
    const partial = this._makeBasePartial(model);
    const state = {
      stream,
      partial,
      // Tracks open content blocks
      currentTextIndex: -1,
      audioTranscriptOpen: false,        // are we streaming via audio_transcript
      plainTextOpen: false,              // ...or via output_text
      toolBlocks: new Map(),             // call_id -> { contentIndex, argString }
      responseId: null,
      audioChunks: [],                   // raw PCM16 chunks for /rt-play
      audioBytes: 0,
      cancelled: false,
    };
    this.current = state;
    this.player.resetResponse();
    this.setPhase("thinking");

    // 5. Push start event
    stream.push({ type: "start", partial });

    // 6. Wire abort
    if (options?.signal) {
      const onAbort = () => {
        state.cancelled = true;
        try { this.send({ type: "response.cancel" }); } catch {}
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    // 7. response.create
    const responseObj = this._makeResponseObject();
    this.lastResponseObject = responseObj;
    this.send({ type: "response.create", response: responseObj });
    this.updateStatus();
  }

  _makeResponseObject() {
    const audioMode = this.audioModeNow();
    const response = this.sessionShape === "ga"
      ? { output_modalities: audioMode === "audio" ? ["audio"] : ["text"] }
      : { modalities: audioMode === "audio" ? ["audio", "text"] : ["text"] };
    if (this.config.speed && this.config.speed !== 1 && !this.speedRejected) response.speed = this.config.speed;

    const sendReasoning = this.config.sendReasoning
      || (this.config.directAzure && (this.config.azureProtocol === "v1" || this.config.azureProtocol === "GA"));
    if (
      sendReasoning &&
      !this.reasoningRejected &&
      this.config.reasoningEffort &&
      this.config.reasoningEffort !== "off"
    ) {
      response.reasoning = { effort: this.config.reasoningEffort };
    }
    return response;
  }

  // -------------------------------------------------------------------------
  // Event translation: realtime → AssistantMessageEvent
  // -------------------------------------------------------------------------

  _openTextBlock(state, source) {
    if (state.currentTextIndex !== -1) return;
    const block = { type: "text", text: "" };
    state.partial.content.push(block);
    state.currentTextIndex = state.partial.content.length - 1;
    if (source === "audio") state.audioTranscriptOpen = true;
    else state.plainTextOpen = true;
    state.stream.push({ type: "text_start", contentIndex: state.currentTextIndex, partial: state.partial });
  }

  _appendText(state, delta, source) {
    if (!delta) return;
    // Decide which text stream "owns" this block.  When audio is enabled, we
    // prefer the audio_transcript stream for the user-visible text and ignore
    // the (usually-empty) plain text.  When audio is disabled, the model
    // emits plain text only.
    if (this.config.audioEnabled && source === "text") return;
    if (!this.config.audioEnabled && source === "audio") return;

    this._openTextBlock(state, source);
    const block = state.partial.content[state.currentTextIndex];
    block.text += delta;
    state.stream.push({
      type: "text_delta",
      contentIndex: state.currentTextIndex,
      delta,
      partial: state.partial,
    });
  }

  _closeTextBlock(state) {
    if (state.currentTextIndex === -1) return;
    const idx = state.currentTextIndex;
    const block = state.partial.content[idx];
    state.stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: state.partial });
    state.currentTextIndex = -1;
    state.audioTranscriptOpen = false;
    state.plainTextOpen = false;
  }

  _openToolBlock(state, item) {
    const callId = item.call_id || item.id;
    if (!callId) return;
    if (state.toolBlocks.has(callId)) return;
    // Close any pending text block and flush any spoken preamble before starting
    // tool calls. Without this, the buffered "I'll check..." audio can start
    // after the tool result, which sounds backwards to the operator.
    this._closeTextBlock(state);
    this.player.flush();
    const block = { type: "toolCall", id: callId, name: item.name || "", arguments: {} };
    state.partial.content.push(block);
    const contentIndex = state.partial.content.length - 1;
    state.toolBlocks.set(callId, { contentIndex, argString: "", name: item.name || "" });
    state.stream.push({ type: "toolcall_start", contentIndex, partial: state.partial });
  }

  _appendToolArgs(state, callId, delta, name) {
    if (!callId) return;
    let entry = state.toolBlocks.get(callId);
    if (!entry) {
      this._openToolBlock(state, { call_id: callId, name });
      entry = state.toolBlocks.get(callId);
      if (!entry) return;
    }
    if (name && !entry.name) {
      entry.name = name;
      state.partial.content[entry.contentIndex].name = name;
    }
    entry.argString += delta || "";
    if (delta) {
      state.stream.push({
        type: "toolcall_delta",
        contentIndex: entry.contentIndex,
        delta,
        partial: state.partial,
      });
    }
  }

  _closeToolBlock(state, callId, finalArgsString, finalName) {
    const entry = state.toolBlocks.get(callId);
    if (!entry) return;
    if (finalName) entry.name = finalName;
    if (finalArgsString) entry.argString = finalArgsString;
    let parsedArgs = {};
    try { parsedArgs = entry.argString ? JSON.parse(entry.argString) : {}; }
    catch { parsedArgs = { __parse_error: true, raw: entry.argString }; }
    const block = state.partial.content[entry.contentIndex];
    block.name = entry.name;
    block.arguments = parsedArgs;
    this.callIdsEmittedByModel.add(callId);
    state.stream.push({
      type: "toolcall_end",
      contentIndex: entry.contentIndex,
      toolCall: block,
      partial: state.partial,
    });
  }

  handleEvent(event) {
    const type = event.type;
    if (this.config.debug && type !== "response.audio.delta" && type !== "response.output_audio.delta") {
      this.pi.sendMessage?.({
        customType: RT_CUSTOM_TYPE,
        content: `event ${type}`,
        display: false,
        details: event,
      });
    }

    // Audio bytes — straight to player, never a text event.
    if (type === "response.audio.delta" || type === "response.output_audio.delta") {
      const delta = event.delta;
      if (delta) {
        const chunk = Buffer.from(delta, "base64");
        if (this.current) {
          this.current.audioChunks.push(chunk);
          this.current.audioBytes += chunk.length;
        }
        if (this.phase !== "speaking") {
          // First audio frame of the response: clear any mic frames already
          // appended to the input buffer so the assistant's own voice can't be
          // committed as the next user turn.
          if (this.mic && (this.micMode === "vad" || this.micMode === "continuous")) {
            try { this.send({ type: "input_audio_buffer.clear" }); } catch {}
            this.lastMicBytes = 0;
          }
        }
        this.setPhase("speaking");
        this.player.play(chunk);
      }
      return;
    }
    if (type === "response.audio.done" || type === "response.output_audio.done") {
      this.player.flush();
      // After speakers stop, suppress mic input briefly so any speaker tail
      // bleed isn't committed as the next user turn.
      const tailMs = Number(env("PI_RT_POST_SPEECH_MUTE_MS") || 800);
      this.micMuteUntilTs = Date.now() + tailMs;
      if (this.mic && (this.micMode === "vad" || this.micMode === "continuous")) {
        try { this.send({ type: "input_audio_buffer.clear" }); } catch {}
        this.lastMicBytes = 0;
      }
      // Keep phase as speaking until response.done; audio.done can arrive before
      // final text/tool metadata.
      this.updateStatus();
      return;
    }

    if (type === "input_audio_buffer.speech_started") {
      this.player.interrupt();
      this.pendingTranscriptText = "";
      try { this.lastCtx?.ui?.setStatus?.("rt-transcript", undefined); } catch {}
      this.playChime("speech-start");
      this.setPhase("recording");
      // Optional: barge-in also aborts Pi's in-flight agent loop (text +
      // tool chain). Defaults on; disable with PI_RT_BARGE_IN_ABORTS_AGENT=0.
      if (envBool("PI_RT_BARGE_IN_ABORTS_AGENT", true)) {
        try { this.lastCtx?.agent?.abort?.(); } catch {}
      }
      this.updateStatus();
      return;
    }

    // Mic transcription deltas are display-only until the server reports the
    // completed transcript. STT-only commits on completion; full realtime never
    // injects transcript text as a model prompt.
    if (
      type === "conversation.item.input_audio_transcription.delta" ||
      type === "conversation.item.input_audio_transcription.partial" ||
      type === "input_audio_transcription.delta"
    ) {
      const delta = String(event.delta ?? event.transcript ?? event.text ?? "");
      if (delta) {
        this.pendingTranscriptText = event.transcript || event.text ? delta : `${this.pendingTranscriptText}${delta}`;
        this.showTranscriptStatus(this.pendingTranscriptText, { pending: true });
      }
      return;
    }

    // Mic transcription: STT-only injects a user text message. Full realtime
    // treats the transcript as display-only because the model response is
    // grounded in the committed audio item.
    if (type === "conversation.item.input_audio_transcription.completed") {
      const text = String(event.transcript || this.pendingTranscriptText || "").trim();
      this.pendingTranscriptText = "";
      this.clearPendingCommitTimer();
      if (this.config.sttOnly) this.setPhase("idle");
      if (text && this.config.sttOnly) {
        this.lastTurnInputMode = "transcript";
        this.showTranscriptStatus(text, { pending: false, notify: true });
        this.markSpokenTranscript(text);
        try { this.pi.sendUserMessage(text, { deliverAs: "followUp", streamingBehavior: "followUp" }); } catch (e) { this.notify(`sendUserMessage failed: ${e.message}`, "warning"); }
      } else if (!this.config.sttOnly) {
        // Full realtime already triggers the Pi turn from input_audio_buffer.committed
        // so inference is based on the committed audio item, not this transcript.
        // Keep the transcript visible for the operator, but do not inject it as
        // a user text prompt or forward it to the model. Also avoid leaving the
        // session in a stale "transcribing" phase; transcription is not a
        // user-visible blocking state for full realtime.
        if (text) {
          this.lastTranscript = text;
          this.showTranscriptStatus(text, { pending: false, notify: true });
        }
        if (!this.current && this.phase === "transcribing") this.setPhase("idle");
        else this.updateStatus();
      }
      return;
    }

    if (type === "conversation.item.input_audio_transcription.failed") {
      this.clearPendingCommitTimer();
      const err = event.error?.message || event.error || "audio transcription failed";
      if (this.config.sttOnly) {
        this.setPhase("idle");
        this.notify(`Realtime transcription failed: ${err}`, "warning");
      } else {
        if (!this.current && this.phase === "transcribing") this.setPhase("idle");
        else this.updateStatus();
      }
      return;
    }

    if (type === "input_audio_buffer.speech_stopped") {
      this.playChime("speech-end");
      if (this.config.sttOnly) {
        this.setPhase("transcribing");
        this.startPendingCommitTimer();
      } else {
        this.clearPendingCommitTimer();
        this.setPhase("thinking");
      }
      return;
    }

    if (type === "input_audio_buffer.committed") {
      this.lastMicBytes = 0;
      if (this.config.sttOnly) {
        this.setPhase("transcribing");
        this.startPendingCommitTimer();
      } else {
        this.clearPendingCommitTimer();
        this.setPhase("thinking");
        this.triggerCommittedAudioTurn();
      }
      return;
    }

    // From here on, everything is response-scoped and only meaningful when we
    // have an active turn.
    const state = this.current;

    if (type === "response.created") {
      if (state) {
        state.responseId = event.response?.id || event.response_id || null;
        state.partial.responseId = state.responseId || undefined;
      }
      return;
    }

    if (!state) return;

    if (
      type === "response.audio_transcript.delta" ||
      type === "response.output_audio_transcript.delta"
    ) {
      this._appendText(state, event.delta || "", "audio");
      return;
    }
    if (
      type === "response.audio_transcript.done" ||
      type === "response.output_audio_transcript.done"
    ) {
      if (state.audioTranscriptOpen) this._closeTextBlock(state);
      return;
    }

    if (type === "response.text.delta" || type === "response.output_text.delta") {
      this._appendText(state, event.delta || "", "text");
      return;
    }
    if (type === "response.text.done" || type === "response.output_text.done") {
      if (state.plainTextOpen) this._closeTextBlock(state);
      return;
    }

    if (type === "response.output_item.added") {
      const item = event.item;
      if (item?.type === "function_call") this._openToolBlock(state, item);
      return;
    }

    if (type === "response.function_call_arguments.delta") {
      this._appendToolArgs(state, event.call_id || event.item_id, event.delta, event.name);
      return;
    }

    if (type === "response.function_call_arguments.done") {
      this._closeToolBlock(state, event.call_id || event.item_id, event.arguments, event.name);
      return;
    }

    if (type === "response.output_item.done") {
      const item = event.item;
      if (item?.type === "function_call") {
        const callId = item.call_id || item.id;
        // Make sure block exists and is closed with the canonical args.
        if (!state.toolBlocks.has(callId)) this._openToolBlock(state, item);
        this._closeToolBlock(state, callId, item.arguments || "", item.name);
      }
      return;
    }

    if (type === "response.done") {
      // Extend the post-speech mute window on response completion regardless
      // of audio.done timing.
      const tailMs = Number(env("PI_RT_POST_SPEECH_MUTE_MS") || 800);
      this.micMuteUntilTs = Math.max(this.micMuteUntilTs, Date.now() + tailMs);
      if (this.mic && (this.micMode === "vad" || this.micMode === "continuous")) {
        try { this.send({ type: "input_audio_buffer.clear" }); } catch {}
        this.lastMicBytes = 0;
      }
      this._finalizeResponse(state, event);
      return;
    }

    if (type === "error") {
      const err = event.error || event;
      const msg = err.message || JSON.stringify(err);
      // Reasoning auto-fallback
      if (
        /Unknown parameter: 'response\.reasoning'/.test(msg) ||
        /Unknown parameter: 'response\.reasoning_effort'/.test(msg)
      ) {
        this.reasoningRejected = true;
        this.notify("Realtime server rejected reasoning.effort; retrying without it.", "warning");
        try {
          const retryObj = this._makeResponseObject();
          delete retryObj.reasoning;
          this.send({ type: "response.create", response: retryObj });
        } catch (e) {
          this.failPending(new Error(`Reasoning retry failed: ${e.message}`));
        }
        return;
      }
      if (/Unknown parameter: 'response\.speed'/.test(msg) || /Unknown parameter: 'speed'/.test(msg)) {
        this.speedRejected = true;
        this.notify("Realtime server rejected response speed; retrying without it.", "warning");
        try {
          const retryObj = this._makeResponseObject();
          delete retryObj.speed;
          this.send({ type: "response.create", response: retryObj });
        } catch (e) {
          this.failPending(new Error(`Speed retry failed: ${e.message}`));
        }
        return;
      }
      this.failPending(new Error(msg));
      return;
    }
  }

  _cacheResponseAudio(state) {
    if (!state?.audioChunks?.length || state.audioBytes <= 0) return null;
    const pcm = Buffer.concat(state.audioChunks, state.audioBytes);
    const id = `rt-${this.nextClipId++}`;
    const text = state.partial.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    const clip = { id, pcm, durationMs: audioDurationMs(pcm), text, timestamp: Date.now() };
    this.audioClips.set(id, clip);
    this.latestClipId = id;
    // Bound memory: keep last 20 clips.
    while (this.audioClips.size > 20) {
      const oldest = this.audioClips.keys().next().value;
      this.audioClips.delete(oldest);
    }
    return clip;
  }

  sendAudioControlMessage(clip) {
    if (!clip) return;
    // IMPORTANT: do not use pi.sendMessage() here. Custom messages can be
    // delivered as steer/follow-up while the provider stream is active and may
    // become model-visible, causing the realtime model to respond to our own
    // replay affordance. Keep playback UI out of conversation history entirely.
    const line = `▶ ${clip.id} ${formatDurationMs(clip.durationMs)} · /rt-play latest`;
    try { this.lastCtx?.ui?.setStatus?.("rt-audio", line); } catch {}
  }

  async replayAudioClip(id = "latest") {
    const clipId = !id || id === "latest" ? this.latestClipId : id;
    const clip = clipId ? this.audioClips.get(clipId) : null;
    if (!clip) throw new Error(`No RT audio clip found for ${id || "latest"}`);
    this.setPhase("replaying");
    try {
      await playPcmBuffer(clip.pcm, this.config.playbackCommand || defaultPlaybackCommand(), (m, l) => this.notify(m, l), this.config.debug);
    } finally {
      this.setPhase("idle");
    }
    return clip;
  }

  _finalizeResponse(state, event) {
    // Make sure all open content blocks are closed.
    if (state.currentTextIndex !== -1) this._closeTextBlock(state);
    for (const [callId, entry] of state.toolBlocks.entries()) {
      const block = state.partial.content[entry.contentIndex];
      if (block && (!block.arguments || Object.keys(block.arguments).length === 0)) {
        this._closeToolBlock(state, callId, entry.argString, entry.name);
      }
    }

    // Scrape usage if present.
    const usage = event.response?.usage;
    if (usage) {
      const cachedTokens = usage.input_token_details?.cached_tokens || 0;
      state.partial.usage.input = usage.input_tokens || 0;
      state.partial.usage.output = usage.output_tokens || 0;
      state.partial.usage.cacheRead = cachedTokens;
      state.partial.usage.totalTokens = usage.total_tokens || (state.partial.usage.input + state.partial.usage.output);
    }

    state.partial.responseModel = event.response?.model || state.partial.responseModel;
    state.partial.responseId = event.response?.id || state.partial.responseId;
    state.partial.timestamp = Date.now();

    const hasToolCalls = state.partial.content.some((c) => c.type === "toolCall");
    const reason = hasToolCalls ? "toolUse" : "stop";
    state.partial.stopReason = reason;

    const clip = this._cacheResponseAudio(state);

    if (state.cancelled) {
      state.partial.stopReason = "aborted";
      state.stream.push({ type: "error", reason: "aborted", error: state.partial });
      state.stream.end(state.partial);
    } else {
      state.stream.push({ type: "done", reason, message: state.partial });
      state.stream.end(state.partial);
    }
    this.current = null;
    this.pendingAudioTurnPending = false;
    this.setPhase("idle");
    if (clip && !hasToolCalls) this.sendAudioControlMessage(clip);
  }

  // -------------------------------------------------------------------------
  // Microphone
  // -------------------------------------------------------------------------

  clearPendingCommitTimer() {
    if (this.pendingCommitTimer) {
      clearTimeout(this.pendingCommitTimer);
      this.pendingCommitTimer = null;
    }
  }

  startPendingCommitTimer() {
    this.clearPendingCommitTimer();
    const timeoutMs = Number(env("PI_RT_TRANSCRIPTION_TIMEOUT_MS") || 12000);
    this.pendingCommitTimer = setTimeout(() => {
      this.pendingCommitTimer = null;
      if (this.phase === "transcribing") {
        this.setPhase("idle");
        this.notify("Realtime transcription timed out; try again or use /rt-listen ptt.", "warning");
      }
    }, timeoutMs);
    this.pendingCommitTimer.unref?.();
  }

  async startMic(ctx, mode = "ptt", { restarted = false } = {}) {
    this.lastCtx = ctx || this.lastCtx;
    // Mic can be started before any typed turn. Ensure the WSS exists first;
    // no `response.create` is sent here, only audio input/transcription config.
    if (!this.connected) await this.connect(ctx);
    if (this.mic) await this.stopMic({ commit: false, restart: false });

    this.clearMicRestartTimer();
    if (!restarted) this.micRestartAttempts = 0;
    this.micMode = mode;
    this.lastMicBytes = 0;
    this.clearPendingCommitTimer();
    // PTT/manual VAD: client manually commits on Enter/Space/Esc or /rt-stop.
    // Experimental server VAD only if PI_RT_SERVER_VAD=1.
    // Force an audio session update now because no provider turn may have run yet.

    const cmd = this.config.recordCommand || defaultRecordCommand();
    const proc = runShellStream(cmd);
    // Assign this.mic BEFORE applying session so currentTurnDetection() reflects
    // VAD mode in the session.update we are about to send.
    this.mic = proc;

    this.systemPromptApplied = null;
    this.toolsAppliedKey = null;
    this.audioModeApplied = null;
    await this.maybeApplySession({ systemPrompt: "", tools: [] });

    proc.stdout.on("data", (chunk) => {
      if (!this.connected || !isRealtimeWebSocketOpen(this.ws)) return;
      // Half-duplex guard: don't feed mic audio back into the WSS while Pi is
      // mid-turn or during a brief post-speech grace window (speakers leak into
      // mic). "thinking|speaking|replaying|transcribing" covers the whole
      // assistant turn.
      if (this.phase === "thinking" || this.phase === "speaking" || this.phase === "replaying" || this.phase === "transcribing") return;
      if (Date.now() < this.micMuteUntilTs) return;
      this.lastMicBytes += chunk.length;
      try { this.send({ type: "input_audio_buffer.append", audio: b64(chunk) }); } catch {}
    });
    proc.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s && this.config.debug) this.notify(`mic: ${s}`, "warning");
    });
    proc.on("exit", (code, signal) => {
      if (this.mic === proc) {
        this.mic = null;
        this.micMode = null;
        this.sendTurnDetectionUpdate();
        this.updateStatus();
        this.scheduleMicRestart(`${code ?? "?"}${signal ? `/${signal}` : ""}`);
      }
    });
    this.setPhase("recording");
    if (mode === "vad" || mode === "continuous") this.playChime("listen");
    this.notify(
      mode === "ptt"
        ? "Recording. Press Enter/Space/Esc or /rt-stop to send; Ctrl-C or /rt-cancel discards."
        : `${restarted ? "Restarted. " : ""}Server VAD listening. Stop talking to send; /rt-cancel discards.`,
      "info",
    );
    this.updateStatus();
  }

  async stopMic({ commit = true, restart = false } = {}) {
    if (this.mic) {
      try { this.mic.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { this.mic?.kill("SIGKILL"); } catch {} }, 1000).unref?.();
      this.mic = null;
    }
    if (!restart) this.clearMicRestartTimer();
    const mode = this.micMode;
    this.micMode = null;
    this.sendTurnDetectionUpdate();
    this.updateStatus();
    if (!this.connected || !isRealtimeWebSocketOpen(this.ws)) return;
    this.pendingAudioTurnPending = false;
    if (commit) {
      if (this.lastMicBytes <= 0) {
        this.setPhase("idle");
        this.notify("No pending microphone audio to commit.", "warning");
        return;
      }
      if (this.config.sttOnly) {
        this.setPhase("transcribing");
        this.startPendingCommitTimer();
      } else {
        this.clearPendingCommitTimer();
        this.setPhase("thinking");
      }
      try { this.send({ type: "input_audio_buffer.commit" }); } catch {}
      // STT-only waits for transcription.completed and injects transcript text.
      // Full realtime triggers a placeholder Pi turn from input_audio_buffer.committed
      // so the realtime response is grounded in the committed audio item.
    } else {
      this.clearPendingCommitTimer();
      this.setPhase("idle");
    }
  }

  async close(display = true) {
    this.clearReconnectTimer();
    this.clearMicRestartTimer();
    await this.stopMic({ commit: false }).catch(() => {});
    this.player.close();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.pendingAudioTurnPending = false;
    this.setPhase("idle");
    this.systemPromptApplied = null;
    this.toolsAppliedKey = null;
    this.audioModeApplied = null;
    this.forwardedMessageCount = 0;
    this.callIdsEmittedByModel.clear();
    this.realtimeCallIdByOriginal.clear();
    this.failPending(new Error("Realtime closed"));
    if (display) this.notify("Realtime stopped", "info");
    this.updateStatus();
  }
}

// ---------------------------------------------------------------------------
// Initial config / voice resolution
// ---------------------------------------------------------------------------

function resolveRealtimeVoice() {
  const raw = env("PI_RT_VOICE", "OPENAI_TTS_VOICE", "TTS_VOICE") || DEFAULT_VOICE;
  return REALTIME_VOICES.has(raw) ? raw : DEFAULT_VOICE;
}

function normalizeTranscriptionModel(raw) {
  // Historical env had OPENAI_REALTIME_TRANSCRIPTION_MODEL=whisper; for the
  // realtime proxy we want the explicit realtime deployment by default.
  if (!raw || raw === "whisper") return DEFAULT_TRANSCRIPTION_MODEL;
  return raw;
}

function makeInitialConfig() {
  return {
    baseUrl: env("PI_RT_BASE_URL", "OPENAI_BASE_URL") || "https://api.openai.com",
    model: env("PI_RT_MODEL", "OPENAI_REALTIME_MODEL") || DEFAULT_MODEL,
    directAzure: envBool("PI_RT_DIRECT_AZURE", false) || (env("PI_RT_PROVIDER") || "").toLowerCase() === "azure",
    azureEndpoint: env("PI_RT_AZURE_ENDPOINT", "AZURE_CANADACENTRAL_ENDPOINT", "AZURE_OPENAI_ENDPOINT"),
    azureDeployment: env("PI_RT_AZURE_DEPLOYMENT", "AZURE_CANADACENTRAL_DEPLOYMENT") || env("PI_RT_MODEL", "OPENAI_REALTIME_MODEL") || DEFAULT_MODEL,
    azureApiVersion: env("PI_RT_AZURE_API_VERSION", "AZURE_OPENAI_API_VERSION") || "2025-04-01-preview",
    azureProtocol: env("PI_RT_AZURE_PROTOCOL") || "v1",
    transcriptionModel: normalizeTranscriptionModel(env("PI_RT_TRANSCRIPTION_MODEL", "OPENAI_REALTIME_TRANSCRIPTION_MODEL")),
    voice: resolveRealtimeVoice(),
    speed: parseRealtimeSpeed(env("PI_RT_SPEED", "OPENAI_REALTIME_SPEED"), 1.0),
    vadThreshold: parseVadThreshold(env("PI_RT_VAD_THRESHOLD"), 0.7),
    bufferMs: Number(env("PI_RT_BUFFER_MS", "TTS_REALTIME_BUFFER_MS") || 180),
    playbackChunkMs: Number(env("PI_RT_PLAYBACK_CHUNK_MS") || 80),
    reasoningEffort: env("PI_RT_REASONING_EFFORT") || "off",
    sendReasoning: envBool("PI_RT_SEND_REASONING", false),
    audioEnabled: !envBool("PI_RT_DISABLE_AUDIO", false),
    statusWidgetVisible: false,
    debug: envBool("PI_RT_DEBUG", false),
    recordCommand: env("PI_RT_RECORD_CMD"),
    playbackCommand: env("PI_RT_PLAYBACK_CMD"),
    autoReconnect: false,
    reconnectAttempts: 0,
    reconnectMaxAttempts: Number(env("PI_RT_RECONNECT_MAX_ATTEMPTS") || 5),
    reconnectBaseDelayMs: Number(env("PI_RT_RECONNECT_BASE_DELAY_MS") || 1000),
    reconnectTimer: null,
    reconnecting: false,
    lastDisconnectReason: null,
    nextReconnectAt: null,
    desiredListenMode: null,
    summaryContext: envBool("PI_RT_SUMMARY", false),
    chimeEnabled: envBool("PI_RT_CHIME", true),
    defaultModelSnapshot: null,
  };
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

function unregisterRealtimeProvider(pi) {
  try { pi.unregisterProvider?.("openai-realtime"); } catch {}
}

function registerRealtimeProvider(pi, session, { force = false } = {}) {
  const baseUrl = env("PI_RT_BASE_URL", "OPENAI_BASE_URL") || "https://api.openai.com";
  const apiKey = env("PI_RT_API_KEY") ? "PI_RT_API_KEY" : "OPENAI_API_KEY";
  const models = [
    {
      id: "gpt-realtime-2",
      name: "GPT Realtime 2",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    },
    {
      id: "gpt-realtime",
      name: "GPT Realtime",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    },
  ];
  // Skip provider registration entirely unless the user opts in. Pi's model
  // dispatcher can otherwise route other openai-responses-style models to our
  // streamSimple, which then errors with "not a realtime model" on every turn.
  // Opt in by setting PI_RT_REGISTER=1, by selecting an openai-realtime model
  // on launch via --model, or by explicit /rt invocation (which re-registers).
  if (
    !force &&
    !envBool("PI_RT_REGISTER", false) &&
    !/^openai-realtime\//.test(env("PI_MODEL") || "") &&
    !envBool("PI_RT_ALWAYS_REGISTER", false)
  ) {
    return;
  }
  pi.registerProvider("openai-realtime", {
    name: "OpenAI Realtime",
    api: REALTIME_API,
    baseUrl,
    apiKey,
    models,
    streamSimple: (model, context, options) => session.streamSimple(model, context, options),
  });
}

function isRealtimeModel(model) {
  const id = String(model?.id || "");
  const provider = String(model?.provider || "");
  return provider === "openai-realtime" || id.startsWith("gpt-realtime");
}

// ---------------------------------------------------------------------------
// Status widget formatting
// ---------------------------------------------------------------------------

function audioOutputBackendLabel(config) {
  if (config.playbackCommand) return "out:custom";
  const backend = (process.env.PI_RT_AUDIO_BACKEND || "").toLowerCase();
  if (["pulse", "pulseaudio", "pacat", "paplay"].includes(backend)) return "out:pulse";
  if (["sox", "play"].includes(backend)) return "out:sox";
  if (backend === "audiotoolbox") return "out:audiotoolbox";
  if (backend === "coreaudio") return "out:coreaudio";
  if (backend === "ffplay" || backend === "ffmpeg") return `out:${backend}`;
  if (process.env.PULSE_SERVER) return "out:pulse";
  return "out:ffplay";
}

function audioInputBackendLabel(config) {
  if (config.recordCommand) return "in:custom";
  const backend = (process.env.PI_RT_AUDIO_BACKEND || "").toLowerCase();
  if (["pulse", "pulseaudio", "pacat", "parec"].includes(backend)) return "in:pulse";
  // AudioToolbox is output-only on macOS; input still uses AVFoundation.
  if (["coreaudio", "audiotoolbox", "ffmpeg"].includes(backend)) return "in:avfoundation";
  if (["sox", "rec", "play"].includes(backend)) return "in:sox";
  if (process.env.PULSE_SERVER) return "in:pulse";
  return "in:sox";
}

function statusLines(session, config, { full = false } = {}) {
  const conn = session.connected ? "●" : (session.connecting ? "◐" : "○");
  const mic = session.mic ? `mic:${session.micMode || "on"}` : "mic:off";
  const provider = config.directAzure ? "azure" : "proxy";
  const outBackend = audioOutputBackendLabel(config);
  const inBackend = audioInputBackendLabel(config);
  const reason = config.reasoningEffort === "off"
    ? ""
    : ` · reason:${config.reasoningEffort}${session.reasoningRejected ? "!" : ""}${(!config.directAzure && !config.sendReasoning) ? " unsent" : ""}`;
  const speed = config.speed && config.speed !== 1 ? ` · speed:${config.speed}${session.speedRejected ? "!" : ""}` : "";
  const phase = session.phase && session.phase !== "idle" ? ` · ${session.phase}` : "";
  const clip = session.latestClipId ? ` · clip:${session.latestClipId}` : "";
  const mode = session.state?.mode?.({ sttOnly: config.sttOnly }) || (config.sttOnly ? "stt" : "connected");
  const restore = config.previousModel ? ` · ↩${config.previousModel.provider}/${config.previousModel.id}` : "";
  const summary = config.summaryContext ? "summary:on" : "summary:off";
  const chime = config.chimeEnabled ? "chime:on" : "chime:off";
  const input = session.lastTurnInputMode ? ` · input:${session.lastTurnInputMode}` : "";
  const compact = [
    `${conn} rt ${config.model} · mode:${mode} · audio:${config.audioEnabled ? "on" : "off"} · ${mic} · ${outBackend}/${inBackend}${phase}`,
    `trans:${config.transcriptionModel} · voice:${config.voice}${speed} · hist:${session.forwardedMessageCount} · ${summary} · ${chime}${input} · ${provider}${reason}${clip}${restore}`,
  ];
  if (!full) return compact;
  return [
    ...compact,
    `baseUrl: ${normalizeBaseUrl(config.baseUrl)}`,
    `azureEndpoint: ${config.azureEndpoint || "<unset>"}`,
    `azureDeployment: ${config.azureDeployment || config.model}`,
    `record: ${config.recordCommand || defaultRecordCommand()}`,
    `playback: ${config.playbackCommand || defaultPlaybackCommand()}`,
    `playbackStarted: ${config.lastPlaybackStartedAt ? new Date(config.lastPlaybackStartedAt).toLocaleTimeString() : "<never>"}`,
    `playbackExit: ${config.lastPlaybackExit || "<none>"}`,
    `playbackError: ${config.lastPlaybackError || "<none>"}`,
  ];
}

function commandAvailable(name) {
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${name} >/dev/null 2>&1`], { encoding: "utf8" });
  return result.status === 0;
}

function envPresent(...names) {
  return names.find((name) => !!process.env[name]);
}

function diagnosticLines(session, config) {
  const provider = config.directAzure ? "azure" : "openai/proxy";
  const backend = process.env.PI_RT_AUDIO_BACKEND || "pulse";
  const record = config.recordCommand || defaultRecordCommand();
  const playback = config.playbackCommand || defaultPlaybackCommand();
  const apiKey = config.directAzure
    ? envPresent("PI_RT_AZURE_API_KEY", "AZURE_CANADACENTRAL_API_KEY", "AZURE_OPENAI_API_KEY")
    : envPresent("PI_RT_API_KEY", "OPENAI_API_KEY");
  const requirements = [
    `parec:${commandAvailable("parec") ? "ok" : "missing"}`,
    `pacat:${commandAvailable("pacat") ? "ok" : "missing"}`,
    `ffmpeg:${commandAvailable("ffmpeg") ? "ok" : "missing"}`,
    `ffplay:${commandAvailable("ffplay") ? "ok" : "missing"}`,
    `sox-rec:${commandAvailable("rec") ? "ok" : "missing"}`,
  ].join(" · ");
  const pulse = [
    `PULSE_SERVER=${process.env.PULSE_SERVER || "<unset>"}`,
    `PULSE_SOURCE=${process.env.PULSE_SOURCE || "<default>"}`,
    `PULSE_SINK=${process.env.PULSE_SINK || "<default>"}`,
  ].join(" · ");
  const hints = [];
  if (!apiKey) hints.push(config.directAzure ? "set PI_RT_AZURE_API_KEY" : "set OPENAI_API_KEY or PI_RT_API_KEY");
  if (/\bparec\b/.test(record) && !commandAvailable("parec")) hints.push("install PulseAudio tools or set PI_RT_RECORD_CMD");
  if (/\bpacat\b/.test(playback) && !commandAvailable("pacat")) hints.push("install PulseAudio tools or set PI_RT_PLAYBACK_CMD");
  if (/ffmpeg|ffplay/.test(`${record}\n${playback}`) && !commandAvailable("ffmpeg") && !commandAvailable("ffplay")) hints.push("install ffmpeg for CoreAudio/ffplay backend");
  if (backend === "pulse") hints.push(process.env.PULSE_SERVER
    ? "Pulse-first setup active; confirm phone sink/source with PULSE_SINK/PULSE_SOURCE if audio routes incorrectly"
    : "Pulse is the default backend; if using phone sink/source, set/confirm PULSE_SERVER/SINK/SOURCE, or override PI_RT_AUDIO_BACKEND for local devices");
  if (session.phase === "transcribing" && session.pendingCommitTimer) hints.push("waiting for transcription; /rt-cancel discards stuck mic input");

  return [
    "Realtime doctor",
    ...statusLines(session, config, { full: true }),
    `provider: ${provider} · apiKey:${apiKey || "<missing>"}`,
    `audioBackend: ${backend} · ${audioOutputBackendLabel(config)}/${audioInputBackendLabel(config)}`,
    `pulse: ${pulse}`,
    `commands: ${requirements}`,
    `vad: threshold:${config.vadThreshold ?? numberEnv("PI_RT_VAD_THRESHOLD", 0.7)} · silence:${numberEnv("PI_RT_VAD_SILENCE_MS", 1100)}ms · prefix:${numberEnv("PI_RT_VAD_PREFIX_PADDING_MS", 300)}ms`,
    `state: ${JSON.stringify(session.state?.snapshot?.({ sttOnly: config.sttOnly, audioEnabled: config.audioEnabled }) || {})}`,
    `micBytes: ${session.lastMicBytes || 0} · muteFor:${Math.max(0, session.micMuteUntilTs - Date.now())}ms · pendingTranscript:${session.pendingSpokenTranscripts.length} · micRestart:${session.micRestartAttempts || 0}${session.micRestartTimer ? " pending" : ""}`,
    `reconnect: ${config.autoReconnect ? "on" : "off"} · attempts:${config.reconnectAttempts || 0}/${config.reconnectMaxAttempts || 0} · next:${config.nextReconnectAt ? Math.max(0, config.nextReconnectAt - Date.now()) : 0}ms · last:${config.lastDisconnectReason || "<none>"}`,
    `lastResponseError: ${session.lastResponseError || "<none>"}`,
    `hint: ${hints.length ? hints.join("; ") : "configuration looks internally consistent"}`,
  ];
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function truncateVisible(s, width) {
  if (stripAnsi(s).length <= width) return s;
  const plain = stripAnsi(s);
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

// ---------------------------------------------------------------------------
// Unified control surface — one Pi-facing API for commands and future UI
// affordances to inspect and mutate realtime state without reaching into
// session/config internals directly.
// ---------------------------------------------------------------------------

export function createRealtimeControls({ pi, session, config }) {
  const controls = {
    usage() { return REALTIME_USAGE; },
    help() { return this.usage(); },

    options() {
      return {
        voices: [...REALTIME_VOICES],
        audioBackends: [...REALTIME_AUDIO_BACKENDS],
        reasoningEfforts: [...REALTIME_REASONING_EFFORTS],
        startModes: [...REALTIME_START_MODES],
        micModes: [...REALTIME_MIC_MODES],
        sttModes: [...REALTIME_STT_MODES],
        audioModes: [...REALTIME_AUDIO_MODES],
        widgetModes: [...REALTIME_WIDGET_MODES],
        statusModes: [...REALTIME_STATUS_MODES],
        listenModes: [...REALTIME_LISTEN_MODES],
      };
    },

    snapshot() {
      return {
        model: config.model,
        audioEnabled: config.audioEnabled,
        sttOnly: !!config.sttOnly,
        voice: config.voice,
        transcriptionModel: config.transcriptionModel,
        audioBackend: process.env.PI_RT_AUDIO_BACKEND || "pulse",
        pulse: {
          server: process.env.PULSE_SERVER || null,
          source: process.env.PULSE_SOURCE || null,
          sink: process.env.PULSE_SINK || null,
        },
        reasoningEffort: config.reasoningEffort,
        speed: config.speed,
        vadThreshold: config.vadThreshold,
        summaryContext: !!config.summaryContext,
        chimeEnabled: !!config.chimeEnabled,
        lastInputMode: session.lastTurnInputMode || null,
        previousModel: config.previousModel || null,
        state: session.state.snapshot({ sttOnly: !!config.sttOnly, audioEnabled: !!config.audioEnabled, lastInputMode: session.lastTurnInputMode || null }),
        health: {
          lastResponseError: session.lastResponseError || null,
          lastPlaybackError: config.lastPlaybackError || null,
          lastPlaybackExit: config.lastPlaybackExit || null,
          lastPlaybackStartedAt: config.lastPlaybackStartedAt || null,
          lastMicBytes: session.lastMicBytes || 0,
          pendingTranscriptCount: session.pendingSpokenTranscripts?.length || 0,
          micMuteRemainingMs: Math.max(0, (session.micMuteUntilTs || 0) - Date.now()),
          micRestartAttempts: session.micRestartAttempts || 0,
          micRestartPending: !!session.micRestartTimer,
          autoReconnect: !!config.autoReconnect,
          reconnectAttempts: config.reconnectAttempts || 0,
          reconnectMaxAttempts: config.reconnectMaxAttempts || 0,
          nextReconnectInMs: config.nextReconnectAt ? Math.max(0, config.nextReconnectAt - Date.now()) : 0,
          lastDisconnectReason: config.lastDisconnectReason || null,
        },
      };
    },

    supportedOptions() { return this.options(); },
    diagnostics() { return diagnosticLines(session, config); },
    statusLines(options) { return statusLines(session, config, options); },
    showStatus(ctx) { session.showStatusWidget(ctx); return this.snapshot(); },
    hideStatus(ctx) { session.hideStatusWidget(ctx); return this.snapshot(); },
    clearUi(ctx) { session.clearRealtimeUi(ctx); return this.snapshot(); },

    setAudio(enabled, ctx) {
      config.audioEnabled = !!enabled;
      if (!config.audioEnabled) session.player.interrupt();
      session.updateStatus(ctx);
      return this.snapshot();
    },

    toggleAudio(ctx) { return this.setAudio(!config.audioEnabled, ctx); },

    setSttOnly(enabled, ctx) {
      config.sttOnly = !!enabled;
      session.updateStatus(ctx);
      return this.snapshot();
    },

    setChime(enabled, ctx) {
      config.chimeEnabled = !!enabled;
      session.updateStatus(ctx);
      return this.snapshot();
    },

    setTranscriptionModel(model, ctx) {
      const next = normalizeTranscriptionModel(String(model || "").trim());
      if (!next) throw new Error("Realtime transcription model cannot be empty");
      config.transcriptionModel = next;
      session.systemPromptApplied = null;
      session.toolsAppliedKey = null;
      session.audioModeApplied = null;
      session.updateStatus(ctx);
      return this.snapshot();
    },

    setSpeed(speed, ctx) {
      config.speed = parseRealtimeSpeed(speed, config.speed || 1.0);
      session.speedRejected = false;
      session.audioModeApplied = null;
      session.updateStatus(ctx);
      return this.snapshot();
    },

    setVadThreshold(threshold, ctx) {
      config.vadThreshold = parseVadThreshold(threshold, config.vadThreshold ?? 0.7);
      process.env.PI_RT_VAD_THRESHOLD = String(config.vadThreshold);
      session.sendTurnDetectionUpdate();
      session.updateStatus(ctx);
      return this.snapshot();
    },

    setVoice(voice, ctx) {
      const next = String(voice || "").trim().toLowerCase();
      if (!REALTIME_VOICES.has(next)) throw new Error(`Unsupported realtime voice: ${voice}`);
      config.voice = next;
      // Voice is part of session.update but not part of the old update cache key;
      // force the next turn/listen setup to refresh session config.
      session.audioModeApplied = null;
      session.updateStatus(ctx);
      return this.snapshot();
    },

    setAudioBackend(backend, ctx) {
      const next = String(backend || "").trim().toLowerCase();
      if (!next) throw new Error("Audio backend is required");
      if (!REALTIME_AUDIO_BACKENDS.has(next)) {
        throw new Error(`Unsupported realtime audio backend: ${backend}. Use one of: ${this.options().audioBackends.join(", ")}`);
      }
      process.env.PI_RT_AUDIO_BACKEND = next;
      config.recordCommand = env("PI_RT_RECORD_CMD");
      config.playbackCommand = env("PI_RT_PLAYBACK_CMD");
      session.player.interrupt();
      session.updateStatus(ctx);
      return this.snapshot();
    },

    setPulseRouting({ server, source, sink } = {}, ctx) {
      const apply = (key, value) => {
        if (value === undefined || value === null) return;
        const next = String(value).trim();
        if (next) process.env[key] = next;
        else delete process.env[key];
      };
      apply("PULSE_SERVER", server);
      apply("PULSE_SOURCE", source);
      apply("PULSE_SINK", sink);
      config.recordCommand = env("PI_RT_RECORD_CMD");
      config.playbackCommand = env("PI_RT_PLAYBACK_CMD");
      session.player.interrupt();
      session.updateStatus(ctx);
      return this.snapshot();
    },

    setReasoningEffort(effort, ctx) {
      const next = String(effort || "").trim().toLowerCase();
      if (!next) return this.snapshot();
      if (!REALTIME_REASONING_EFFORTS.has(next)) {
        throw new Error(`Unsupported realtime reasoning effort: ${effort}. Use one of: ${this.options().reasoningEfforts.join(", ")}`);
      }
      config.reasoningEffort = next;
      session.reasoningRejected = false;
      session.updateStatus(ctx);
      return this.snapshot();
    },

    setSummaryContext(enabled, ctx) {
      const next = !!enabled;
      if (config.summaryContext !== next) {
        config.summaryContext = next;
        // The replay shape changes between full-history and compact-summary
        // modes, so restart the WSS history cursor for the next turn.
        session.forwardedMessageCount = 0;
        session.callIdsEmittedByModel.clear();
      }
      session.updateStatus(ctx);
      return this.snapshot();
    },

    async listen(ctx, mode = "ptt") {
      const next = String(mode || "ptt").trim().toLowerCase();
      if (!REALTIME_LISTEN_MODES.has(next)) {
        throw new Error(`Unsupported realtime listen mode: ${mode}. Use one of: ${this.options().listenModes.join(", ")}`);
      }
      const vad = next === "vad" || next === "continuous";
      await session.startMic(ctx, vad ? "vad" : "ptt");
      return this.snapshot();
    },

    async cancelMic(ctx) {
      await session.stopMic({ commit: false });
      session.updateStatus(ctx);
      return this.snapshot();
    },

    async stopMic(ctx, { commit = true } = {}) {
      await session.stopMic({ commit });
      session.updateStatus(ctx);
      return this.snapshot();
    },

    async disable(ctx, { restoreModel = true } = {}) {
      config.autoReconnect = false;
      config.desiredListenMode = null;
      session.clearReconnectTimer();
      session.hideStatusWidget(ctx);
      await session.stopMic({ commit: false }).catch(() => {});
      await session.close(false).catch(() => {});
      this.setAudio(false, ctx);
      config.sttOnly = false;
      const prev = config.previousModel;
      if (restoreModel && prev) {
        config.previousModel = null;
        const m = ctx?.modelRegistry?.find?.(prev.provider, prev.id);
        if (m) { try { await pi.setModel(m); } catch {} }
      }
      restoreDefaultModelSettingsSoon(config.defaultModelSnapshot);
      config.defaultModelSnapshot = null;
      unregisterRealtimeProvider(pi);
      session.clearRealtimeUi(ctx);
      return this.snapshot();
    },
  };
  return controls;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function realtimeAgentExtension(pi) {
  const config = makeInitialConfig();
  const session = new RealtimeSession(pi, config);
  const controls = createRealtimeControls({ pi, session, config });
  try { pi.realtime = controls; } catch {}
  try { pi.events?.emit?.("realtime:controls", controls); } catch {}
  let terminalInputUnsub = null;

  // Register provider lazily so users who never use realtime aren't affected
  // by potential model-dispatch fallbacks.
  registerRealtimeProvider(pi, session);

  pi.registerMessageRenderer?.(RT_CUSTOM_TYPE, (message, _options, theme) => {
    const role = message.details?.role || "status";
    const icon = role === "audio-control" ? "▶" : "◇";
    const color = role === "audio-control" ? "accent" : "dim";
    const text = `${theme.fg(color, icon)} ${message.content || ""}`;
    return { render: (width) => [truncateVisible(text, width)], invalidate() {} };
  });

  // Belt-and-braces: older versions emitted RT audio-control custom messages.
  // Strip all realtime-agent custom messages from model context if present in
  // existing session history.
  pi.on("context", (event) => ({
    messages: event.messages.filter((m) => !(m.role === "custom" && m.customType === RT_CUSTOM_TYPE)),
  }));

  pi.on("session_start", (_event, ctx) => {
    session.lastCtx = ctx;
    if (isRealtimeModel(ctx.model)) {
      config.model = ctx.model.id;
      session.showStatusWidget(ctx);
    } else {
      session.updateStatus(ctx);
    }

    try { terminalInputUnsub?.(); } catch {}
    terminalInputUnsub = ctx.ui.onTerminalInput?.((data) => {
      if (!session.mic) return undefined;
      // While mic is active, make common keys act like push-to-talk release.
      // Ctrl-C cancels/discards. Enter, Space, and Escape commit/stop.
      if (data === "\u0003") {
        session.stopMic({ commit: false }).catch(() => {});
        return { consume: true };
      }
      if (data === "\r" || data === "\n" || data === " " || data === "\u001b") {
        session.stopMic({ commit: true }).catch(() => {});
        return { consume: true };
      }
      return undefined;
    });
  });

  pi.on("session_shutdown", async () => {
    config.autoReconnect = false;
    try { terminalInputUnsub?.(); } catch {}
    terminalInputUnsub = null;
    await session.close(false).catch(() => {});
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    if (!isRealtimeModel(ctx?.model) && !session.current && !session.connected) return undefined;
    await controls.disable(ctx, { restoreModel: true }).catch(() => {});
    ctx?.ui?.notify?.("Realtime paused and restored the text model before compaction. Retry /compact if this was a manual compact; auto-compaction will retry on the text model.", "warning");
    return { cancel: true };
  });

  pi.on("model_select", (event, ctx) => {
    if (isRealtimeModel(event.model)) {
      config.model = event.model.id;
      session.showStatusWidget(ctx);
      // History pointer must reset whenever the model changes — otherwise we
      // would skip replaying the prior conversation into the WSS.
      session.forwardedMessageCount = 0;
      session.systemPromptApplied = null;
      session.toolsAppliedKey = null;
      session.audioModeApplied = null;
      session.callIdsEmittedByModel.clear();
      session.realtimeCallIdByOriginal.clear();
      ctx.ui.notify(`Realtime: ${event.model.provider}/${event.model.id} selected`, "info");
    } else {
      unregisterRealtimeProvider(pi);
      session.clearRealtimeUi(ctx);
    }
  });

  async function ensureRealtimeProvider(ctx) {
    if (!ctx.modelRegistry.find?.("openai-realtime", config.model || "gpt-realtime-2")) {
      try { registerRealtimeProvider(pi, session, { force: true }); } catch {}
    }
  }

  async function startRealtime(ctx, { listenMode = "vad", sttOnly = false } = {}) {
    config.autoReconnect = true;
    config.desiredListenMode = listenMode || "vad";

    if (sttOnly) {
      // Transcription-only: keep current Pi model, open WSS just for STT,
      // disable audio reply, route transcripts as user messages to Pi.
      controls.setAudio(false, ctx);
      controls.setSttOnly(true, ctx);
      controls.showStatus(ctx);
    } else {
      await ensureRealtimeProvider(ctx);
      // Full realtime: remember the prior Pi model so /rt-off can restore it,
      // then switch to gpt-realtime-2.
      const current = ctx.model;
      if (current && !isRealtimeModel(current)) {
        config.previousModel = { provider: current.provider, id: current.id };
      }
      const modelId = config.model || "gpt-realtime-2";
      const m = ctx.modelRegistry.find?.("openai-realtime", modelId)
        || { provider: "openai-realtime", id: modelId, name: modelId };
      config.defaultModelSnapshot ||= readDefaultModelSettings();
      const ok = await pi.setModel(m);
      restoreDefaultModelSettingsSoon(config.defaultModelSnapshot);
      if (!ok) { ctx.ui.notify("No API key for openai-realtime", "error"); return false; }
      if (!ok) { ctx.ui.notify("No API key for openai-realtime", "error"); return false; }
      controls.setAudio(true, ctx);
      controls.setSttOnly(false, ctx);
      controls.showStatus(ctx);
    }

    try { await session.connect(ctx); }
    catch (e) { ctx.ui.notify(`Realtime connect: ${e.message}`, "error"); return false; }

    if (listenMode && listenMode !== "off" && listenMode !== "nolisten") {
      try { await controls.listen(ctx, listenMode === "ptt" ? "ptt" : "vad"); }
      catch (e) { ctx.ui.notify(`Realtime mic failed: ${e.message}`, "error"); }
    }

    try { ctx.ui.setWidget("realtime-status", controls.statusLines(), { placement: "belowEditor" }); } catch {}
    session.updateStatus(ctx);
    return true;
  }

  function showRtUsage(ctx) {
    ctx.ui.notify(controls.usage(), "info");
  }

  function normalizeRealtimeToolParams(params = {}) {
    const out = { ...params };
    if (out.server !== undefined && out.pulseServer === undefined) out.pulseServer = out.server;
    if (out.source !== undefined && out.pulseSource === undefined) out.pulseSource = out.source;
    if (out.sink !== undefined && out.pulseSink === undefined) out.pulseSink = out.sink;
    for (const key of ["action", "start", "mic", "listen", "stt", "audio", "widget", "status", "backend", "voice", "reasoning", "trans", "transcription", "transcriptionModel"]) {
      if (out[key] !== undefined && out[key] !== null) out[key] = String(out[key]).trim().toLowerCase();
    }
    if (out.summary !== undefined && out.summary !== null) out.summary = parseBooleanValue(out.summary);
    if (out.chime !== undefined && out.chime !== null) out.chime = parseBooleanValue(out.chime);
    if (out.speed !== undefined && out.speed !== null) out.speed = parseRealtimeSpeed(out.speed);
    if (out.thresh !== undefined && out.thresh !== null) out.thresh = parseVadThreshold(out.thresh);
    if (out.fork !== undefined && out.fork !== null) out.fork = parseBooleanValue(out.fork);
    return out;
  }

  function currentLeafId(ctx) {
    return ctx?.sessionManager?.getLeafId?.() || ctx?.sessionManager?.getBranch?.()?.at?.(-1)?.id || null;
  }

  async function applyRealtimeParams(rawParams, ctx) {
    const params = normalizeRealtimeToolParams(rawParams);
    if (params.fork) {
      if (typeof ctx?.fork !== "function") throw new Error("/rt fork=true requires a command-capable Pi context with ctx.fork().");
      const leafId = currentLeafId(ctx);
      if (!leafId) throw new Error("/rt fork=true could not find the current tree position to fork from.");
      const forkParams = { ...params, fork: false };
      const result = await ctx.fork(leafId, {
        position: "at",
        withSession: async (forkCtx) => {
          await applyRealtimeParams(forkParams, forkCtx);
          forkCtx.ui?.notify?.("Realtime started in a fork from the previous tree position.", "info");
        },
      });
      return { forked: true, cancelled: !!result?.cancelled, snapshot: controls.snapshot() };
    }
    if (params.backend) controls.setAudioBackend(params.backend, ctx);
    if (params.pulseServer !== undefined || params.pulseSource !== undefined || params.pulseSink !== undefined) {
      controls.setPulseRouting({ server: params.pulseServer, source: params.pulseSource, sink: params.pulseSink }, ctx);
    }
    if (params.voice) controls.setVoice(params.voice, ctx);
    if (params.trans || params.transcription || params.transcriptionModel) controls.setTranscriptionModel(params.trans || params.transcription || params.transcriptionModel, ctx);
    if (params.speed !== undefined) controls.setSpeed(params.speed, ctx);
    if (params.thresh !== undefined) controls.setVadThreshold(params.thresh, ctx);
    if (params.reasoning) controls.setReasoningEffort(params.reasoning, ctx);
    if (params.summary !== undefined) controls.setSummaryContext(params.summary, ctx);
    if (params.chime !== undefined) controls.setChime(params.chime, ctx);
    if (params.audio) {
      if (!REALTIME_AUDIO_MODES.has(params.audio)) throw new Error("Unsupported realtime audio mode");
      if (params.audio === "toggle") controls.toggleAudio(ctx);
      else controls.setAudio(params.audio === "on", ctx);
    }
    if (params.widget) {
      if (!REALTIME_WIDGET_MODES.has(params.widget)) throw new Error("Unsupported realtime widget mode");
      if (params.widget === "hide" || params.widget === "off") controls.hideStatus(ctx);
      else controls.showStatus(ctx);
    }
    const action = params.action || params.start || params.mode;
    const hasLifecycleAction = !!(action || params.stt || params.mic || params.listen);
    if (params.status && !hasLifecycleAction) {
      const full = params.status === "full";
      controls.showStatus(ctx);
      return { lines: full ? controls.diagnostics() : controls.statusLines(), snapshot: controls.snapshot() };
    }
    if (action === "status" || action === "doctor") {
      const full = action === "doctor" || params.status === "full";
      controls.showStatus(ctx);
      return { lines: full ? controls.diagnostics() : controls.statusLines(), snapshot: controls.snapshot() };
    }
    if (params.stt) return startRealtime(ctx, { sttOnly: true, listenMode: params.stt === "ptt" ? "ptt" : "vad" });
    if (params.mic || params.listen) return controls.listen(ctx, params.mic || params.listen);
    if (action) {
      if (action === "stop" || action === "off") return controls.disable(ctx, { restoreModel: true });
      if (!REALTIME_START_MODES.has(action)) throw new Error(`Unsupported realtime start mode: ${action}`);
      const result = await startRealtime(ctx, { listenMode: action });
      if (params.status) {
        const full = params.status === "full";
        return { lines: full ? controls.diagnostics() : controls.statusLines(), snapshot: controls.snapshot(), result };
      }
      return result;
    }
    return controls.snapshot();
  }

  function envArgsToRealtimeParams(parsed) {
    const v = parsed.values || {};
    return {
      action: v.action,
      start: v.start,
      mode: v.mode,
      backend: v.backend,
      server: v.server ?? v.pulse_server ?? v.pulseserver,
      source: v.source ?? v.pulse_source ?? v.pulsesource,
      sink: v.sink ?? v.pulse_sink ?? v.pulsesink,
      voice: v.voice,
      trans: v.trans ?? v.transcription ?? v.transcription_model ?? v.transcriptionmodel,
      speed: v.speed,
      thresh: v.thresh ?? v.threshold ?? v.vad_threshold ?? v.vadthreshold,
      reasoning: v.reasoning,
      summary: v.summary,
      chime: v.chime,
      fork: v.fork,
      audio: v.audio,
      widget: v.widget,
      status: v.status,
      mic: v.mic,
      listen: v.listen,
      stt: v.stt,
    };
  }

  async function handleRtCommand(args, ctx) {
    let parsed;
    try { parsed = parseEnvStyleArgs(args || ""); }
    catch (e) { ctx.ui.notify(`Realtime argument parse error: ${e.message}`, "warning"); return; }
    if (Object.keys(parsed.values).length) {
      try {
        const result = await applyRealtimeParams(envArgsToRealtimeParams(parsed), ctx);
        if (result?.lines) ctx.ui.notify(result.lines.join("\n"), "info");
        else ctx.ui.notify("Realtime settings updated", "info");
      } catch (e) { ctx.ui.notify(e.message || String(e), "warning"); }
      return;
    }
    const tokens = parsed.positionals.map((t) => t.toLowerCase());
    const verb = tokens[0] || "start";
    const value = tokens[1] || "";
    const extra = tokens.slice(2);
    const singleValueVerbs = new Set([
      "start", "on", "stt", "status", "widget", "audio", "mic", "listen",
      "voice", "backend", "reasoning", "summary", "chime", "trans", "transcription", "speed", "thresh",
    ]);
    const noValueVerbs = new Set(["help", "usage", "?", "stop", "off", "doctor", "vad", "ptt", "nolisten"]);
    if (value && noValueVerbs.has(verb)) {
      ctx.ui.notify(`Unexpected realtime argument for /rt ${verb}: ${value}`, "warning");
      return;
    }
    if (extra.length && singleValueVerbs.has(verb)) {
      ctx.ui.notify(`Unexpected extra realtime argument(s) for /rt ${verb}: ${extra.join(" ")}`, "warning");
      return;
    }

    // Compatibility aliases from the original rough UX.
    if (["help", "usage", "?"].includes(verb)) { showRtUsage(ctx); return; }
    if (["vad", "ptt", "nolisten"].includes(verb)) return startRealtime(ctx, { listenMode: verb });
    if (verb === "stt" && ["stop", "off", "cancel"].includes(value)) {
      await controls.disable(ctx, { restoreModel: true });
      ctx.ui.notify("Realtime STT stopped", "info");
      return;
    }
    if (verb === "stt" && (!value || ["start", "vad", "ptt"].includes(value))) {
      return startRealtime(ctx, { sttOnly: true, listenMode: value === "ptt" ? "ptt" : "vad" });
    }
    if (verb === "stt") { ctx.ui.notify("Unsupported realtime STT mode. Use /rt stt [vad|ptt|stop].", "warning"); return; }

    if (verb === "start" || verb === "on") {
      const mode = value || "vad";
      if (!REALTIME_START_MODES.has(mode)) { ctx.ui.notify("Unsupported realtime start mode. Use /rt start [vad|ptt|nolisten].", "warning"); return; }
      return startRealtime(ctx, { listenMode: mode });
    }
    if (verb === "stop" || verb === "off") { await controls.disable(ctx, { restoreModel: true }); ctx.ui.notify("Realtime off", "info"); return; }
    if (verb === "doctor") { const lines = controls.diagnostics(); ctx.ui.setWidget("realtime-status", lines.slice(0, 8), { placement: "belowEditor" }); ctx.ui.notify(lines.join("\n"), "info"); return; }
    if (verb === "status") {
      const mode = value || "compact";
      if (!REALTIME_STATUS_MODES.has(mode)) { ctx.ui.notify("Unsupported realtime status mode. Use /rt status [compact|full].", "warning"); return; }
      const full = mode === "full";
      controls.showStatus(ctx);
      const lines = full ? controls.diagnostics() : controls.statusLines();
      ctx.ui.notify(full ? lines.join("\n") : lines[0], "info");
      return;
    }
    if (verb === "widget") {
      const mode = value || "show";
      if (!REALTIME_WIDGET_MODES.has(mode)) { ctx.ui.notify("Unsupported realtime widget mode. Use /rt widget [show|hide].", "warning"); return; }
      if (mode === "hide" || mode === "off") controls.hideStatus(ctx);
      else controls.showStatus(ctx);
      return;
    }
    if (verb === "audio") {
      const mode = value || "toggle";
      if (!REALTIME_AUDIO_MODES.has(mode)) { ctx.ui.notify("Unsupported realtime audio mode. Use /rt audio [on|off|toggle].", "warning"); return; }
      const snapshot = mode === "on" ? controls.setAudio(true, ctx)
        : mode === "off" ? controls.setAudio(false, ctx)
        : controls.toggleAudio(ctx);
      ctx.ui.notify(`Realtime audio ${snapshot.audioEnabled ? "ON" : "OFF"}`, "info");
      return;
    }
    if (verb === "mic") {
      const mode = value || "vad";
      if (!REALTIME_MIC_MODES.has(mode)) { ctx.ui.notify("Unsupported realtime mic mode. Use /rt mic [vad|ptt|off].", "warning"); return; }
      if (mode === "off" || mode === "stop" || mode === "cancel") { await controls.cancelMic(ctx); ctx.ui.notify("Realtime mic cancelled", "info"); return; }
      await controls.listen(ctx, mode);
      ctx.ui.notify(mode === "ptt" ? "PTT recording. Press Enter/Space/Esc or /rt mic off." : "VAD listening. Speak; silence should transcribe.", "info");
      return;
    }
    if (verb === "listen") {
      const mode = value || "vad";
      if (!REALTIME_LISTEN_MODES.has(mode)) { ctx.ui.notify("Unsupported realtime listen mode. Use /rt listen [vad|ptt|continuous].", "warning"); return; }
      await controls.listen(ctx, mode);
      ctx.ui.notify(mode === "ptt" ? "PTT recording. Press Enter/Space/Esc or /rt mic off." : "VAD listening. Speak; silence should transcribe.", "info");
      return;
    }
    if (verb === "voice") {
      if (!value) { ctx.ui.notify(`Realtime voice ${controls.snapshot().voice}. Options: ${controls.options().voices.join(", ")}`, "info"); return; }
      try { controls.setVoice(value, ctx); ctx.ui.notify(`Realtime voice ${value}`, "info"); }
      catch (e) { ctx.ui.notify(e.message || String(e), "warning"); }
      return;
    }
    if (verb === "trans" || verb === "transcription") {
      if (!value) { ctx.ui.notify(`Realtime transcription model ${controls.snapshot().transcriptionModel}. Use /rt trans <model>.`, "info"); return; }
      try { const snapshot = controls.setTranscriptionModel(value, ctx); ctx.ui.notify(`Realtime transcription model ${snapshot.transcriptionModel}`, "info"); }
      catch (e) { ctx.ui.notify(e.message || String(e), "warning"); }
      return;
    }
    if (verb === "speed") {
      if (!value) { ctx.ui.notify(`Realtime response speed ${controls.snapshot().speed}. Use /rt speed <0.25..1.5>.`, "info"); return; }
      try { const snapshot = controls.setSpeed(value, ctx); ctx.ui.notify(`Realtime response speed ${snapshot.speed}`, "info"); }
      catch (e) { ctx.ui.notify(e.message || String(e), "warning"); }
      return;
    }
    if (verb === "thresh") {
      if (!value) { ctx.ui.notify(`Realtime VAD threshold ${controls.snapshot().vadThreshold}. Use /rt thresh <0..1>. Raise it to reject ambient noise.`, "info"); return; }
      try { const snapshot = controls.setVadThreshold(value, ctx); ctx.ui.notify(`Realtime VAD threshold ${snapshot.vadThreshold}`, "info"); }
      catch (e) { ctx.ui.notify(e.message || String(e), "warning"); }
      return;
    }
    if (verb === "backend") {
      if (!value) { ctx.ui.notify(`Realtime audio backend ${controls.snapshot().audioBackend}. Options: ${controls.options().audioBackends.join(", ")}`, "info"); return; }
      try { controls.setAudioBackend(value, ctx); ctx.ui.notify(`Realtime audio backend ${value}`, "info"); }
      catch (e) { ctx.ui.notify(e.message || String(e), "warning"); }
      return;
    }
    if (verb === "reasoning") {
      if (!value) { ctx.ui.notify(`Realtime reasoning effort ${controls.snapshot().reasoningEffort}. Options: ${controls.options().reasoningEfforts.join(", ")}`, "info"); return; }
      try { controls.setReasoningEffort(value, ctx); ctx.ui.notify(`Realtime reasoning effort: ${value}`, "info"); }
      catch (e) { ctx.ui.notify(e.message || String(e), "warning"); }
      return;
    }
    if (verb === "summary") {
      if (!value) { ctx.ui.notify(`Realtime summary context ${controls.snapshot().summaryContext ? "true" : "false"}. Use /rt summary [true|false].`, "info"); return; }
      try {
        const enabled = parseBooleanValue(value);
        controls.setSummaryContext(enabled, ctx);
        ctx.ui.notify(`Realtime summary context ${enabled ? "true" : "false"}`, "info");
      } catch (e) { ctx.ui.notify(e.message || String(e), "warning"); }
      return;
    }
    if (verb === "chime") {
      if (!value) { ctx.ui.notify(`Realtime VAD chimes ${controls.snapshot().chimeEnabled ? "true" : "false"}. Use /rt chime [true|false].`, "info"); return; }
      try {
        const enabled = parseBooleanValue(value);
        controls.setChime(enabled, ctx);
        ctx.ui.notify(`Realtime VAD chimes ${enabled ? "true" : "false"}`, "info");
      } catch (e) { ctx.ui.notify(e.message || String(e), "warning"); }
      return;
    }

    showRtUsage(ctx);
  }

  if (typeof pi.registerTool === "function") {
    pi.registerTool({
      name: "realtime_agent_control",
      label: "Realtime Agent Control",
      description: "Control Pi realtime/STT lifecycle and runtime Pulse routing for the current session.",
      promptSnippet: "Use realtime_agent_control to start/stop realtime calls or STT and to set Pulse server/source/sink at runtime.",
      promptGuidelines: ["Use realtime_agent_control instead of asking the operator to type /rt when you need to manage realtime calls, STT, or Pulse routing."],
      parameters: ToolSchema.object({
        action: ToolSchema.optional(ToolSchema.string({ description: "Lifecycle action: start, stop, off, vad, ptt, nolisten, or status." })),
        start: ToolSchema.optional(ToolSchema.string({ description: "Start full realtime with vad, ptt, or nolisten." })),
        stt: ToolSchema.optional(ToolSchema.string({ description: "Start transcription-only mode with vad or ptt." })),
        mic: ToolSchema.optional(ToolSchema.string({ description: "Start mic capture with vad or ptt." })),
        listen: ToolSchema.optional(ToolSchema.string({ description: "Listen mode: vad, ptt, or continuous." })),
        audio: ToolSchema.optional(ToolSchema.string({ description: "Audio output mode: on, off, or toggle." })),
        backend: ToolSchema.optional(ToolSchema.string({ description: "Audio backend such as pulse, coreaudio, audiotoolbox, sox, ffplay, or auto." })),
        pulseServer: ToolSchema.optional(ToolSchema.string({ description: "Runtime PULSE_SERVER for new Pulse record/playback processes. Empty string unsets." })),
        pulseSource: ToolSchema.optional(ToolSchema.string({ description: "Runtime PULSE_SOURCE for new Pulse record processes. Empty string unsets." })),
        pulseSink: ToolSchema.optional(ToolSchema.string({ description: "Runtime PULSE_SINK for new Pulse playback processes. Empty string unsets." })),
        voice: ToolSchema.optional(ToolSchema.string({ description: "Realtime output voice." })),
        reasoning: ToolSchema.optional(ToolSchema.string({ description: "Reasoning effort: off, minimal, low, medium, or high." })),
        summary: ToolSchema.optional(ToolSchema.boolean({ description: "Use compact summary context instead of replaying full conversation history. Default false." })),
        trans: ToolSchema.optional(ToolSchema.string({ description: "Realtime input transcription model, e.g. gpt-realtime-whisper or gpt-whisper-realtime." })),
        speed: ToolSchema.optional(ToolSchema.number({ description: "Realtime spoken response speed from 0.25 to 1.5. Default 1.0." })),
        thresh: ToolSchema.optional(ToolSchema.number({ description: "Realtime server VAD threshold from 0 to 1. Raise it to reject ambient noise; lower it for quiet speech." })),
        chime: ToolSchema.optional(ToolSchema.boolean({ description: "Play brief VAD/listening state chimes through the realtime playback backend. Default true." })),
        fork: ToolSchema.optional(ToolSchema.boolean({ description: "Start realtime in a fork from the current tree/session position." })),
        widget: ToolSchema.optional(ToolSchema.string({ description: "Widget mode: show or hide." })),
        status: ToolSchema.optional(ToolSchema.string({ description: "Return status: compact or full." })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const action = String(params.action || "").toLowerCase();
        let result;
        if (action === "status") result = { lines: controls.diagnostics(), snapshot: controls.snapshot() };
        else result = await applyRealtimeParams(params, ctx);
        const snapshot = result?.snapshot ? result.snapshot : controls.snapshot();
        const lines = result?.lines || controls.statusLines({ full: params.status === "full" || action === "status" });
        return {
          content: [{ type: "text", text: Array.isArray(lines) ? lines.join("\n") : JSON.stringify(snapshot, null, 2) }],
          details: { snapshot, pulse: { server: process.env.PULSE_SERVER || null, source: process.env.PULSE_SOURCE || null, sink: process.env.PULSE_SINK || null } },
        };
      },
    });
  }

  pi.registerCommand("rt-dev", {
    description: "Realtime dev helper: /rt-dev link [agent-utils checkout], /rt-dev status, /rt-dev unlink.",
    handler: async (args, ctx) => {
      const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
      const action = (tokens[0] || "status").toLowerCase();
      const source = tokens.slice(1).join(" ") || ctx.cwd;
      try {
        if (["help", "usage", "?"].includes(action)) {
          ctx.ui.notify("Usage: /rt-dev link [agent-utils checkout], /rt-dev status, /rt-dev unlink. After link, run /reload-tools or /reload to load local realtime source.", "info");
          return;
        }
        if (action === "link" || action === "on") {
          const result = installRealtimeDevLink(source);
          ctx.ui.notify(`Realtime dev link installed: ${result.linkDir} -> ${result.sourceRoot}. Run /reload-tools or /reload to load local source.`, "info");
          return;
        }
        if (action === "unlink" || action === "off") {
          const result = removeRealtimeDevLink();
          ctx.ui.notify(result.existed ? `Realtime dev link removed: ${result.linkDir}. Run /reload-tools or /reload to return to package source.` : `Realtime dev link was not present: ${result.linkDir}`, "info");
          return;
        }
        if (action === "status") {
          const status = realtimeDevLinkStatus();
          ctx.ui.notify(status.linked ? `Realtime dev link active: ${status.linkDir} -> ${status.target || status.extension}` : `Realtime dev link inactive: ${status.linkDir}`, "info");
          return;
        }
        ctx.ui.notify("Unsupported /rt-dev action. Use link, status, unlink, or help.", "warning");
      } catch (e) {
        ctx.ui.notify(`Realtime dev link failed: ${e.message || String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("rt", {
    description: "Realtime control. Usage: /rt start|stop|mic|listen|audio|stt|widget|status|doctor|voice|backend|reasoning ...",
    handler: handleRtCommand,
  });

  function rejectLegacyAliasArgs(name, args, ctx) {
    const suffix = String(args || "").trim();
    if (!suffix) return false;
    ctx.ui.notify(`Unexpected argument for ${name}: ${suffix}`, "warning");
    return true;
  }

  pi.registerCommand("rt-on", {
    description: "Enable realtime audio output.",
    handler: async (args, ctx) => {
      if (rejectLegacyAliasArgs("/rt-on", args, ctx)) return;
      return handleRtCommand("audio on", ctx);
    },
  });

  pi.registerCommand("stt", {
    description: "Alias for /rt stt: transcription-only mic into current Pi model.",
    handler: async (args, ctx) => {
      const suffix = String(args || "").trim();
      const cmd = pi.getCommand?.("rt")?.handler || null;
      if (typeof cmd === "function") return cmd(`stt${suffix ? ` ${suffix}` : ""}`, ctx);
      // Fallback: same body inline.
      try { await controls.listen(ctx, "vad"); } catch (e) { ctx.ui.notify(`stt: ${e.message}`, "error"); }
    },
  });

  pi.registerCommand("rt-stt", {
    description: "Alias for /rt stt.",
    handler: async (args, ctx) => {
      const suffix = String(args || "").trim();
      const cmd = pi.getCommand?.("rt")?.handler;
      if (typeof cmd === "function") return cmd(`stt${suffix ? ` ${suffix}` : ""}`, ctx);
    },
  });

  pi.registerCommand("rt-off", {
    description: "Exit realtime: stop mic, disable audio, restore previous Pi model.",
    handler: async (args, ctx) => {
      if (rejectLegacyAliasArgs("/rt-off", args, ctx)) return;
      return handleRtCommand("stop", ctx);
    },
  });

  pi.registerCommand("rt-devices", {
    description: "List CoreAudio devices (macOS) for PI_RT_INPUT_DEVICE / PI_RT_OUTPUT_DEVICE.",
    handler: async (args, ctx) => {
      if (rejectLegacyAliasArgs("/rt-devices", args, ctx)) return;
      try {
        const av = spawnSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], { encoding: "utf8" });
        const at = spawnSync("sh", ["-lc", "ffmpeg -hide_banner -nostats -loglevel info -f lavfi -i 'anullsrc=r=24000:cl=mono' -t 0.05 -f audiotoolbox -list_devices true - 2>&1 || true"], { encoding: "utf8" });
        const out = [
          "# AVFoundation input (PI_RT_INPUT_DEVICE)",
          (av.stderr || av.stdout || "").trim(),
          "",
          "# AudioToolbox output (PI_RT_OUTPUT_DEVICE, with PI_RT_AUDIO_BACKEND=audiotoolbox)",
          (at.stdout || "").trim(),
        ].join("\n");
        ctx.ui.notify(out, "info");
      } catch (e) {
        ctx.ui.notify(`device list failed: ${e.message}`, "error");
      }
    },
  });

  pi.registerCommand("rt-audio", {
    description: "Toggle realtime audio output. Usage: /rt-audio [on|off|toggle]",
    handler: async (args, ctx) => handleRtCommand(`audio ${String(args || "").trim()}`, ctx),
  });

  pi.registerCommand("rt-reasoning", {
    description: "Set realtime reasoning effort: off|minimal|low|medium|high",
    handler: async (args, ctx) => handleRtCommand(`reasoning ${String(args || "").trim()}`, ctx),
  });

  pi.registerCommand("rt-listen", {
    description: "Start mic capture. Usage: /rt-listen [ptt|vad|continuous]. Stop with /rt-stop; discard with /rt-cancel.",
    handler: async (args, ctx) => {
      const suffix = String(args || "").trim() || "ptt";
      return handleRtCommand(`mic ${suffix === "continuous" ? "vad" : suffix}`, ctx);
    },
  });

  pi.registerCommand("rt-stop", {
    description: "Stop mic; if recording PTT, commit audio for transcription. If no mic, close WebSocket.",
    handler: async (args, ctx) => {
      if (rejectLegacyAliasArgs("/rt-stop", args, ctx)) return;
      if (session.mic) {
        await controls.stopMic(ctx, { commit: true });
        ctx.ui.notify("Realtime mic stopped", "info");
      } else {
        config.autoReconnect = false;
        config.desiredListenMode = null;
        session.clearReconnectTimer();
        await session.close(true);
      }
      session.updateStatus(ctx);
    },
  });

  pi.registerCommand("rt-cancel", {
    description: "Stop realtime mic without committing audio.",
    handler: async (args, ctx) => {
      if (rejectLegacyAliasArgs("/rt-cancel", args, ctx)) return;
      return handleRtCommand("mic off", ctx);
    },
  });

  pi.registerCommand("rt-play", {
    description: "Replay cached realtime audio. Usage: /rt-play [latest|rt-N]",
    handler: async (args, ctx) => {
      const id = String(args || "latest").trim() || "latest";
      try {
        const clip = await session.replayAudioClip(id);
        ctx.ui.notify(`Replayed ${clip.id} (${formatDurationMs(clip.durationMs)})`, "info");
      } catch (e) {
        ctx.ui.notify(e.message || String(e), "warning");
      }
    },
  });

  pi.registerCommand("rt-status", {
    description: "Show realtime status and settings. Usage: /rt-status [full]",
    handler: async (args, ctx) => handleRtCommand(`status ${String(args || "").trim()}`, ctx),
  });

  pi.registerCommand("rt-doctor", {
    description: "Show realtime provider/audio diagnostics and troubleshooting hints.",
    handler: async (args, ctx) => {
      if (rejectLegacyAliasArgs("/rt-doctor", args, ctx)) return;
      return handleRtCommand("doctor", ctx);
    },
  });

  pi.registerCommand("rt-hide-status", {
    description: "Hide the realtime status widget.",
    handler: async (args, ctx) => {
      if (rejectLegacyAliasArgs("/rt-hide-status", args, ctx)) return;
      return handleRtCommand("widget hide", ctx);
    },
  });
}
