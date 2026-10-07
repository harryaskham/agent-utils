// One provider resolver for /stt, /ptt, choice freeform and cascade input.
import { transcribeAudioDirect, transcribeMaiAudioDirect, pcmToWav } from "./realtime-stt-batch.js";
import { transcribeDaemonAudio } from "./speech-daemon.js";

export function normalizeSttProvider(value = "auto") {
  const provider = String(value || "auto").toLowerCase().trim();
  if (["auto", "azure", "openai", "daemon"].includes(provider)) return provider;
  throw new Error("stt: provider must be auto, azure, openai or daemon");
}

export function resolveSttSettings(env = process.env, persisted = {}) {
  const provider = normalizeSttProvider(env.PI_STT_PROVIDER ?? persisted.provider);
  if (env.PI_STT_PROVIDER && provider !== normalizeSttProvider(persisted.provider)) {
    persisted = { ...persisted };
    for (const key of ["model", "endpoint", "prompt", "streamingModel"]) delete persisted[key];
  }
  return {
    provider,
    model: env.PI_RT_LOCAL_VAD_MODEL || env.PI_STT_MODEL || persisted.model || (provider === "daemon" ? undefined : provider === "openai" ? env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe" : "mai-transcribe-2"),
    endpoint: env.PI_STT_ENDPOINT || persisted.endpoint,
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
  const settings = { ...resolveSttSettings({ ...env, ...(options.provider !== undefined ? { PI_STT_PROVIDER: options.provider } : {}) }, options.persisted), ...options };
  const provider = normalizeSttProvider(settings.provider);
  if (!settings.wav && (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 25 * 1024 * 1024 - 44)) throw new Error("transcribe: expected bounded PCM16 audio");
  if (provider === "daemon") return transcribeDaemonAudio(settings.wav ?? pcmToWav(pcm), settings);
  const azureEndpoint = settings.endpoint || env.AZURE_STT_ENDPOINT || env.AZURE_EASTUS_ENDPOINT;
  const azureKey = settings.apiKey ?? env.AZURE_STT_API_KEY ?? env.AZURE_EASTUS_API_KEY;
  const azure = provider === "azure" || (provider === "auto" && String(settings.model).startsWith("mai-transcribe-") && azureKey && azureEndpoint);
  if (azure) {
    if (settings.prompt) throw new Error("transcribe: Azure MAI does not support prompt");
    if (!azureKey || !azureEndpoint) throw new Error("transcribe: set AZURE_STT_ENDPOINT and AZURE_STT_API_KEY");
    return transcribeMaiAudioDirect({ ...settings, pcm, endpoint: azureEndpoint, apiKey: azureKey, deployment: env.PI_RT_LOCAL_VAD_DEPLOYMENT });
  }
  return transcribeAudioDirect({ ...settings, pcm,
    baseUrl: settings.endpoint || env.PI_STT_BASE_URL || env.PI_RT_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: settings.apiKey ?? env.PI_RT_API_KEY ?? env.OPENAI_API_KEY,
  });
}
