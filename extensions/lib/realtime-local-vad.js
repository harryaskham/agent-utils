// Orchestration for the `/rt stt local-vad` listen mode (bd-9399e7): drives a
// VadSegmenter's insert/commit events into transcribe-and-insert (provisional
// partials) and transcribe-and-send (final turn) actions.
//
// This is decoupled from audio capture and from any stt backend via injected
// callbacks, so it is unit-testable without a microphone/Pulse or a live `stt`
// process — only the thin wiring in realtime-agent.js touches the hardware.
//
// Semantics (bd-9399e7; revised 2026-06-27 after live mic validation):
//   - Segmentation runs in REAL TIME: pushFrame only re-frames + advances the
//     VadSegmenter (synchronous, never blocked by a transcribe), so the silence
//     clock stays accurate and the commit fires on the operator's real pause.
//     (The previous design awaited the transcribe inside the ingestion path, so
//     a slow model stalled segmentation and multi-segment turns never committed.)
//   - insert -> re-transcribe the WHOLE turn-so-far as a fresh candidate partial
//     (re-draft, latest-wins), rather than stitching little delta chunks.
//   - commit -> re-transcribe the whole turn and send; prioritized over drafts.
//   - Transcription runs in a single-flight async pump OFF the ingestion path:
//     at most one transcribe in flight, newer drafts coalesce, commit jumps the
//     queue, so a slow model can never stall segmentation or strand a turn.
//   - thresholds default 1s insert / 3s commit, tunable via PI_RT_LOCAL_VAD_*.

import { CHANNELS, SAMPLE_RATE, SAMPLE_WIDTH } from "./realtime-audio.js";
import { DEFAULT_VAD_SEGMENTER_CONFIG, VadSegmenter } from "./realtime-vad-segmenter.js";

// Re-framing granularity: live capture delivers arbitrary-size pipe chunks, but
// the VadSegmenter computes RMS + silence per push() and is designed for small
// fixed frames, so the controller re-frames incoming audio to ~100 ms frames.
export const DEFAULT_FRAME_MS = 100;
export const DEFAULT_FRAME_BYTES = Math.round((DEFAULT_FRAME_MS / 1000) * SAMPLE_RATE) * CHANNELS * SAMPLE_WIDTH;

// PI_RT_LOCAL_VAD_* env knobs, parallel to the server-VAD PI_RT_VAD_* ones.
export const LOCAL_VAD_ENV_KEYS = {
  energyThreshold: "PI_RT_LOCAL_VAD_ENERGY_THRESHOLD",
  insertSilenceMs: "PI_RT_LOCAL_VAD_INSERT_SILENCE_MS",
  commitSilenceMs: "PI_RT_LOCAL_VAD_COMMIT_SILENCE_MS",
  minTurnSpeechMs: "PI_RT_LOCAL_VAD_MIN_TURN_SPEECH_MS",
};

function numFromEnv(env, key, fallback, { min, max } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  let value = n;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return value;
}

/// Resolve a VadSegmenter config from PI_RT_LOCAL_VAD_* env knobs, falling back
/// to the segmenter defaults. Pure over `env`; invalid/blank values fall back.
export function parseLocalVadConfig(env = process.env) {
  return {
    energyThreshold: numFromEnv(env, LOCAL_VAD_ENV_KEYS.energyThreshold, DEFAULT_VAD_SEGMENTER_CONFIG.energyThreshold, { min: 0, max: 1 }),
    insertSilenceMs: numFromEnv(env, LOCAL_VAD_ENV_KEYS.insertSilenceMs, DEFAULT_VAD_SEGMENTER_CONFIG.insertSilenceMs, { min: 0 }),
    commitSilenceMs: numFromEnv(env, LOCAL_VAD_ENV_KEYS.commitSilenceMs, DEFAULT_VAD_SEGMENTER_CONFIG.commitSilenceMs, { min: 0 }),
    minTurnSpeechMs: numFromEnv(env, LOCAL_VAD_ENV_KEYS.minTurnSpeechMs, DEFAULT_VAD_SEGMENTER_CONFIG.minTurnSpeechMs, { min: 0 }),
  };
}

