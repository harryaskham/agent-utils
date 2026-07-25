// Realtime model + voice configuration constants and normalization helpers
// extracted from realtime-agent.js (bd-e1914a). Pure over inputs + env; the only
// dependency is the env reader from realtime-helpers.

import { env } from "./realtime-helpers.js";

export const DEFAULT_MODEL = "gpt-realtime-2";
export const SUPPORTED_REALTIME_MODELS = new Set(["gpt-realtime-2", "gpt-realtime"]);

// `gpt-realtime-2` is the stable alias our deployments point at the GPT Realtime
// 2.x family (currently 2.1). 2.x brought a 256k context window, adjustable
// reasoning.effort, and phased output items (commentary preambles + final
// answer). The alias id is unchanged on purpose — only the capabilities below
// track the newer point release. (see lib/realtime-phases.js)
export const DEFAULT_REALTIME_CONTEXT_WINDOW = 256_000;
export const REALTIME_MODEL_CONTEXT_WINDOWS = {
  "gpt-realtime-2": 256_000,
  "gpt-realtime": 128_000,
};
// Only the 2.x family accepts response.reasoning; sending it to gpt-realtime
// earns an "unknown parameter" error and a wasted round-trip.
export const REALTIME_REASONING_MODEL_PREFIXES = ["gpt-realtime-2"];
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

// Context window for a realtime model id (accepts "provider/id"). Unknown
// realtime ids get the current-generation default rather than the legacy 128k.
export function realtimeModelContextWindow(raw, fallback = DEFAULT_REALTIME_CONTEXT_WINDOW) {
  const value = String(raw?.id || raw || "").trim();
  const id = value.includes("/") ? value.split("/").pop() : value;
  if (!id) return fallback;
  return REALTIME_MODEL_CONTEXT_WINDOWS[id] ?? fallback;
}

export function realtimeModelSupportsReasoning(raw) {
  const value = String(raw?.id || raw || "").trim();
  const id = value.includes("/") ? value.split("/").pop() : value;
  if (!id) return false;
  return REALTIME_REASONING_MODEL_PREFIXES.some((prefix) => id === prefix || id.startsWith(`${prefix}.`) || id.startsWith(`${prefix}-`));
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
