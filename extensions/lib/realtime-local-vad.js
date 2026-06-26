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

import { DEFAULT_VAD_SEGMENTER_CONFIG, VadSegmenter } from "./realtime-vad-segmenter.js";

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
  constructor({ segmenter, config, transcribe, insertPartial, sendTurn, onError } = {}) {
    if (typeof transcribe !== "function") {
      throw new Error("LocalVadController requires a transcribe(audio) function");
    }
    this.segmenter = segmenter || new VadSegmenter(config || {});
    this.transcribe = transcribe;
    this.insertPartial = insertPartial || (() => {});
    this.sendTurn = sendTurn || (() => {});
    this.onError = onError || (() => {});
  }

  /// Feed one PCM16 frame; runs any resulting insert/commit handlers in order.
  async pushFrame(frame) {
    for (const event of this.segmenter.push(frame)) {
      // Events are emitted in order (insert before commit); handle serially.
      await this._handle(event);
    }
  }

  /// Force-finalize the current turn (e.g. on stop/cancel): handles any commit.
  async flush() {
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
