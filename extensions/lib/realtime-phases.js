// Realtime response-phase helpers for gpt-realtime 2.x.
//
// A gpt-realtime 2.x turn can contain MULTIPLE output items, each tagged with a
// phase that says what the item is for:
//
//   commentary   - a promptable preamble ("let me think about that...", a tool
//                  announcement, or a silence filler) emitted before/while the
//                  model reasons. Preambles exist to cut perceived latency, so
//                  they arrive BEFORE the real answer and are spoken aloud.
//   final_answer - the answer the model settles on after reasoning.
//
// Pre-2.x realtime models never tag output items. Untagged items therefore
// normalize to final_answer so older models keep their previous single-block
// rendering exactly.
//
// Pi rendering (see realtime-agent.js `_appendText`) is controlled by
// config.commentaryMode / PI_RT_COMMENTARY:
//   thinking (default) - commentary text streams as a Pi thinking block, the
//                        final answer as a normal text block. Audio still plays
//                        for both, so you hear the preamble and see it dimmed.
//   text               - commentary is inlined into the normal text block
//                        (pre-phase behavior; one merged transcript).
//   hidden             - commentary text is dropped from the transcript. Its
//                        audio still plays.

export const REALTIME_PHASE_COMMENTARY = "commentary";
export const REALTIME_PHASE_FINAL = "final_answer";
export const REALTIME_PHASES = [REALTIME_PHASE_COMMENTARY, REALTIME_PHASE_FINAL];

export const COMMENTARY_MODES = ["thinking", "text", "hidden"];
export const DEFAULT_COMMENTARY_MODE = "thinking";

// Normalize a server-reported phase. Unknown/absent phases are final_answer:
// the conservative choice, because an untagged item is the whole answer.
export function normalizeRealtimePhase(raw) {
  const value = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (value === "commentary" || value === "preamble") return REALTIME_PHASE_COMMENTARY;
  return REALTIME_PHASE_FINAL;
}

// Phase of a response.output_item.added / .done item. The field has moved
// around across previews, so accept the documented `item.phase` plus the
// nested/event-level spellings rather than silently rendering a preamble as the
// final answer.
export function realtimeItemPhase(item, event) {
  const raw = item?.phase
    ?? item?.response_phase
    ?? item?.metadata?.phase
    ?? event?.phase
    ?? event?.item?.phase;
  return normalizeRealtimePhase(raw);
}

export function isCommentaryPhase(phase) {
  return normalizeRealtimePhase(phase) === REALTIME_PHASE_COMMENTARY;
}

export function normalizeCommentaryMode(raw, fallback = DEFAULT_COMMENTARY_MODE) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (value === "reasoning" || value === "thought" || value === "thoughts") return "thinking";
  if (value === "inline" || value === "merge" || value === "merged") return "text";
  if (value === "off" || value === "none" || value === "drop" || value === "silent") return "hidden";
  return COMMENTARY_MODES.includes(value) ? value : fallback;
}
