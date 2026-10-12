// One provider resolver for /stt, /ptt, choice freeform and cascade input.
import { transcribeAudioDirect, transcribeMaiAudioDirect, pcmToWav } from "./realtime-stt-batch.js";
import { transcribeDaemonAudio } from "./speech-daemon.js";
import { azureAuthSettings } from "./azure-speech-auth.js";
import { selectAudioProvider, withAudioConnection } from "./audio-providers.js";

export function selectSttProvider(value = "auto", options = {}) {
  try { return selectAudioProvider(String(value || "auto"), { ...options, kind: "stt" }); }
  catch (error) { throw new Error(`stt: provider must be auto, azure, openai, daemon, or a configured audio provider name (${error.message})`); }
}
export function normalizeSttProvider(value = "auto", options) { return selectSttProvider(value, options).provider; }
export function sttSettingsResolver(audioProviders) { return (env, persisted) => resolveSttSettings(env, persisted, {}, audioProviders); }
export function resolveSttSettings(env = process.env, persisted = {}, inheritedTts = {}, audioProviders) {
  const selection = selectSttProvider(env.PI_STT_PROVIDER ?? persisted.provider, { audioProviders });
  const { provider } = selection;
  if (env.PI_STT_PROVIDER && String(env.PI_STT_PROVIDER).trim().toLowerCase() !== String(persisted.provider || "auto").trim().toLowerCase()) {
    persisted = { ...persisted };
    for (const key of ["model", "endpoint", "prompt", "streamingModel"]) delete persisted[key];
  }
  const azure = ["azure", "auto"].includes(provider) ? azureAuthSettings({ env, persisted, inherited: inheritedTts, kind: "stt" }) : {};
  return {
    ...selection, ...azure, ...(audioProviders ? { audioProviders } : {}),
    model: env.PI_RT_LOCAL_VAD_MODEL || env.PI_STT_MODEL || persisted.model || (provider === "daemon" ? undefined : provider === "openai" ? env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe" : "mai-transcribe-2"),
    endpoint: env.PI_STT_ENDPOINT || persisted.endpoint || (["azure", "auto"].includes(provider) ? persisted.providers?.azure?.endpoint : undefined),
    daemonUrl: env.PI_STT_DAEMON_URL || env.STT_DAEMON_URL || persisted.daemonUrl,
    daemonProvider: env.PI_STT_DAEMON_PROVIDER || persisted.daemonProvider,
    streamingModel: env.PI_STT_STREAMING_MODEL || persisted.streamingModel,
    tokenFile: env.STT_TOKEN_FILE || persisted.tokenFile,
    language: env.PI_STT_LANGUAGE || env.STT_LANGUAGE || persisted.language,
    prompt: env.PI_STT_PROMPT ?? persisted.prompt,
    timeoutMs: Number(env.PI_RT_LOCAL_VAD_TIMEOUT_MS ?? persisted.timeoutMs ?? 30000),
  };
}
export async function transcribeSpeech(pcm, options = {}) {
  const env = options.env ?? process.env;
  const selected = options.providerName || options.provider || env.PI_STT_PROVIDER;
  let settings = { ...resolveSttSettings({ ...env, ...(selected !== undefined ? { PI_STT_PROVIDER: selected } : {}) }, options.persisted, options.persistedTts, options.audioProviders), ...options };
  Object.assign(settings, selectSttProvider(selected ?? settings.providerName ?? settings.provider, { audioProviders: settings.audioProviders }));
  if (!settings.wav && (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 25 * 1024 * 1024 - 44)) throw new Error("transcribe: expected bounded PCM16 audio");
  const auto = settings.provider === "auto";
  const azureSettings = ["auto", "azure"].includes(settings.provider)
    ? withAudioConnection({ ...settings, env, providerName: auto ? "azure" : settings.providerName }, { kind: "stt" }) : settings;
  const azureEndpoint = azureSettings.endpoint || env.AZURE_STT_ENDPOINT || env.AZURE_EASTUS_ENDPOINT;
  const azureKey = azureSettings.apiKey ?? env.AZURE_STT_API_KEY ?? env.AZURE_EASTUS_API_KEY;
  const azure = settings.provider === "azure" || (auto && String(settings.model).startsWith("mai-transcribe-") && (azureKey || azureSettings.auth === "entra") && azureEndpoint);
  if (azure) {
    if (settings.prompt) throw new Error("transcribe: Azure MAI does not support prompt");
    if (!azureEndpoint) throw new Error("transcribe: set AZURE_STT_ENDPOINT or an Azure audio provider endpoint");
    return transcribeMaiAudioDirect({ ...azureSettings, pcm, endpoint: azureEndpoint, apiKey: azureKey, deployment: azureSettings.deployment ?? env.PI_RT_LOCAL_VAD_DEPLOYMENT });
  }
  settings = withAudioConnection({ ...settings, env, ...(auto ? { providerName: "openai" } : {}) }, { kind: "stt" });
  if (settings.provider === "daemon") return transcribeDaemonAudio(settings.wav ?? pcmToWav(pcm), settings);
  return transcribeAudioDirect({ ...settings, pcm,
    baseUrl: settings.endpoint || env.PI_STT_BASE_URL || env.PI_RT_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: settings.apiKey ?? env.PI_RT_API_KEY ?? env.OPENAI_API_KEY,
  });
}
