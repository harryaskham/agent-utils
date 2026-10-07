// OpenAI-compatible audio/speech. Always PCM16/24 kHz/mono for shared players.
import { speechHttp, speechUrl } from "./speech-http.js";

export const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_OPENAI_TTS_VOICE = "alloy";

export function buildOpenAiSpeechRequest(text, options = {}) {
  const env = options.env ?? process.env;
  if (!String(text).trim() || Buffer.byteLength(String(text)) > 1024 * 1024) throw new Error("openai speech: text must contain 1–1048576 bytes");
  if (options.embedding || options.speakerProfileId || String(options.voice || "").startsWith("embedding:") || options.ssml) {
    throw new Error("openai speech: Azure embeddings/SSML are unsupported; choose an OpenAI voice");
  }
  const model = options.model || env.OPENAI_TTS_MODEL || DEFAULT_OPENAI_TTS_MODEL;
  const voice = options.voice || env.OPENAI_TTS_VOICE || DEFAULT_OPENAI_TTS_VOICE;
  const speed = options.speed ?? 1;
  if (!Number.isFinite(speed) || speed < .25 || speed > 4) throw new Error("openai speech: speed must be between 0.25 and 4");
  for (const value of [model, voice, options.lang, options.style, options.role]) {
    if (value != null && (typeof value !== "string" || Buffer.byteLength(value) > 512 || /[\x00-\x1f\x7f]/.test(value))) throw new Error("openai speech: invalid text option");
  }
  const parts = [];
  if (options.instructions) parts.push(String(options.instructions).trim());
  if (options.lang) parts.push(`Speak in the language ${options.lang}.`);
  if (options.style && options.style !== "none") {
    parts.push(`Speak in a ${options.style} style.`);
    const degree = options.styleDegree ?? options.styledegree;
    if (degree != null) {
      if (!Number.isFinite(degree) || degree < .01 || degree > 2) throw new Error("openai speech: styledegree must be between 0.01 and 2");
      parts.push(`Use style intensity ${degree} on a scale where 1 is normal and 2 is strong.`);
    }
  } else if ((options.styleDegree ?? options.styledegree) != null) throw new Error("openai speech: styledegree requires style");
  if (options.role) parts.push(`Speak as if you are imitating ${options.role}.`);
  if (options.pitch != null) {
    if (!Number.isFinite(options.pitch) || options.pitch < -50 || options.pitch > 50) throw new Error("openai speech: pitch must be between -50 and 50");
    if (options.pitch) parts.push(`Use a pitch ${Math.abs(options.pitch)}% ${options.pitch > 0 ? "higher" : "lower"} than your normal pitch.`);
  }
  if (options.volume != null) {
    if (!Number.isFinite(options.volume) || options.volume < 0 || options.volume > 100) throw new Error("openai speech: volume must be between 0 and 100");
    if (options.volume !== 100) parts.push(`Use ${options.volume}% of your normal speaking volume.`);
  }
  const instructions = parts.join(" ");
  if (Buffer.byteLength(instructions) > 20480 || instructions.includes("\0")) throw new Error("openai speech: invalid or oversized instructions");
  if (instructions && ["tts-1", "tts-1-hd"].includes(model.split("/").at(-1))) throw new Error("openai speech: this model does not support instructions/style; select a prompted voice model");
  return { model, input: String(text), voice, response_format: "pcm", speed, ...(instructions ? { instructions } : {}) };
}

export async function synthesizeOpenAiSpeech(text, options = {}) {
  const env = options.env ?? process.env;
  const request = buildOpenAiSpeechRequest(text, options);
  const url = speechUrl(options.endpoint ?? options.baseUrl ?? env.PI_TTS_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", "/audio/speech");
  const apiKey = options.apiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("openai speech: no API key (set OPENAI_API_KEY)");
  const pcm = await speechHttp(url, {
    fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: options.timeoutMs ?? 30000,
    label: "openai speech", method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(request),
  });
  if (!pcm.length || pcm.length % 2) throw new Error("openai speech: invalid PCM response");
  return pcm;
}
