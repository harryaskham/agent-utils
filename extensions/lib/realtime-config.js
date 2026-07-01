// Pure config builders for the realtime agent extension.
//
// Reads PI_RT_* / OPENAI_* / AZURE_* environment variables and normalizes them
// into config objects consumed by RealtimeSession and the realtime controls.
// These are intentionally side-effect free (env reads only) so they can be
// unit-tested in isolation.

import { env, envBool, numberEnv, parseRealtimeSpeed, parseVadThreshold } from "./realtime-helpers.js";
import { normalizeRealtimeModelId, normalizeTranscriptionModel, resolveRealtimeVoice } from "./realtime-models.js";
import { readPersistedRealtimeSettings, readPersistedSttSettings } from "./realtime-settings.js";

// Default direct-Azure realtime target: the gpt-realtime-2 GA deployment in the
// canadacentral sandbox (a proven, shared endpoint — gpt-realtime-whisper lives
// there too). GA realtime requires the unversioned path
// (/openai/v1/realtime?model=<deployment>); the preview api-version path was
// deprecated 2026-04-30, so the default api-version is "none" (omitted), NOT the
// old 2025-04-01-preview. The API key is intentionally NOT hardcoded here — it is
// read at connect time from PI_RT_AZURE_API_KEY / AZURE_CANADACENTRAL_API_KEY (sops).
export const DEFAULT_AZURE_ENDPOINT = "https://harryaskham-sandbox-ais-ccan.cognitiveservices.azure.com";
export const DEFAULT_AZURE_API_VERSION = "none";

// Direct-Azure realtime default resolution (bd-8b6f12). Azure is the DEFAULT now
// because the default realtime model gpt-realtime-2 is GA-only and the LiteLLM
// proxy beta-routes/rejects it ("only available on the GA API", bd-0b40ce), so a
// proxy default is broken for the default model. Explicit overrides win:
//   PI_RT_PROVIDER=azure            -> force direct-Azure
//   PI_RT_PROVIDER=openai|proxy     -> force the proxy/OpenAI path
//   PI_RT_DIRECT_AZURE=0|1          -> force either
// Otherwise default to direct-Azure.
export function resolveDirectAzureDefault({ env: read = env, persistedDirectAzure } = {}) {
  const provider = (read("PI_RT_PROVIDER") || "").toLowerCase();
  if (provider === "azure") return true;
  if (provider === "openai" || provider === "proxy") return false;
  // env PI_RT_DIRECT_AZURE wins; else the persisted settings.json value
  // (bd-7217db); else default to direct-Azure.
  if (read("PI_RT_DIRECT_AZURE") === undefined && typeof persistedDirectAzure === "boolean") {
    return persistedDirectAzure;
  }
  return envBool("PI_RT_DIRECT_AZURE", true);
}

// Server-side VAD turn-detection descriptor sent on session.update. Options
// override the PI_RT_VAD_* env defaults.
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

export function makeInitialConfig(options = {}) {
  // Persisted runtime /rt value settings (bd-7217db). Precedence is
  // env (PI_RT_*/OPENAI_*/AZURE_*) > persisted settings.json > default, so an
  // explicit env override always wins and persistence only fills the gap.
  // Tests pass options.persisted to stay deterministic regardless of host state.
  const persisted = options.persisted ?? readPersistedRealtimeSettings();
  // Durable STT defaults (bd-b45224): the stt-specific fields (transcriptionModel,
  // vadThreshold) also read from the explicit agentUtils.stt slice as a fallback
  // BELOW the realtime slice, so an operator can keep durable stt defaults in
  // their own block. env still wins at runtime and is never written back.
  const persistedStt = options.persistedStt ?? readPersistedSttSettings();
  return {
    baseUrl: (env("PI_RT_BASE_URL", "OPENAI_BASE_URL") ?? persisted.baseUrl) || "https://api.openai.com",
    model: normalizeRealtimeModelId(env("PI_RT_MODEL", "OPENAI_REALTIME_MODEL") ?? persisted.model),
    // OpenAI removed the Realtime Beta opt-in header (OpenAI-Beta: realtime=v1)
    // for GA on 2026-05-12; GA models reject it (bd-0b40ce). Default off; set
    // PI_RT_BETA_HEADER=1 only for a legacy/self-hosted beta realtime endpoint.
    betaHeader: envBool("PI_RT_BETA_HEADER", false),
    directAzure: resolveDirectAzureDefault({ persistedDirectAzure: persisted.directAzure }),
    azureEndpoint: (env("PI_RT_AZURE_ENDPOINT", "AZURE_CANADACENTRAL_ENDPOINT", "AZURE_OPENAI_ENDPOINT") ?? persisted.azureEndpoint) || DEFAULT_AZURE_ENDPOINT,
    azureDeployment: (env("PI_RT_AZURE_DEPLOYMENT", "AZURE_CANADACENTRAL_DEPLOYMENT") ?? persisted.azureDeployment) || normalizeRealtimeModelId(env("PI_RT_MODEL", "OPENAI_REALTIME_MODEL") ?? persisted.model),
    // GA realtime models (gpt-realtime-2) must OMIT api-version (default "none");
    // the old 2025-04-01-preview path was deprecated 2026-04-30 (bd-cb74b5).
    azureApiVersion: (env("PI_RT_AZURE_API_VERSION", "AZURE_OPENAI_API_VERSION") ?? persisted.azureApiVersion) || DEFAULT_AZURE_API_VERSION,
    azureProtocol: (env("PI_RT_AZURE_PROTOCOL") ?? persisted.azureProtocol) || "v1",
    transcriptionModel: normalizeTranscriptionModel(env("PI_RT_TRANSCRIPTION_MODEL", "OPENAI_REALTIME_TRANSCRIPTION_MODEL") ?? persisted.transcriptionModel ?? persistedStt.transcriptionModel),
    voice: resolveRealtimeVoice(persisted.voice),
    speed: parseRealtimeSpeed(env("PI_RT_SPEED", "OPENAI_REALTIME_SPEED") ?? persisted.speed, 1.0),
    vadThreshold: parseVadThreshold(env("PI_RT_VAD_THRESHOLD") ?? persisted.vadThreshold ?? persistedStt.vadThreshold, 0.7),
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
