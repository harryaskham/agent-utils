// One-shot batch TTS: text -> raw PCM16/24k/mono, for /cascade audio output
// (bd-7c6790). Spawns `tts --stdout --response-format pcm ... -- <text>` and
// resolves with the PCM buffer. Deliberately mirrors realtime-stt-batch.js: a PURE
// arg builder plus an injectable `spawnImpl` so the subprocess plumbing is
// unit-tested without the `tts` binary or any audio device.
//
// Why this shape
// --------------
//   * `--response-format pcm` emits raw int16 LE @ 24kHz mono, which is exactly the
//     format realtime-audio.js (SAMPLE_RATE=24000, mono, 16-bit) feeds to
//     playPcmBuffer — so cascade output needs no transcoding.
//   * Text is passed as a POSITIONAL argument after `--`. This is the tts CLI's
//     one-shot path and the trailing `--` protects text that begins with a dash.
//     We deliberately do NOT feed text on stdin: with no positional/--file the CLI
//     defaults to its streaming `--stdin` mode, which blocks rather than doing a
//     one-shot synth (verified live 2026-06-27).
//   * By default we pass NO provider/model/voice/base-url, so the tts CLI inherits
//     the env-configured defaults (TTS_PROVIDER, OPENAI_TTS_MODEL=azure/speech/...,
//     OPENAI_BASE_URL, OPENAI_TTS_VOICE) — i.e. EXACTLY caco's azure/speech TTS
//     path (operator request: "default to the same azure/speech/azure-tts as caco").
//     The direct `--provider azure-speech` cognitive-services path is a separate,
//     opt-in override. Per-participant overrides win when supplied.
//   * Bypasses `caco msg speak` / the daemon for latency (operator request
//     2026-06-27): cascade agents speak straight through the local `tts` CLI.

import { spawn } from "node:child_process";
import { runBoundedSubprocess, combineTimeoutSignal } from "./bounded-exec.js";

// Bound the batch-TTS external calls (bd-29a134). A stalled `tts` subprocess or a
// hung Azure Speech HTTP request must surface an error instead of hanging the
// cascade "speaking" state forever (the bd-adde03 hang shape). Env-overridable
// via PI_RT_TTS_TIMEOUT_MS; 0 disables. Default 30s covers long-text synthesis.
export const DEFAULT_TTS_BATCH_TIMEOUT_MS = 30000;

export function resolveBatchTtsTimeoutMs(env = process.env) {
  const raw = env.PI_RT_TTS_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_TTS_BATCH_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TTS_BATCH_TIMEOUT_MS;
  return n;
}

// Opt-in constant for the DIRECT Azure Cognitive Services speech path (uses
// AZURE_SPEECH_*). NOT the default: by default cascade inherits the env TTS
// provider, which in a caco env is the proxy that already fronts azure/speech.
export const AZURE_SPEECH_PROVIDER = "azure-speech";

// DEFAULT direct Azure Speech (Cognitive Services TTS) target. The eastus speech
// TTS endpoint is a non-secret regional URL (parallel to the realtime
// DEFAULT_AZURE_ENDPOINT); the API key is NEVER hardcoded here — it is read at
// synth time from AZURE_SPEECH_API_KEY. Output is raw PCM16/24k/mono so it feeds
// the cascade player (realtime-audio.js: 24kHz mono 16-bit) with no transcoding.
export const DEFAULT_AZURE_SPEECH_ENDPOINT = "https://eastus.tts.speech.microsoft.com";
export const DEFAULT_AZURE_SPEECH_OUTPUT_FORMAT = "raw-24khz-16bit-mono-pcm";

// Sentinel from realtime-participants.js meaning "use the provider's configured
// default voice" (caco's azure embedding default). We translate it to "omit
// --voice" so the tts CLI/provider picks its own default.
export const CASCADE_DEFAULT_VOICE_SENTINEL = "embedding:default";

/// Resolve a cascade voice for the tts CLI: the sentinel or an empty value -> undefined
/// (let the provider use its default voice); otherwise the explicit voice. Pure.
export function resolveCascadeTtsVoice(voice) {
  const v = String(voice ?? "").trim();
  if (!v || v === CASCADE_DEFAULT_VOICE_SENTINEL) return undefined;
  return v;
}

