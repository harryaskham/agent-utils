import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMENTARY_MODES,
  REALTIME_PHASE_COMMENTARY,
  REALTIME_PHASE_FINAL,
  isCommentaryPhase,
  normalizeCommentaryMode,
  normalizeRealtimePhase,
  realtimeItemPhase,
} from "../extensions/lib/realtime-phases.js";

test("normalizeRealtimePhase recognizes commentary and defaults everything else to final_answer", () => {
  assert.equal(normalizeRealtimePhase("commentary"), REALTIME_PHASE_COMMENTARY);
  assert.equal(normalizeRealtimePhase("COMMENTARY"), REALTIME_PHASE_COMMENTARY);
  assert.equal(normalizeRealtimePhase("preamble"), REALTIME_PHASE_COMMENTARY);
  assert.equal(normalizeRealtimePhase("final_answer"), REALTIME_PHASE_FINAL);
  assert.equal(normalizeRealtimePhase("final-answer"), REALTIME_PHASE_FINAL);
  // Untagged items (every pre-2.x realtime model) must stay final_answer so the
  // legacy single-text-block rendering is unchanged.
  assert.equal(normalizeRealtimePhase(undefined), REALTIME_PHASE_FINAL);
  assert.equal(normalizeRealtimePhase(""), REALTIME_PHASE_FINAL);
  assert.equal(normalizeRealtimePhase("something-new"), REALTIME_PHASE_FINAL);
});

test("realtimeItemPhase reads the item, nested, and event-level spellings", () => {
  assert.equal(realtimeItemPhase({ id: "i1", phase: "commentary" }), REALTIME_PHASE_COMMENTARY);
  assert.equal(realtimeItemPhase({ id: "i1", metadata: { phase: "commentary" } }), REALTIME_PHASE_COMMENTARY);
  assert.equal(realtimeItemPhase({ id: "i1" }, { phase: "commentary" }), REALTIME_PHASE_COMMENTARY);
  assert.equal(realtimeItemPhase({ id: "i1", response_phase: "commentary" }), REALTIME_PHASE_COMMENTARY);
  assert.equal(realtimeItemPhase({ id: "i1", phase: "final_answer" }, { phase: "commentary" }), REALTIME_PHASE_FINAL);
  assert.equal(realtimeItemPhase(undefined, undefined), REALTIME_PHASE_FINAL);
  assert.equal(isCommentaryPhase("commentary"), true);
  assert.equal(isCommentaryPhase("final_answer"), false);
});

test("normalizeCommentaryMode maps aliases and falls back", () => {
  assert.deepEqual(COMMENTARY_MODES, ["thinking", "text", "hidden"]);
  assert.equal(normalizeCommentaryMode(undefined), "thinking");
  assert.equal(normalizeCommentaryMode(""), "thinking");
  assert.equal(normalizeCommentaryMode("thinking"), "thinking");
  assert.equal(normalizeCommentaryMode("reasoning"), "thinking");
  assert.equal(normalizeCommentaryMode("inline"), "text");
  assert.equal(normalizeCommentaryMode("TEXT"), "text");
  assert.equal(normalizeCommentaryMode("off"), "hidden");
  assert.equal(normalizeCommentaryMode("none"), "hidden");
  // Unknown values fall back; passing null as the fallback lets a caller detect
  // an invalid /rt commentary=<x> instead of silently accepting it.
  assert.equal(normalizeCommentaryMode("banana"), "thinking");
  assert.equal(normalizeCommentaryMode("banana", null), null);
});
