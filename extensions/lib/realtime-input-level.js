// Capture-side microphone INPUT LEVEL primitive for the realtime "show audio
// input" display. Turns raw PCM16 mic chunks into a smoothed 0..1 level
// (written to `session.inputLevel`) that the status / widget layer renders as a
// meter. This is the data-production half of the feature; rendering lives
// elsewhere so the two never collide.
//
// Separation of concerns (one home each, no duplication):
//   * normalizedRms (lib/realtime-vad-segmenter.js) — instantaneous RMS energy
//     of a PCM16 frame. The single source of truth for the energy calc; reused
//     here rather than reimplemented.
//   * InputLevelTracker (this file)                 — TEMPORAL SMOOTHING only
//     (fast attack / slow decay) so the meter is stable between syllables.
//   * level → bar FORMATTER (lib/realtime-audio-meter.js)
//                                                   — turns a 0..1 level into a
//     display bar. Intentionally NOT here: this file contains no formatter so
//     the bar rendering is never duplicated.
//
// PCM format matches the rest of the realtime extension (24 kHz, mono, signed
// 16-bit little-endian — see realtime-audio.js). Pure over inputs (no audio
// capture, no module state) so it unit-tests without a microphone.

import { normalizedRms } from "./realtime-vad-segmenter.js";
import { SAMPLE_WIDTH } from "./realtime-audio.js";

export const DEFAULT_INPUT_LEVEL_CONFIG = {
  // Exponential-smoothing coefficients in 0..1. A larger coefficient tracks the
  // instantaneous level faster. Attack (level rising) is fast so a speech onset
  // shows immediately; decay (level falling) is slow so the meter does not
  // flicker to zero between syllables.
  attack: 0.5,
  decay: 0.15,
};

// Coerce any value to a finite number clamped to 0..1.
export function clampUnit(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// One exponential-smoothing step from `previous` toward `instant`, using a
// fast-attack / slow-decay coefficient. Both endpoints and coefficients are
// clamped to 0..1 so the result is always a finite 0..1 level. Pure.
export function smoothLevel(previous, instant, config = {}) {
  const prev = clampUnit(previous);
  const inst = clampUnit(instant);
  const attack = clampUnit(config.attack ?? DEFAULT_INPUT_LEVEL_CONFIG.attack);
  const decay = clampUnit(config.decay ?? DEFAULT_INPUT_LEVEL_CONFIG.decay);
  const coef = inst > prev ? attack : decay;
  return clampUnit(prev + coef * (inst - prev));
}

// Stateful smoothed input-level tracker. `push(chunk)` computes a PCM16 chunk's
// normalized RMS and folds it into the running smoothed level, returning the
// new 0..1 level. Empty / odd-length chunks count as silence so the level
// decays toward zero when capture stalls.
export class InputLevelTracker {
  constructor(config = {}) {
    this.config = { ...DEFAULT_INPUT_LEVEL_CONFIG, ...config };
    this.level = 0;
  }

  // Fold a raw PCM16 mic chunk in; returns the new smoothed 0..1 level.
  push(chunk) {
    const usable = chunk && chunk.length >= SAMPLE_WIDTH;
    const instant = usable ? normalizedRms(chunk) : 0;
    this.level = smoothLevel(this.level, instant, this.config);
    return this.level;
  }

  // Fold an already-computed 0..1 level in without re-deriving RMS (e.g. a peak
  // level computed elsewhere). Returns the new smoothed level.
  pushLevel(instant) {
    this.level = smoothLevel(this.level, instant, this.config);
    return this.level;
  }

  // Current smoothed level (0..1).
  value() {
    return this.level;
  }

  // Reset to silence (e.g. when the mic stops). Returns 0.
  reset() {
    this.level = 0;
    return this.level;
  }
}
