// Compatibility surface for realtime/cascade TTS helpers.
//
// Native synthesis and playback now live in ./tts.js. The old `tts` CLI batch
// fallback was intentionally removed: every agent-utils speech consumer uses the
// shared direct Azure REST path. Keep these re-exports so existing imports do not
// need to change in lockstep.

export {
  DEFAULT_TTS_PROVIDER,
  AZURE_SPEECH_PROVIDER,
  DEFAULT_TTS_VOICE,
  DEFAULT_TTS_LANG,
  DEFAULT_TTS_SPEED,
  DEFAULT_TTS_EMBEDDING,
  DEFAULT_TTS_TIMEOUT_MS,
  DEFAULT_TTS_BATCH_TIMEOUT_MS,
  DEFAULT_AZURE_SPEECH_ENDPOINT,
  DEFAULT_AZURE_SPEECH_OUTPUT_FORMAT,
  DEFAULT_TTS_BACKEND,
  DEFAULT_TTS_DEVICE,
  DEFAULT_TTS_STREAM_NAME,
  CASCADE_DEFAULT_VOICE_SENTINEL,
  resolveBatchTtsTimeoutMs,
  isAzureSpeechProvider,
  resolveCascadeTtsVoice,
  cascadeSpeechEnabled,
  speedToProsodyRate,
  normalizeStyleDegree,
  buildAzureSpeechSsml,
  resolveAzureSpeechCreds,
  resolveSpeakToolParams,
  synthesizeAzureSpeechDirect,
  synthesizeSpeechDirect,
  buildPcmPlaybackSpec,
  createInterruptiblePcmPlayer,
} from "./tts.js";

// --- Auto-speak agent replies (bd-095b3d) ---

export function assistantReplyText(message) {
  if (!message || message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && (part.type === "text" || typeof part === "string"))
      .map((part) => (typeof part === "string" ? part : (part.text || "")))
      .join("")
      .trim();
  }
  return "";
}

export function pickLastAssistantReply(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = [...list].reverse().find((message) => message && message.role === "assistant");
  if (!last) return { text: "", key: "" };
  const text = assistantReplyText(last);
  const key = text ? `${last.timestamp ?? ""}:${text.slice(0, 64)}` : "";
  return { text, key };
}

export function thinkingSummaryText(message) {
  if (!message || message.role !== "assistant") return "";
  const content = message.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part && ["thinking", "reasoning", "reasoning_summary"].includes(part.type))
      .map((part) => (typeof part === "string" ? part : (part.text || part.summary || part.thinking || "")))
      .join("")
      .trim();
    if (text) return text;
  }
  const fallback = message.reasoning ?? message.reasoningText ?? message.thinking ?? message.thinkingSummary;
  return typeof fallback === "string" ? fallback.trim() : "";
}

export function boundThinkingForSpeech(text, maxChars = 320) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= maxChars) return value;
  const window = value.slice(0, maxChars);
  const sentence = window.match(/^[\s\S]*[.!?](?=\s|$)/);
  let cut = sentence ? sentence[0] : window;
  if (!sentence) {
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > 40) cut = cut.slice(0, lastSpace);
  }
  cut = cut.trim().replace(/[\s,;:\u2013-]+$/, "");
  return `${cut}\u2026`;
}
