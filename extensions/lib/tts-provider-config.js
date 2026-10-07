import { normalizeTtsProvider, DEFAULT_TTS_VOICE, DEFAULT_TTS_LANG, DEFAULT_TTS_SPEED, DEFAULT_TTS_EMBEDDING } from "./tts.js";
import { DEFAULT_OPENAI_TTS_MODEL, DEFAULT_OPENAI_TTS_VOICE } from "./tts-openai.js";
import { speechReplacesPrevious } from "./speech-requests.js";

export function speechPan(value) {
  if (value === undefined) return undefined;
  if (value === null || /^(none|null|unset)$/i.test(String(value).trim())) return null;
  const pan = Number(value);
  if (!["string", "number"].includes(typeof value) || String(value).trim() === "" || !Number.isFinite(pan) || pan < -1 || pan > 1) throw new Error("tts: pan must be between -1 and 1, or none");
  return pan;
}

export function ttsProviderDefaults(provider, env = {}) {
  provider = normalizeTtsProvider(provider);
  if (provider === "azure" || provider === "command") return { voice: DEFAULT_TTS_VOICE, lang: DEFAULT_TTS_LANG, speed: DEFAULT_TTS_SPEED, embedding: DEFAULT_TTS_EMBEDDING, model: undefined, endpoint: env.AZURE_SPEECH_ENDPOINT || undefined };
  if (provider === "openai") return { voice: env.OPENAI_TTS_VOICE || DEFAULT_OPENAI_TTS_VOICE, model: env.OPENAI_TTS_MODEL || DEFAULT_OPENAI_TTS_MODEL, lang: undefined, speed: 1, embedding: null, endpoint: env.PI_TTS_BASE_URL || env.OPENAI_BASE_URL || undefined };
  // Omission is intentional: the daemon owns provider/model/voice defaults.
  return { voice: undefined, model: undefined, lang: undefined, speed: undefined, embedding: undefined, endpoint: undefined };
}

export function ttsSynthesisOptions(config, extra = {}) {
  const result = {};
  for (const key of ["provider", "voice", "model", "lang", "speed", "style", "styleDegree", "endpoint", "apiKey", "instructions", "pitch", "volume", "role", "daemonUrl", "daemonProvider", "tokenFile", "daemonSink", "playback", "timeoutMs", "streamName", "pan", "panSource"]) {
    if (config[key] !== undefined) result[key] = config[key];
  }
  if (config.embedding !== undefined) result.speakerProfileId = config.embedding;
  return { ...result, ...extra };
}

export function speechCredentialStatus(config, env = process.env) {
  const provider = normalizeTtsProvider(config.provider);
  if (provider === "daemon") return `auth:${env.TTS_DAEMON_TOKEN || env.TTS_DAMEON_TOKEN ? "env-token" : "token-file"} · playback:${config.playback || "daemon"} · interrupt:${speechReplacesPrevious(config) ? "replace" : "queue"} · cancel:capability-gated`;
  if (provider === "command") return "auth:command";
  const key = provider === "openai" ? "OPENAI_API_KEY" : "AZURE_SPEECH_API_KEY";
  return `api-key:${config.apiKey ? "override" : env[key] ? "env" : "missing"}`;
}