// Minimal XML escaping for SSML text/attribute values. Pure.
function xmlEscape(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/// Map a cascade speed multiplier to an Azure SSML <prosody rate> percentage.
/// 1.5 -> "+50%", 0.8 -> "-20%". Returns undefined for ~1.0 (omit prosody). Pure.
export function speedToProsodyRate(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0 || Math.abs(s - 1) < 0.001) return undefined;
  const pct = Math.round((s - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

// Azure personal/embedding voices (mstts:ttsembedding) require <voice name> to be
// a supported BASE MODEL, e.g. DragonLatestNeural / PhoenixLatestNeural — NOT the
// personal-voice nickname. Passing a nickname makes Azure reject the request with
// HTTP 400 (bd-dbfaa7). When a speakerProfileId is present we resolve <voice name>
// to a base model. This is Azure's documented personal-voice default; override
// per-call with `azureBaseVoice`.
export const DEFAULT_AZURE_PERSONAL_VOICE_BASE_MODEL = "DragonLatestNeural";

// A real Azure neural voice name ends in "Neural" (e.g. en-US-AvaNeural,
// DragonLatestNeural). Personal-voice nicknames (MAI-Voice-2) do not.
function isAzureBaseModelVoiceName(v) {
  return /neural$/i.test(String(v ?? "").trim());
}

/// Resolve the SSML <voice name> for Azure synthesis. Without a speakerProfileId
/// the requested voice is a standard voice, used verbatim. WITH a speakerProfileId
/// (personal voice) <voice name> must be a base model: honor an explicitly
/// base-model-shaped voice (…Neural), otherwise fall back to azureBaseVoice / the
/// documented default — never the nickname, which 400s on Azure (bd-dbfaa7). Pure.
export function resolveAzureVoiceName({ voice, speakerProfileId, azureBaseVoice } = {}) {
  const v = String(voice ?? "").trim();
  if (!speakerProfileId) return v;
  if (isAzureBaseModelVoiceName(v)) return v;
  const base = String(azureBaseVoice ?? "").trim();
  return base || DEFAULT_AZURE_PERSONAL_VOICE_BASE_MODEL;
}

// Provider identifier(s) that take direct Azure SSML bodies.
export function isAzureSpeechProvider(provider) {
  return String(provider ?? "").trim().toLowerCase() === AZURE_SPEECH_PROVIDER;
}

// bd-5d4784: Azure personal/embedding voices (mstts ttsembedding, i.e. a
// speakerProfileId is set) REQUIRE the <voice name> to be a base model --
// DragonLatestNeural (higher quality) or PhoenixLatestNeural (lower latency) --
// NOT the custom/personal voice name. A non-base-model name (e.g. MAI-Voice-2)
// with a speaker profile makes Azure reject the request with HTTP 400.
export const AZURE_EMBEDDING_BASE_MODELS = ["DragonLatestNeural", "PhoenixLatestNeural"];

// True when `voice` ends in a known Azure embedding base model (locale-prefixed
// forms like en-US-DragonLatestNeural also match). Pure.
export function isAzureEmbeddingBaseModel(voice) {
  return /(?:Dragon|Phoenix)LatestNeural$/i.test(String(voice ?? "").trim());
}

/// Fail-fast validator for the direct azure-speech embedding path (bd-5d4784,
/// operator-directed): when the azure-speech provider is used WITH a
/// speakerProfileId but the resolved <voice name> is an explicit NON-base-model
/// voice, Azure will 400. Return a clear, actionable error MESSAGE telling the
/// operator to set a base-model voice and how; return null when the config is
/// fine (not azure-speech, no embedding, no explicit voice/sentinel-default, or
/// already a base model). Preferred over silently auto-substituting a base model,
/// which could pick the wrong base for the operator's setup. Pure.
export function azureEmbeddingVoiceError({ provider, voice, speakerProfileId } = {}) {
  if (!isAzureSpeechProvider(provider)) return null;
  if (!speakerProfileId) return null;
  const v = resolveCascadeTtsVoice(voice);
  if (!v) return null; // sentinel/default -> defer to the provider's configured default voice
  if (isAzureEmbeddingBaseModel(v)) return null;
  return `azure-speech embedding voice misconfigured: a speaker profile is set (speaker=${speakerProfileId}) but voice='${v}' is not an Azure base model, so Azure rejects it with HTTP 400. Personal/embedding voices require the <voice name> to be a base model. Fix: set voice=DragonLatestNeural (higher quality) or voice=PhoenixLatestNeural (lower latency) and keep speaker=${speakerProfileId} for the actual voice -- e.g. in /cascade or /rt pass 'voice=DragonLatestNeural speaker=${speakerProfileId}', or set the base-model voice field in your realtime/cascade settings.`;
}

/// Build a direct-Azure mstts SSML body wrapping `text`. voice -> <voice name>,
/// lang -> xml:lang, speed -> <prosody rate>, speakerProfileId -> <mstts:ttsembedding>.
/// speakerProfileId/lang/prosody segments are omitted when not supplied. Pure.
export function buildAzureSpeechSsml({ text, voice, lang, speed, speakerProfileId, azureBaseVoice } = {}) {
  // bd-80663f: Azure Speech REQUIRES xml:lang on <speak> or it rejects the
  // request with HTTP 400. Default to en-US when no lang is supplied so cascade
  // turns invoked without an explicit lang= still synthesize. <voice> xml:lang
  // stays optional (emitted only when lang is explicit) so custom/personal
  // voices are not forced to a default locale.
  const speakLangAttr = ` xml:lang='${xmlEscape(lang || "en-US")}'`;
  const voiceLangAttr = lang ? ` xml:lang='${xmlEscape(lang)}'` : "";
  const rate = speedToProsodyRate(speed);
  let inner = xmlEscape(text);
  if (rate) inner = `<prosody rate='${xmlEscape(rate)}'>${inner}</prosody>`;
  if (speakerProfileId) inner = `<mstts:ttsembedding speakerProfileId='${xmlEscape(speakerProfileId)}'>${inner}</mstts:ttsembedding>`;
  // bd-dbfaa7: personal voices (speakerProfileId) need a base-model <voice name>,
  // not the nickname (which Azure rejects with HTTP 400).
  const name = xmlEscape(resolveAzureVoiceName({ voice, speakerProfileId, azureBaseVoice }));
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts'${speakLangAttr}>`
    + `<voice name='${name}'${voiceLangAttr}>${inner}</voice></speak>`;
}

/// Build the `tts` argv for one-shot PCM synthesis. Text is passed as a
/// positional after `--` (leading-dash safe). By default no provider/model/voice
/// is forced, so the tts CLI inherits the env-configured caco azure defaults. Pure.
export function buildTtsBatchArgs({
  text,
  voice,
  model,
  provider,
  baseUrl,
  responseFormat = "pcm",
  speed,
  instructions,
  speakerProfileId,
  lang,
  azureBaseVoice,
} = {}) {
  const args = ["--stdout", "--response-format", String(responseFormat || "pcm")];
  const v = resolveCascadeTtsVoice(voice);
  if (v) args.push("--voice", v);
  if (model) args.push("--model", String(model));
  if (provider) args.push("--provider", String(provider));
  if (baseUrl) args.push("--base-url", String(baseUrl));
  const azure = isAzureSpeechProvider(provider);
  const s = Number(speed);
  // For azure-speech the SSML <prosody rate> carries speed; don't double-apply --speed.
  if (!azure && Number.isFinite(s) && s > 0 && s !== 1) args.push("--speed", String(speed));
  if (instructions) args.push("--instructions", String(instructions));
  // azure-speech (direct) always sends an SSML body so embedding voices /
  // speakerProfileId / lang / prosody render; other providers get plain text.
  const body = azure
    ? buildAzureSpeechSsml({ text, voice: v, lang, speed, speakerProfileId, azureBaseVoice })
    : String(text ?? "");
  if (body) args.push("--", body);
  return args;
}

/// Synthesize `text` to a raw PCM16/24k/mono Buffer via a one-shot `tts`
/// subprocess. Resolves with the audio Buffer; rejects on empty text, spawn
/// error, a non-zero exit (carrying stderr), or a timeout (bd-29a134: a stalled
/// `tts` child must not hang the "speaking" state forever). `command`/`spawnImpl`
/// injectable; `timeoutMs` defaults to resolveBatchTtsTimeoutMs() (0 = off).
export async function synthesizeToPcm(text, {
  voice,
  model,
  provider,
  baseUrl,
  speed,
  instructions,
  speakerProfileId,
  lang,
  azureBaseVoice,
  responseFormat,
  command = "tts",
  spawnImpl = spawn,
  timeoutMs,
} = {}) {
  const body = String(text ?? "");
  if (!body.trim()) throw new Error("tts: refusing to synthesize empty text");
  // bd-5d4784: fail fast with an actionable notice instead of letting Azure
  // reject an embedding voice + non-base-model <voice name> with a cryptic 400.
  const embErr = azureEmbeddingVoiceError({ provider, voice, speakerProfileId });
  if (embErr) throw new Error(embErr);
  // bd-29a134: bound the tts subprocess wait (shared runBoundedSubprocess) so a
  // stalled child surfaces an error instead of hanging "speaking" forever.
  const timeout = timeoutMs == null ? resolveBatchTtsTimeoutMs() : Number(timeoutMs);
  const { code, stdout, stderr } = await runBoundedSubprocess({
    command,
    args: buildTtsBatchArgs({ text: body, voice, model, provider, baseUrl, speed, instructions, speakerProfileId, lang, azureBaseVoice, responseFormat }),
    spawnImpl,
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: timeout,
    label: "tts",
  });
  if (code === 0) return stdout;
  const errText = stderr.toString("utf8").trim().slice(0, 500);
  throw new Error(`tts exited ${code}${errText ? `: ${errText}` : ""}`);
}

/// Resolve direct Azure Speech endpoint + key from the environment. Endpoint
/// defaults to the eastus speech URL; the key has NO default and is never
/// hardcoded. Pure (env reads only).
export function resolveAzureSpeechCreds({ env = process.env } = {}) {
  const endpoint = String(
    env.AZURE_SPEECH_ENDPOINT || env.PI_RT_AZURE_SPEECH_ENDPOINT || DEFAULT_AZURE_SPEECH_ENDPOINT,
  ).trim().replace(/\/+$/, "");
  const apiKey = String(env.AZURE_SPEECH_API_KEY || env.PI_RT_AZURE_SPEECH_API_KEY || "").trim();
  return { endpoint, apiKey };
}

/// Resolve the effective `speak` tool synthesis params from a tool-call's params
/// plus environment defaults. voice/speaker/lang/speed fall back to PI_CASCADE_*
/// so an operator sets the cascade voice once and the agent just calls speak(text).
/// The cascade voice sentinel resolves to undefined; the caller requires a
/// concrete Azure voice for the direct path. Pure (env reads only).
export function resolveSpeakToolParams(params = {}, { env = process.env } = {}) {
  const text = String(params.text ?? "").trim();
  const voice = resolveCascadeTtsVoice(params.voice ?? env.PI_CASCADE_SPEAK_VOICE ?? env.PI_CASCADE_VOICE);
  const speakerProfileId = (params.speaker ?? params.speakerProfileId ?? env.PI_CASCADE_SPEAKER ?? env.PI_CASCADE_SPEAKER_PROFILE_ID) || undefined;
  const lang = (params.lang ?? env.PI_CASCADE_LANG) || undefined;
  const speedSrc = params.speed != null && params.speed !== "" ? params.speed : env.PI_CASCADE_SPEED;
  const speedNum = Number(speedSrc);
  const speed = Number.isFinite(speedNum) && speedNum > 0 ? speedNum : undefined;
  return { text, voice, speakerProfileId, lang, speed };
}

// --- Auto-speak agent replies (bd-095b3d) ---
//
// When the operator is in a voice session (/rt stt local-vad feeds their speech
// to the REAL Pi agent via sendUserMessage), "speak-replies" mode auto-speaks the
// agent's own reply so n=1 is genuinely the operator's agent (tools/history/MCP)
// with voice I/O, not a stateless completion. These pure helpers extract the
// spoken text from an agent_end message list; the extension gates + synthesises.

/// Extract the spoken text from one assistant message. Tolerates string content
/// and the array-of-parts shape; returns "" for tool-call-only / empty turns. Pure.
export function assistantReplyText(message) {
  if (!message || message.role !== "assistant") return "";
  const c = message.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && (p.type === "text" || typeof p === "string"))
      .map((p) => (typeof p === "string" ? p : (p.text || "")))
      .join("")
      .trim();
  }
  return "";
}

/// From an agent_end message list, return { text, key } for the most recent
/// assistant reply. `key` (timestamp:textPrefix) lets the caller dedupe so a
/// reply is never spoken twice. text is "" when the last assistant turn has no
/// speakable text (e.g. a tool-call-only turn). Pure.
export function pickLastAssistantReply(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = [...list].reverse().find((m) => m && m.role === "assistant");
  if (!last) return { text: "", key: "" };
  const text = assistantReplyText(last);
  const key = text ? `${last.timestamp ?? ""}:${text.slice(0, 64)}` : "";
  return { text, key };
}

/// Extract a thinking/reasoning summary from an assistant message, if the model
/// surfaced one — content parts of type thinking/reasoning/reasoning_summary, or a
/// top-level reasoning/thinking field. Returns "" when none. Only voiced when the
/// opt-in speakThinking mode is on (off by default); a no-op if Pi doesn't expose
/// summaries in the message. Pure. (bd-095b3d)
export function thinkingSummaryText(message) {
  if (!message || message.role !== "assistant") return "";
  const c = message.content;
  if (Array.isArray(c)) {
    const t = c
      .filter((p) => p && (p.type === "thinking" || p.type === "reasoning" || p.type === "reasoning_summary"))
      .map((p) => (typeof p === "string" ? p : (p.text || p.summary || p.thinking || "")))
      .join("")
      .trim();
    if (t) return t;
  }
  const r = message.reasoning ?? message.reasoningText ?? message.thinking ?? message.thinkingSummary;
  return typeof r === "string" ? r.trim() : "";
}

/// Bound a (possibly long) thinking/reasoning string to a listenable spoken gist:
/// return it whole when short, else cut at the last sentence end within maxChars
/// (falling back to a word boundary) with a trailing ellipsis. A raw claude
/// thinking trace can be thousands of chars — voicing all of it is an unlistenable
/// monologue, so speak-thinking voices only this gist. Pure. (bd-551e93)
export function boundThinkingForSpeech(text, maxChars = 320) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length <= maxChars) return s;
  const window = s.slice(0, maxChars);
  // Prefer the longest run ending at sentence punctuation within the window.
  const sentence = window.match(/^[\s\S]*[.!?](?=\s|$)/);
  let cut = sentence ? sentence[0] : window;
  if (!sentence) {
    // No sentence end: fall back to the last word boundary so we don't slice mid-word.
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > 40) cut = cut.slice(0, lastSpace);
  }
  cut = cut.trim().replace(/[\s,;:\u2013-]+$/, "");
  return `${cut}\u2026`;
}

