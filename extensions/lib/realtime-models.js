// Realtime model + voice configuration constants and normalization helpers
// extracted from realtime-agent.js (bd-e1914a). Pure over inputs + env; the only
// dependency is the env reader from realtime-helpers.

import { env } from "./realtime-helpers.js";

export const DEFAULT_MODEL = "gpt-realtime-2";
export const SUPPORTED_REALTIME_MODELS = new Set(["gpt-realtime-2", "gpt-realtime"]);
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
export const DEFAULT_VOICE = "marin";
export const REALTIME_VOICES = new Set([
  "alloy", "ash", "ballad", "coral", "echo",
  "sage", "shimmer", "verse", "marin", "cedar",
]);

export function isRealtimeModel(model) {
  const id = String(model?.id || "");
  const provider = String(model?.provider || "");
  return provider === "openai-realtime" || id.startsWith("gpt-realtime");
}

export function normalizeRealtimeModelId(raw) {
  const value = String(raw || "").trim();
  if (!value) return DEFAULT_MODEL;
  const id = value.includes("/") ? value.split("/").pop() : value;
  return SUPPORTED_REALTIME_MODELS.has(id) ? id : DEFAULT_MODEL;
}

export function normalizeTranscriptionModel(raw) {
  // Historical env had OPENAI_REALTIME_TRANSCRIPTION_MODEL=whisper; for the
  // realtime proxy we want the explicit realtime deployment by default.
  if (!raw || raw === "whisper") return DEFAULT_TRANSCRIPTION_MODEL;
  return raw;
}

export function resolveRealtimeVoice(fallback) {
  const raw = env("PI_RT_VOICE", "OPENAI_TTS_VOICE", "TTS_VOICE") || fallback || DEFAULT_VOICE;
  return REALTIME_VOICES.has(raw) ? raw : DEFAULT_VOICE;
}

export function shouldAutoRestartMicMode(mode) {
  return mode === "vad" || mode === "continuous";
}