/// One-line summary of the resolved config for /rt-doctor / status surfaces.
export function describeLocalVadConfig(config = {}) {
  const c = { ...DEFAULT_VAD_SEGMENTER_CONFIG, ...config };
  return `local-vad: energy=${c.energyThreshold} insert=${c.insertSilenceMs}ms commit=${c.commitSilenceMs}ms minTurn=${c.minTurnSpeechMs}ms`;
}

/// Orchestrates a VadSegmenter into transcribe/insert/send actions. All effects
/// are injected, so this is unit-testable without audio or a live stt backend.
///
/// options:
///   transcribe(audioBuffer) -> Promise<string>   batch stt over a PCM buffer (required)
///   insertPartial(text, event) -> void           show a provisional partial
///   sendTurn(text, event) -> void                send the finalized turn
///   onError(err, event) -> void                  surface a transcription failure
///   segmenter                                    an existing VadSegmenter (optional)
///   config                                       VadSegmenter config when none is supplied
export class LocalVadController {
  constructor({ segmenter, config, transcribe, insertPartial, sendTurn, onError, onState, frameBytes, placeholder, overlongHintMs, isSuppressed } = {}) {
    if (typeof transcribe !== "function") {
      throw new Error("LocalVadController requires a transcribe(audio) function");
    }
    this.segmenter = segmenter || new VadSegmenter(config || {});
    this.transcribe = transcribe;
    this.insertPartial = insertPartial || (() => {});
    this.sendTurn = sendTurn || (() => {});
    this.onError = onError || (() => {});
    // Lifecycle state callback for a live UI: "listening" (speech detected),
    // "transcribing" (a transcribe started), "idle" (turn sent), "overlong" (a
    // turn running long with continuous audio and no silence gap). Best-effort.
    this.onState = onState || (() => {});
    this.frameBytes = frameBytes > 0 ? Math.trunc(frameBytes) : DEFAULT_FRAME_BYTES;
    // Optional text shown the instant a turn's first partial is pending, before
    // the first re-draft candidate returns. Opt-in (the live wiring enables it).
    this.placeholder = placeholder === undefined ? null : placeholder;
    // Surface an "overlong" hint once per turn when this much speech accrues with
    // NO silence gap (i.e. never inserts) — the over-sensitive-threshold / constant
    // noise signature that otherwise sits on "listening" forever. 0 disables.
    this.overlongHintMs = Number.isFinite(overlongHintMs) ? overlongHintMs : (config?.overlongHintMs ?? 0);
    // Half-duplex gate (bd-ddc391): when this returns true the assistant is speaking,
    // so mic frames are dropped (the reply's echo is not captured/transcribed).
    this.isSuppressed = typeof isSuppressed === "function" ? isSuppressed : null;
    this._pending = Buffer.alloc(0);
    // Single-flight transcription pump state (kept OFF the ingestion path).
    this._transcribing = false;
    this._pendingDraftAudio = null;   // newest whole-turn audio wanting a draft
    this._pendingDraftEvent = null;
    this._pendingCommit = null;       // { audio, event } wanting a final send
    this._current = null;             // in-flight transcribe chain (for flush drain)
    this._hasPartial = false;         // whether this turn has shown any partial yet
    this._turnInserted = false;       // whether this turn ever inserted (had a gap)
    this._hintedOverlong = false;     // whether the overlong hint fired this turn
  }

  /// Feed PCM16 audio (an arbitrary-size capture chunk). Re-frames into fixed
  /// ~100 ms frames and advances the segmenter SYNCHRONOUSLY — transcription is
  /// dispatched to an async pump and never blocks ingestion, so the live capture
  /// can fire this WITHOUT awaiting and the silence clock stays real-time. Being
  /// fully synchronous, concurrent un-awaited calls cannot interleave and corrupt
  /// the shared re-frame buffer / segmenter state.
  async pushFrame(chunk) {
    this._ingest(chunk);
  }

