// Pure config builders for the realtime agent extension.
//
// Reads PI_RT_* / OPENAI_* / AZURE_* environment variables and normalizes them
// into config objects consumed by RealtimeSession and the realtime controls.
// These are intentionally side-effect free (env reads only) so they can be
// unit-tested in isolation.

import { env, envBool, numberEnv, parseRealtimeSpeed, parseVadThreshold } from "./realtime-helpers.js";
import { normalizeRealtimeModelId, normalizeTranscriptionModel, resolveRealtimeVoice } from "./realtime-models.js";

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

export function makeInitialConfig() {
  return {
    baseUrl: env("PI_RT_BASE_URL", "OPENAI_BASE_URL") || "https://api.openai.com",
    model: normalizeRealtimeModelId(env("PI_RT_MODEL", "OPENAI_REALTIME_MODEL")),
    // OpenAI removed the Realtime Beta opt-in header (OpenAI-Beta: realtime=v1)
    // for GA on 2026-05-12; GA models reject it (bd-0b40ce). Default off; set
    // PI_RT_BETA_HEADER=1 only for a legacy/self-hosted beta realtime endpoint.
    betaHeader: envBool("PI_RT_BETA_HEADER", false),
    directAzure: envBool("PI_RT_DIRECT_AZURE", false) || (env("PI_RT_PROVIDER") || "").toLowerCase() === "azure",
    azureEndpoint: env("PI_RT_AZURE_ENDPOINT", "AZURE_CANADACENTRAL_ENDPOINT", "AZURE_OPENAI_ENDPOINT"),
    azureDeployment: env("PI_RT_AZURE_DEPLOYMENT", "AZURE_CANADACENTRAL_DEPLOYMENT") || normalizeRealtimeModelId(env("PI_RT_MODEL", "OPENAI_REALTIME_MODEL")),
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
