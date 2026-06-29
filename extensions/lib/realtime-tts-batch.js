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

// Provider identifier(s) that take direct Azure SSML bodies.
export function isAzureSpeechProvider(provider) {
  return String(provider ?? "").trim().toLowerCase() === AZURE_SPEECH_PROVIDER;
}

/// Build a direct-Azure mstts SSML body wrapping `text`. voice -> <voice name>,
/// lang -> xml:lang, speed -> <prosody rate>, speakerProfileId -> <mstts:ttsembedding>.
/// speakerProfileId/lang/prosody segments are omitted when not supplied. Pure.
export function buildAzureSpeechSsml({ text, voice, lang, speed, speakerProfileId } = {}) {
  const langAttr = lang ? ` xml:lang='${xmlEscape(lang)}'` : "";
  const rate = speedToProsodyRate(speed);
  let inner = xmlEscape(text);
  if (rate) inner = `<prosody rate='${xmlEscape(rate)}'>${inner}</prosody>`;
  if (speakerProfileId) inner = `<mstts:ttsembedding speakerProfileId='${xmlEscape(speakerProfileId)}'>${inner}</mstts:ttsembedding>`;
  const name = xmlEscape(voice || "");
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts'${langAttr}>`
    + `<voice name='${name}'${langAttr}>${inner}</voice></speak>`;
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
    ? buildAzureSpeechSsml({ text, voice: v, lang, speed, speakerProfileId })
    : String(text ?? "");
  if (body) args.push("--", body);
  return args;
}

/// Synthesize `text` to a raw PCM16/24k/mono Buffer via a one-shot `tts`
/// subprocess. Resolves with the audio Buffer; rejects on empty text, spawn
/// error, or a non-zero exit (carrying stderr). `command`/`spawnImpl` injectable.
export function synthesizeToPcm(text, {
  voice,
  model,
  provider,
  baseUrl,
  speed,
  instructions,
  speakerProfileId,
  lang,
  responseFormat,
  command = "tts",
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const body = String(text ?? "");
    if (!body.trim()) {
      reject(new Error("tts: refusing to synthesize empty text"));
      return;
    }
    let proc;
    try {
      proc = spawnImpl(
        command,
        buildTtsBatchArgs({ text: body, voice, model, provider, baseUrl, speed, instructions, speakerProfileId, lang, responseFormat }),
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const errChunks = [];
    proc.stdout?.on("data", (d) => out.push(Buffer.from(d)));
    proc.stderr?.on("data", (d) => errChunks.push(Buffer.from(d)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        const errText = Buffer.concat(errChunks).toString("utf8").trim().slice(0, 500);
        reject(new Error(`tts exited ${code}${errText ? `: ${errText}` : ""}`));
      }
    });
  });
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
  endpoint,
  apiKey,
  outputFormat = DEFAULT_AZURE_SPEECH_OUTPUT_FORMAT,
  fetchImpl,
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
  const ssml = buildAzureSpeechSsml({ text: body, voice, lang, speed, speakerProfileId });
  const res = await doFetch(`${ep}/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": String(outputFormat || DEFAULT_AZURE_SPEECH_OUTPUT_FORMAT),
      "User-Agent": "pi-realtime-cascade",
    },
    body: ssml,
  });
  if (!res || res.ok === false) {
    const status = res?.status ?? "??";
    let detail = "";
    try { detail = String(await res.text()).slice(0, 300); } catch {}
    throw new Error(`azure-speech HTTP ${status}${detail ? `: ${detail}` : ""}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
