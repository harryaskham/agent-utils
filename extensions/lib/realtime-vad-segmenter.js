// Local VAD segmenter for batch (non-streaming) transcription models.
//
// This is the hardware-independent CORE of a future `local-vad` realtime listen
// mode: a pure, deterministic state machine over PCM16 frames that decides when
// to "transcribe-and-insert" a partial and when to "commit/send" a turn, based
// on local energy VAD and two trailing-silence thresholds, resetting on speech.
//
// It is intentionally decoupled from audio capture and from any transcription
// backend so it can be unit-tested without a microphone/Pulse or a live `stt`
// process. The eventual live wiring (a new `/rt stt local-vad` mode) feeds raw
// PCM frames in via `push()` and, on each emitted event, runs a batch model
// such as `stt --stdin --transcription-model mai-transcribe-1.5` over the
// event's audio — inserting partials on `insert` and sending the turn on
// `commit`. Those UX details (exact thresholds, insert-vs-commit semantics) are
// operator-tunable and are NOT decided here.
//
// PCM format matches the rest of the realtime extension: 24 kHz, mono, signed
// 16-bit little-endian (see realtime-audio.js, the single source of truth).

import { CHANNELS, SAMPLE_RATE, SAMPLE_WIDTH } from "./realtime-audio.js";

export const DEFAULT_VAD_SEGMENTER_CONFIG = {
  // Normalized RMS (0..1, full-scale = 32768) at/above which a frame is speech.
  energyThreshold: 0.012,
  // Trailing silence (ms) that triggers a transcribe-and-insert of the turn so
  // far. Fires at most once per silence gap and only when there is new speech.
  insertSilenceMs: 1000,
  // Trailing silence (ms) that finalizes/sends the turn and resets state.
  commitSilenceMs: 3000,
  // Turns with less than this much accumulated speech are treated as noise and
  // never insert or commit.
  minTurnSpeechMs: 200,
};

/// Duration in ms of a PCM16 frame of `byteLength` bytes at the realtime format.
export function frameDurationMs(byteLength) {
  return (byteLength / (SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH)) * 1000;
}

/// Normalized RMS (0..1) of a signed-16-bit-LE PCM frame. Empty frame -> 0.
export function normalizedRms(frame) {
  const sampleCount = Math.floor(frame.length / SAMPLE_WIDTH);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = frame.readInt16LE(i * SAMPLE_WIDTH) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/// Stateful two-threshold silence segmenter.
///
/// `push(frame)` returns an array of zero or more events:
///   { type: "insert" | "commit", audio, delta, silenceMs, turnSpeechMs }
/// where `audio` is the whole turn so far and `delta` is the audio since the
/// last `insert` (so a caller can re-transcribe the whole turn for accuracy or
/// transcribe only the new chunk). `commit` also resets the turn.
export class VadSegmenter {
  constructor(config = {}) {
    this.config = { ...DEFAULT_VAD_SEGMENTER_CONFIG, ...config };
    this._reset();
  }

  _reset() {
    this.turnChunks = []; // all audio in the current turn
    this.deltaChunks = []; // audio since the last insert emit
    this.silenceMs = 0; // trailing-silence accumulator
    this.turnSpeechMs = 0; // total speech in the current turn
    this.hasSpeechSinceInsert = false;
    this.insertedThisGap = false;
  }

  push(frame) {
    const events = [];
    if (!frame || frame.length === 0) return events;

    const durationMs = frameDurationMs(frame.length);
    const isSpeech = normalizedRms(frame) >= this.config.energyThreshold;

    // Always retain audio so a later insert/commit carries the full turn.
    this.turnChunks.push(frame);
    this.deltaChunks.push(frame);

    if (isSpeech) {
      // reset-on-speech: clear the trailing-silence window and re-arm insert.
      this.silenceMs = 0;
      this.turnSpeechMs += durationMs;
      this.hasSpeechSinceInsert = true;
      this.insertedThisGap = false;
      return events;
    }

    this.silenceMs += durationMs;
    const enoughSpeech = this.turnSpeechMs >= this.config.minTurnSpeechMs;

    // Transcribe-and-insert: once per silence gap, only with new speech.
    if (
      !this.insertedThisGap &&
      this.hasSpeechSinceInsert &&
      enoughSpeech &&
      this.silenceMs >= this.config.insertSilenceMs
    ) {
      events.push(this._emit("insert"));
      this.insertedThisGap = true;
      this.hasSpeechSinceInsert = false;
      this.deltaChunks = []; // delta consumed by the insert
    }

    // Commit/send the turn after a longer silence, then reset.
    if (enoughSpeech && this.silenceMs >= this.config.commitSilenceMs) {
      events.push(this._emit("commit"));
      this._reset();
    }

    return events;
  }

  /// Force-finalize the current turn (e.g. on stop): emits a `commit` if the
  /// turn has enough speech, otherwise nothing. Always resets state.
  flush() {
    const events = [];
    if (this.turnSpeechMs >= this.config.minTurnSpeechMs) {
      events.push(this._emit("commit"));
    }
    this._reset();
    return events;
  }

  _emit(type) {
    return {
      type,
      audio: Buffer.concat(this.turnChunks),
      delta: Buffer.concat(this.deltaChunks),
      silenceMs: Math.round(this.silenceMs),
      turnSpeechMs: Math.round(this.turnSpeechMs),
    };
  }
}
