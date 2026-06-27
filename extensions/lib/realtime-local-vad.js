// Orchestration for the `/rt stt local-vad` listen mode (bd-9399e7): drives a
// VadSegmenter's insert/commit events into transcribe-and-insert (provisional
// partials) and transcribe-and-send (final turn) actions.
//
// This is decoupled from audio capture and from any stt backend via injected
// callbacks, so it is unit-testable without a microphone/Pulse or a live `stt`
// process — only the thin wiring in realtime-agent.js touches the hardware.
//
// Operator-signed-off semantics (bd-9399e7, 2026-06-26):
//   - insert -> transcribe ONLY the delta chunk (cheap, provisional partial).
//   - commit -> re-transcribe the WHOLE turn audio (accurate final send).
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
  constructor({ segmenter, config, transcribe, insertPartial, sendTurn, onError, frameBytes } = {}) {
    if (typeof transcribe !== "function") {
      throw new Error("LocalVadController requires a transcribe(audio) function");
    }
    this.segmenter = segmenter || new VadSegmenter(config || {});
    this.transcribe = transcribe;
    this.insertPartial = insertPartial || (() => {});
    this.sendTurn = sendTurn || (() => {});
    this.onError = onError || (() => {});
    this.frameBytes = frameBytes > 0 ? Math.trunc(frameBytes) : DEFAULT_FRAME_BYTES;
    this._pending = Buffer.alloc(0);
  }

  /// Feed PCM16 audio (an arbitrary-size capture chunk). Buffers and re-frames it
  /// into fixed ~100 ms frames before pushing to the segmenter, so live pipe
  /// chunks of any size segment as accurately as small fixed frames. Runs any
  /// resulting insert/commit handlers in order.
  async pushFrame(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._pending = this._pending.length ? Buffer.concat([this._pending, chunk]) : Buffer.from(chunk);
    while (this._pending.length >= this.frameBytes) {
      const frame = this._pending.subarray(0, this.frameBytes);
      this._pending = this._pending.subarray(this.frameBytes);
      for (const event of this.segmenter.push(frame)) {
        // Events are emitted in order (insert before commit); handle serially.
        await this._handle(event);
      }
    }
  }

  /// Force-finalize the current turn (e.g. on stop/cancel): flush any buffered
  /// sub-frame remainder, then handle any commit.
  async flush() {
    if (this._pending.length) {
      const frame = this._pending;
      this._pending = Buffer.alloc(0);
      for (const event of this.segmenter.push(frame)) {
        await this._handle(event);
      }
    }
    for (const event of this.segmenter.flush()) {
      // Ordered finalization (at most one commit).
      await this._handle(event);
    }
  }

  async _handle(event) {
    try {
      if (event.type === "insert") {
        // Cheap provisional partial from the new delta chunk only.
        const text = String(await this.transcribe(event.delta)).trim();
        if (text) this.insertPartial(text, event);
      } else if (event.type === "commit") {
        // Accurate final send: re-transcribe the whole turn.
        const text = String(await this.transcribe(event.audio)).trim();
        if (text) this.sendTurn(text, event);
      }
    } catch (err) {
      this.onError(err, event);
    }
  }
}
