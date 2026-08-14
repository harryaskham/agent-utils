// Shared native text-to-speech primitives for agent-utils.
//
// This module deliberately owns the fast path end to end:
//   text -> Azure Speech REST (SSML) -> raw PCM16/24kHz/mono -> playback child.
// It never shells out to the `tts` CLI and never routes through the Cacophony
// narration daemon. Callers such as /read, realtime speak-replies, and cascade
// share the same defaults, policy gate, timeout behavior, and SSML builder.

import { spawn } from "node:child_process";
import { combineTimeoutSignal } from "./bounded-exec.js";

export const DEFAULT_TTS_PROVIDER = "azure";
export const AZURE_SPEECH_PROVIDER = "azure-speech"; // accepted legacy alias
export const DEFAULT_TTS_VOICE = "MAI-Voice-2";
export const DEFAULT_TTS_LANG = "en-GB";
export const DEFAULT_TTS_SPEED = 2;
export const DEFAULT_TTS_EMBEDDING = "0daec43c-911f-4529-820a-16dab73630d3";
export const DEFAULT_TTS_TIMEOUT_MS = 30000;
export const DEFAULT_TTS_BATCH_TIMEOUT_MS = DEFAULT_TTS_TIMEOUT_MS; // compatibility
export const DEFAULT_AZURE_SPEECH_ENDPOINT = "https://eastus.tts.speech.microsoft.com";
export const DEFAULT_AZURE_SPEECH_OUTPUT_FORMAT = "raw-24khz-16bit-mono-pcm";
export const DEFAULT_TTS_BACKEND = "pulse";
// Pulse playback targets sinks, not sources. @DEFAULT_SINK@ is portable; callers
// can override it with device= or PULSE_SINK. (A source such as source.default is
// rejected by pacat --playback with "No such entity".)
export const DEFAULT_TTS_DEVICE = "@DEFAULT_SINK@";
export const DEFAULT_TTS_STREAM_NAME = "/read";
export const CASCADE_DEFAULT_VOICE_SENTINEL = "embedding:default";

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export function resolveBatchTtsTimeoutMs(env = process.env) {
  const raw = env.PI_RT_TTS_TIMEOUT_MS ?? env.AGENT_UTILS_TTS_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_TTS_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTS_TIMEOUT_MS;
}

export function isAzureSpeechProvider(provider) {
  const value = String(provider ?? DEFAULT_TTS_PROVIDER).trim().toLowerCase();
  return value === "azure" || value === "azure-speech" || value === "direct-azure";
}

export function resolveCascadeTtsVoice(voice) {
  const value = String(voice ?? "").trim();
  if (!value || value === CASCADE_DEFAULT_VOICE_SENTINEL) return undefined;
  return value;
}

