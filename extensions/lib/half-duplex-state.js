// Shared half-duplex speaking-state (bd-ddc391). force-agent-speech marks when the
// assistant is speaking (an estimated duration plus a short release tail); local-vad
// reads it to drop mic frames during that window, so the assistant's own spoken reply
// is not captured and transcribed back as a phantom turn. A single in-process signal,
// far lighter than acoustic echo cancellation.

let speakingUntil = 0;

/// Estimate spoken duration (ms) for `text` at ~`charsPerSec` speaking rate. Pure.
/// ~15 chars/s approximates 150 wpm; deliberately conservative so the gate slightly
/// over-covers rather than letting the tail of speech leak into the mic.
export function estimateSpeechMs(text, { charsPerSec = 15 } = {}) {
  const len = String(text == null ? "" : text).length;
  return Math.round((len / Math.max(1, charsPerSec)) * 1000);
}

/// Mark the assistant as speaking for `durationMs` plus a release `tailMs`, so trailing
/// audio after playback does not re-trigger the VAD. Extends (never shortens) the
/// window. Returns the absolute end timestamp.
export function markAssistantSpeaking(durationMs, { tailMs = 350, now = Date.now() } = {}) {
  const dur = Number(durationMs);
  const tail = Number(tailMs);
  const until = now + Math.max(0, Number.isFinite(dur) ? dur : 0) + Math.max(0, Number.isFinite(tail) ? tail : 0);
  if (until > speakingUntil) speakingUntil = until;
  return speakingUntil;
}

/// True while the assistant is (estimated to be) speaking, including the release tail.
export function isAssistantSpeaking(now = Date.now()) {
  return now < speakingUntil;
}

/// Test/reset hook: clears the speaking window.
export function __resetAssistantSpeaking() {
  speakingUntil = 0;
}