  _ingest(chunk) {
    if (!chunk || chunk.length === 0) return;
    // Half-duplex: drop mic audio while the assistant is speaking (+ release tail)
    // so its own spoken reply is not captured + transcribed as a phantom turn.
    if (this.isSuppressed && this.isSuppressed()) {
      this._pending = Buffer.alloc(0);
      return;
    }
    this._pending = this._pending.length ? Buffer.concat([this._pending, chunk]) : Buffer.from(chunk);
    while (this._pending.length >= this.frameBytes) {
      const frame = this._pending.subarray(0, this.frameBytes);
      this._pending = this._pending.subarray(this.frameBytes);
      // Surface "listening" the instant a fresh turn starts (turnSpeechMs 0 -> >0),
      // so the live UI reacts the moment VAD triggers, before the first insert.
      const wasIdle = this.segmenter.turnSpeechMs === 0;
      const events = this.segmenter.push(frame);
      if (wasIdle && this.segmenter.turnSpeechMs > 0) {
        this._turnInserted = false;
        this._hintedOverlong = false;
        try { this.onState("listening"); } catch (err) { this.onError(err); }
      }
      for (const event of events) this._dispatch(event);
      // Stuck-turn hint: lots of speech accrued with no insert (no silence gap) =>
      // continuous audio that will never commit (threshold too low / constant
      // noise). Surface "overlong" once so the UI can prompt raising /rt energy=.
      if (
        this.overlongHintMs > 0 &&
        !this._hintedOverlong &&
        !this._turnInserted &&
        this.segmenter.turnSpeechMs >= this.overlongHintMs
      ) {
        this._hintedOverlong = true;
        try { this.onState("overlong"); } catch (err) { this.onError(err); }
      }
    }
  }

  /// Force-finalize the current turn (e.g. on stop/cancel): drains any buffered
  /// sub-frame remainder + the segmenter's final commit, then waits for the
  /// transcription pump to finish so the last turn is actually sent.
  async flush() {
    if (this._pending.length) {
      const frame = this._pending;
      this._pending = Buffer.alloc(0);
      for (const event of this.segmenter.push(frame)) this._dispatch(event);
    }
    for (const event of this.segmenter.flush()) this._dispatch(event);
    await this._drain();
  }

  // Route a segmenter event into the transcription pump WITHOUT blocking the
  // caller. Drafts (insert) re-draft the whole turn, latest-wins; commit is
  // prioritized and supersedes any pending draft.
  _dispatch(event) {
    if (event.type === "insert") {
      this._turnInserted = true; // this turn had a silence gap (not stuck/runaway)
      if (!this._hasPartial && this.placeholder) {
        this._hasPartial = true;
        try { this.insertPartial(this.placeholder, event); } catch (err) { this.onError(err, event); }
      }
      this._pendingDraftAudio = event.audio;
      this._pendingDraftEvent = event;
      this._pump();
    } else if (event.type === "commit") {
      this._pendingCommit = { audio: event.audio, event };
      this._pendingDraftAudio = null;
      this._pendingDraftEvent = null;
      this._pump();
    }
  }

  // Single-flight transcription: at most one transcribe in flight. Commit beats
  // a pending draft; a newer draft replaces an older one (coalesced re-draft).
  _pump() {
    if (this._transcribing) return;
    let job = null;
    if (this._pendingCommit) {
      job = { kind: "commit", audio: this._pendingCommit.audio, event: this._pendingCommit.event };
      this._pendingCommit = null;
      this._pendingDraftAudio = null;
      this._pendingDraftEvent = null;
    } else if (this._pendingDraftAudio) {
      job = { kind: "draft", audio: this._pendingDraftAudio, event: this._pendingDraftEvent };
      this._pendingDraftAudio = null;
      this._pendingDraftEvent = null;
    }
    if (!job) return;
    this._transcribing = true;
    try { this.onState(job.kind === "commit" ? "transcribing-final" : "transcribing", job.event); } catch { /* best-effort */ }
    this._current = Promise.resolve()
      .then(() => this.transcribe(job.audio))
      .then((raw) => {
        const text = String(raw == null ? "" : raw).trim();
        if (job.kind === "commit") {
          this._hasPartial = false;
          if (text) this.sendTurn(text, job.event);
          try { this.onState("idle", job.event); } catch { /* best-effort */ }
        } else if (text) {
          this._hasPartial = true;
          this.insertPartial(text, job.event);
        }
      })
      .catch((err) => { this.onError(err, job.event); })
      .finally(() => { this._transcribing = false; this._current = null; this._pump(); });
  }

  async _drain() {
    while (this._current) {
      try { await this._current; } catch { /* surfaced via onError */ }
    }
  }
}