/// Synthesize `text` to a raw PCM16/24k/mono Buffer via a DIRECT Azure Speech
/// REST call (no subprocess): POST <endpoint>/cognitiveservices/v1 with the mstts
/// SSML body (voice + ttsembedding speakerProfileId + lang + prosody). The
/// subscription key travels in the Ocp-Apim-Subscription-Key header and is never
/// logged. `fetchImpl` injectable for tests. Resolves with the PCM Buffer; rejects
/// on empty text, missing endpoint/key, or a non-2xx response.
export async function synthesizeAzureSpeechDirect({
  text,
  voice,
  lang,
  speed,
  speakerProfileId,
  azureBaseVoice,
  endpoint,
  apiKey,
  outputFormat = DEFAULT_AZURE_SPEECH_OUTPUT_FORMAT,
  fetchImpl,
  timeoutMs,
  signal,
} = {}) {
  const body = String(text ?? "");
  if (!body.trim()) throw new Error("azure-speech: refusing to synthesize empty text");
  const ep = String(endpoint ?? "").trim().replace(/\/+$/, "");
  if (!ep) throw new Error("azure-speech: no endpoint (set AZURE_SPEECH_ENDPOINT)");
  if (!apiKey) throw new Error("azure-speech: no API key (set AZURE_SPEECH_API_KEY)");
  const doFetch = typeof fetchImpl === "function"
    ? fetchImpl
    : (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw new Error("azure-speech: no fetch implementation available");
  const ssml = buildAzureSpeechSsml({ text: body, voice, lang, speed, speakerProfileId, azureBaseVoice });
  // bd-29a134: bound the Azure Speech HTTP await so a hung upstream surfaces an
  // error instead of stalling the cascade; also honors an incoming cancel.
  const timeout = timeoutMs == null ? resolveBatchTtsTimeoutMs() : Number(timeoutMs);
  const bound = combineTimeoutSignal(signal, timeout);
  let res;
  try {
    res = await doFetch(`${ep}/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": apiKey,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": String(outputFormat || DEFAULT_AZURE_SPEECH_OUTPUT_FORMAT),
        "User-Agent": "pi-realtime-cascade",
      },
      body: ssml,
      signal: bound.signal,
    });
  } catch (err) {
    if (bound.isTimeout()) throw new Error(`azure-speech timed out after ${timeout}ms`);
    throw err;
  } finally {
    bound.cleanup();
  }
  if (!res || res.ok === false) {
    const status = res?.status ?? "??";
    let detail = "";
    try { detail = String(await res.text()).slice(0, 300); } catch {}
    throw new Error(`azure-speech HTTP ${status}${detail ? `: ${detail}` : ""}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