export function cascadeSpeechEnabled({ env = process.env } = {}) {
  const raw = env?.PI_CASCADE_SPEECH_ENABLED;
  if (raw == null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// A supplied speed always becomes an explicit Azure prosody percentage.
// Missing/null speed omits <prosody>; speed=1 intentionally emits +0.00%.
export function speedToProsodyRate(speed) {
  if (speed == null || speed === "") return undefined;
  const multiplier = Number(speed);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return undefined;
  const percentage = (multiplier - 1) * 100;
  return `${percentage >= 0 ? "+" : ""}${percentage.toFixed(2)}%`;
}

export function normalizeStyleDegree(value) {
  if (value == null || value === "") return undefined;
  const degree = Number(value);
  if (!Number.isFinite(degree) || degree < 0.01 || degree > 2) {
    throw new Error("azure-speech: styledegree must be between 0.01 and 2");
  }
  return String(degree);
}

// Build SSML without silently rewriting any operator-provided setting. In
// particular, voice=MAI-Voice-2 stays MAI-Voice-2 even when an embedding is set.
// Optional wrappers are emitted only when their corresponding setting exists.
export function buildAzureSpeechSsml({
  text,
  voice = DEFAULT_TTS_VOICE,
  lang = DEFAULT_TTS_LANG,
  speed = DEFAULT_TTS_SPEED,
  speakerProfileId,
  embedding,
  style,
  styleDegree,
  styledegree,
} = {}) {
  const body = String(text ?? "");
  const selectedVoice = String(voice ?? "").trim();
  if (!selectedVoice) throw new Error("azure-speech: voice is required");

  const selectedLang = lang == null ? undefined : String(lang).trim() || undefined;
  const outerLang = selectedLang || DEFAULT_TTS_LANG;
  const selectedEmbedding = speakerProfileId ?? embedding;
  const selectedStyle = style == null ? undefined : String(style).trim() || undefined;
  const selectedStyleDegree = selectedStyle
    ? normalizeStyleDegree(styleDegree ?? styledegree)
    : undefined;
  const rate = speedToProsodyRate(speed);

  let inner = xmlEscape(body);
  if (rate) inner = `<prosody rate='${xmlEscape(rate)}'>${inner}</prosody>`;
  if (selectedStyle) {
    const degreeAttr = selectedStyleDegree ? ` styledegree='${xmlEscape(selectedStyleDegree)}'` : "";
    inner = `<mstts:express-as style='${xmlEscape(selectedStyle)}'${degreeAttr}>${inner}</mstts:express-as>`;
  }
  if (selectedLang) inner = `<lang xml:lang='${xmlEscape(selectedLang)}'>${inner}</lang>`;
  if (selectedEmbedding) {
    inner = `<mstts:ttsembedding speakerProfileId='${xmlEscape(selectedEmbedding)}'>${inner}</mstts:ttsembedding>`;
  }

  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='${xmlEscape(outerLang)}'>`
    + `<voice name='${xmlEscape(selectedVoice)}'>${inner}</voice></speak>`;
}

export function resolveAzureSpeechCreds({ env = process.env, endpoint, baseUrl, apiKey } = {}) {
  const selectedEndpoint = own(arguments[0], "endpoint") || own(arguments[0], "baseUrl")
    ? endpoint ?? baseUrl
    : env.AZURE_SPEECH_ENDPOINT ?? env.PI_RT_AZURE_SPEECH_ENDPOINT ?? DEFAULT_AZURE_SPEECH_ENDPOINT;
  const selectedKey = own(arguments[0], "apiKey")
    ? apiKey
    : env.AZURE_SPEECH_API_KEY ?? env.PI_RT_AZURE_SPEECH_API_KEY ?? "";
  return {
    endpoint: selectedEndpoint == null ? "" : String(selectedEndpoint).trim().replace(/\/+$/, ""),
    apiKey: selectedKey == null ? "" : String(selectedKey).trim(),
  };
}

export function resolveSpeakToolParams(params = {}, { env = process.env, persisted = {} } = {}) {
  const resolveOptional = (key, envKeys, persistedKeys, fallback) => {
    if (own(params, key)) return params[key] == null || params[key] === "" ? undefined : params[key];
    for (const envKey of envKeys) {
      if (env[envKey] != null && String(env[envKey]).trim() !== "") return env[envKey];
    }
    for (const persistedKey of persistedKeys) {
      if (persisted[persistedKey] !== undefined && persisted[persistedKey] !== "") return persisted[persistedKey];
    }
    return fallback;
  };
  const text = String(params.text ?? "").trim();
  const voice = resolveCascadeTtsVoice(resolveOptional("voice", ["PI_CASCADE_SPEAK_VOICE", "PI_CASCADE_VOICE", "PI_TTS_VOICE"], ["voice"], DEFAULT_TTS_VOICE))
    ?? DEFAULT_TTS_VOICE;
  const speakerProfileId = resolveOptional("speaker", ["PI_CASCADE_SPEAKER", "PI_CASCADE_SPEAKER_PROFILE_ID", "PI_TTS_EMBEDDING"], ["embedding"],
    own(params, "speakerProfileId") && params.speakerProfileId !== undefined
      ? params.speakerProfileId
      : DEFAULT_TTS_EMBEDDING);
  const lang = resolveOptional("lang", ["PI_CASCADE_LANG", "PI_TTS_LANG"], ["lang"], DEFAULT_TTS_LANG);
  const speedSource = resolveOptional("speed", ["PI_CASCADE_SPEED", "PI_TTS_SPEED"], ["speed"], DEFAULT_TTS_SPEED);
  const speedNumber = speedSource == null ? undefined : Number(speedSource);
  const speed = Number.isFinite(speedNumber) && speedNumber > 0 ? speedNumber : undefined;
  const style = resolveOptional("style", ["PI_CASCADE_STYLE", "PI_TTS_STYLE"], ["style"], undefined);
  const styleDegree = resolveOptional("styleDegree", ["PI_CASCADE_STYLEDEGREE", "PI_TTS_STYLEDEGREE"], ["styleDegree"], params.styledegree);
  return { text, voice, speakerProfileId, lang, speed, style, styleDegree };
}

function azureSpeechUrl(endpoint) {
  const base = String(endpoint || "").trim().replace(/\/+$/, "");
  if (/\/cognitiveservices\/v1$/i.test(base)) return base;
  return `${base}/cognitiveservices/v1`;
}

export async function synthesizeAzureSpeechDirect({
  text,
  voice,
  lang,
  speed,
  speakerProfileId,
  embedding,
  style,
  styleDegree,
  styledegree,
  endpoint,
  baseUrl,
  apiKey,
  outputFormat = DEFAULT_AZURE_SPEECH_OUTPUT_FORMAT,
  fetchImpl,
  timeoutMs,
  signal,
  env = process.env,
} = {}) {
  if (!cascadeSpeechEnabled({ env })) {
    throw new Error("azure-speech: disabled by Cacophony node policy (speech.enabled=false)");
  }
  const body = String(text ?? "");
  if (!body.trim()) throw new Error("azure-speech: refusing to synthesize empty text");

  const resolved = resolveSpeakToolParams({
    text: body,
    ...(own(arguments[0], "voice") ? { voice } : {}),
    ...(own(arguments[0], "lang") ? { lang } : {}),
    ...(own(arguments[0], "speed") ? { speed } : {}),
    ...(own(arguments[0], "speakerProfileId") ? { speakerProfileId } : {}),
    ...(own(arguments[0], "embedding") ? { speakerProfileId: embedding } : {}),
    ...(own(arguments[0], "style") ? { style } : {}),
    ...(own(arguments[0], "styleDegree") ? { styleDegree } : {}),
    ...(own(arguments[0], "styledegree") ? { styleDegree: styledegree } : {}),
  }, { env });
  const creds = resolveAzureSpeechCreds({
    env,
    ...(own(arguments[0], "endpoint") ? { endpoint } : {}),
    ...(own(arguments[0], "baseUrl") ? { baseUrl } : {}),
    ...(own(arguments[0], "apiKey") ? { apiKey } : {}),
  });
  if (!creds.endpoint) throw new Error("azure-speech: no endpoint (set AZURE_SPEECH_ENDPOINT)");
  if (!creds.apiKey) throw new Error("azure-speech: no API key (set AZURE_SPEECH_API_KEY)");

  const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("azure-speech: no fetch implementation available");
  const embeddingExplicit = own(arguments[0], "speakerProfileId") || own(arguments[0], "embedding");
  const embeddingValue = own(arguments[0], "speakerProfileId") ? speakerProfileId : embedding;
  const ssml = buildAzureSpeechSsml({
    text: resolved.text,
    voice: own(arguments[0], "voice") && voice === null ? null : resolved.voice,
    lang: own(arguments[0], "lang") && lang === null ? null : resolved.lang,
    speed: own(arguments[0], "speed") && speed === null ? null : resolved.speed,
    speakerProfileId: embeddingExplicit && embeddingValue === null ? null : resolved.speakerProfileId,
    style: resolved.style,
    styleDegree: resolved.styleDegree,
  });

  const timeout = timeoutMs == null ? resolveBatchTtsTimeoutMs(env) : Number(timeoutMs);
  const bound = combineTimeoutSignal(signal, timeout);
  let response;
  try {
    response = await doFetch(azureSpeechUrl(creds.endpoint), {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": creds.apiKey,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": String(outputFormat || DEFAULT_AZURE_SPEECH_OUTPUT_FORMAT),
        "User-Agent": "agent-utils-tts",
      },
      body: ssml,
      signal: bound.signal,
    });
  } catch (error) {
    if (bound.isTimeout()) throw new Error(`azure-speech timed out after ${timeout}ms`);
    throw error;
  } finally {
    bound.cleanup();
  }
  if (!response || response.ok === false) {
    const status = response?.status ?? "??";
    let detail = "";
    try { detail = String(await response.text()).slice(0, 300); } catch {}
    throw new Error(`azure-speech HTTP ${status}${detail ? `: ${detail}` : ""}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function synthesizeSpeechDirect(text, options = {}) {
  const provider = options.provider ?? DEFAULT_TTS_PROVIDER;
  if (!isAzureSpeechProvider(provider)) {
    throw new Error(`tts: unsupported direct provider '${provider}'; use provider=azure`);
  }
  return synthesizeAzureSpeechDirect({ ...options, text });
}

export function buildPcmPlaybackSpec({
  backend = DEFAULT_TTS_BACKEND,
  server = process.env.PULSE_SERVER,
  device = DEFAULT_TTS_DEVICE,
  streamName = DEFAULT_TTS_STREAM_NAME,
  env = process.env,
} = {}) {
  let selected = String(backend || DEFAULT_TTS_BACKEND).trim().toLowerCase();
  if (selected === "auto") {
    // TTS auto prefers the configured Pulse graph (including remote Pulse on
    // macOS); without Pulse routing, use local CoreAudio on macOS and Pulse on
    // other hosts. Never leave `auto` as an unsupported playback backend.
    selected = server || env.PULSE_SERVER || env.PULSE_SINK
      ? "pulse"
      : process.platform === "darwin" ? "coreaudio" : "pulse";
  }
  const childEnv = { ...env };
  if (server == null || server === "") delete childEnv.PULSE_SERVER;
  else childEnv.PULSE_SERVER = String(server);

  if (["pulse", "pulseaudio", "pacat", "paplay"].includes(selected)) {
    const args = ["--playback", "--raw", "--format=s16le", "--rate=24000", "--channels=1"];
    if (server) args.push(`--server=${String(server)}`);
    if (device) args.push(`--device=${String(device)}`);
    if (streamName) {
      args.push(`--client-name=${String(streamName)}`, `--stream-name=${String(streamName)}`);
    }
    return { command: "pacat", args, env: childEnv };
  }
  if (["sox", "play"].includes(selected)) {
    return { command: "play", args: ["-q", "-t", "raw", "-b", "16", "-e", "signed-integer", "-r", "24000", "-c", "1", "-"], env: childEnv };
  }
  if (["coreaudio", "ffplay", "ffmpeg"].includes(selected)) {
    return { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ch_layout", "mono", "-i", "-"], env: childEnv };
  }
  throw new Error(`tts playback: unsupported backend '${backend}'`);
}

export function createInterruptiblePcmPlayer({ spawnImpl = spawn, killDelayMs = 250 } = {}) {
  let current = null;

  const settle = (record, error, result) => {
    if (!record || record.settled) return;
    record.settled = true;
    if (current === record) current = null;
    if (record.killTimer) clearTimeout(record.killTimer);
    if (error) record.reject(error);
    else record.resolve(result);
  };

  const interrupt = () => {
    const record = current;
    if (!record) return false;
    current = null;
    record.interrupted = true;
    try { record.proc.stdin?.destroy?.(); } catch {}
    try { record.proc.kill?.("SIGTERM"); } catch {}
    // Resolve the superseded play immediately, but still reap a child that ignores
    // SIGTERM. Process exit/close flips record.exited and suppresses SIGKILL.
    settle(record, null, { interrupted: true });
    if (killDelayMs > 0) {
      record.killTimer = setTimeout(() => {
        if (!record.exited) { try { record.proc.kill?.("SIGKILL"); } catch {} }
      }, killDelayMs);
      record.killTimer.unref?.();
    }
    return true;
  };

  const play = (buffer, options = {}) => {
    const pcm = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (pcm.length === 0) return Promise.resolve({ interrupted: false, empty: true });
    interrupt();
    const spec = buildPcmPlaybackSpec(options);
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawnImpl(spec.command, spec.args, { stdio: ["pipe", "ignore", "pipe"], env: spec.env });
      } catch (error) {
        reject(error);
        return;
      }
      const record = { proc, resolve, reject, settled: false, exited: false, interrupted: false, killTimer: null, stderr: "", stdinError: null };
      current = record;
      proc.on?.("error", (error) => settle(record, error));
      proc.stderr?.on?.("data", (chunk) => { record.stderr = `${record.stderr}${String(chunk)}`.slice(-500); });
      const done = (code = 0, signal = null) => {
        record.exited = true;
        if (record.killTimer) clearTimeout(record.killTimer);
        if (record.interrupted) return settle(record, null, { interrupted: true });
        if (code && code !== 0) {
          const detail = record.stderr.trim() || record.stdinError?.message || "";
          return settle(record, new Error(`tts playback exited ${code}${detail ? `: ${detail}` : ""}`));
        }
        if (record.stdinError) return settle(record, record.stdinError);
        return settle(record, null, { interrupted: false, code, signal });
      };
      proc.once?.("exit", done);
      proc.once?.("close", done);
      proc.stdin?.on?.("error", (error) => {
        // EPIPE usually follows a useful pacat/ffplay diagnostic. Wait for the
        // child exit so the caller gets that stderr rather than a bare EPIPE.
        if (!record.interrupted) record.stdinError = error;
      });
      try {
        proc.stdin.write(pcm);
        proc.stdin.end();
      } catch (error) {
        settle(record, error);
      }
    });
  };

  return {
    play,
    interrupt,
    dispose: interrupt,
    isPlaying: () => !!current,
    currentProcess: () => current?.proc ?? null,
  };
}
