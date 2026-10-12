import { normalizeTtsProvider, DEFAULT_TTS_VOICE, DEFAULT_TTS_LANG, DEFAULT_TTS_SPEED, DEFAULT_TTS_EMBEDDING } from "./tts.js";
import { DEFAULT_OPENAI_TTS_MODEL, DEFAULT_OPENAI_TTS_VOICE } from "./tts-openai.js";
import { speechReplacesPrevious } from "./speech-requests.js";
import { azureAuthSettings } from "./azure-speech-auth.js";
import { resolveAudioConnection, withAudioConnection } from "./audio-providers.js";

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
  for (const key of ["provider", "providerName", "audioProviders", "voice", "model", "lang", "speed", "style", "styleDegree", "endpoint", "apiKey", "auth", "az", "resource", "tenant", "subscription", "resourceId", "instructions", "pitch", "volume", "role", "daemonUrl", "daemonProvider", "tokenFile", "daemonSink", "playback", "timeoutMs", "streamName", "pan", "panSource"]) {
    if (config[key] !== undefined) result[key] = config[key];
  }
  if (config.embedding !== undefined) result.speakerProfileId = config.embedding;
  return withAudioConnection({ ...result, ...extra }, { kind: "tts" });
}

export function speechCredentialStatus(config, env = process.env) {
  let connection;
  try { connection = config.providerName ? resolveAudioConnection(config.providerName, { kind: "tts", env, audioProviders: config.audioProviders }) : undefined; } catch (error) { return `audio-provider:${config.providerName} invalid (${error.message})`; }
  if (connection) {
    const auth = connection.type === "azure" ? (connection.auth === "entra" ? `entra · broker:${connection.az || "az"}` : `key:${connection.apiKeyEnv || "default-env"}`)
      : connection.type === "openai" ? `key:${connection.apiKeyEnv || "default-env"}` : connection.type === "daemon" ? "daemon-token" : "command";
    return `audio-provider:${connection.name} · auth:${auth}`;
  }
  const provider = normalizeTtsProvider(config.provider);
  if (provider === "daemon") return `auth:${env.TTS_DAEMON_TOKEN || env.TTS_DAMEON_TOKEN ? "env-token" : "token-file"} · playback:${config.playback || "daemon"} · interrupt:${speechReplacesPrevious(config) ? "replace" : "queue"} · cancel:capability-gated`;
  if (provider === "command") return "auth:command";
  if (provider === "azure") {
    const auth = azureAuthSettings({ env, options: config });
    if (auth.auth === "entra") return `auth:entra · broker:${auth.az} · refresh:on-demand`;
  }
  const key = provider === "openai" ? "OPENAI_API_KEY" : "AZURE_SPEECH_API_KEY";
  return `api-key:${config.apiKey ? "override" : env[key] ? "env" : "missing"}`;
}
