// Live audio-input level meter for the realtime / STT / cascade widgets
// (Harry's "show audio input" request, 2026-06-28). PURE + stateful-but-
// deterministic so the whole thing is unit-tested without a microphone, and
// REUSABLE: the generic rt/stt mic path (ms2-2) and the cascade mic path (msm-2)
// both feed it raw PCM frames (or RMS values) and render a level bar.
//
// RMS for a PCM16/24k/mono frame is computed by normalizedRms in the VAD
// segmenter (the single source of truth for the audio format); we reuse it so the
// meter and the VAD speech decision agree on what "loud" means.
//
// Interface contract (for ms2-2's generic-meter consumer):
//   - Pure render:   formatLevelBar(level0to1, { width, filled, empty, threshold })
//                    formatLevelLabel(level0to1, opts) -> "[bar] NN%"
//   - RMS -> level:  rmsToLevel(rms, { gain })   (gain default 12)
//   - Smoothing:     class AudioLevelMeter (fast attack / slow decay). Either use
//                    it end-to-end (pushRms/pushFrame -> .level -> .render()), OR
//                    keep your own smoothing and just call formatLevelBar(level).

import { normalizedRms } from "./realtime-vad-segmenter.js";

// Speech RMS sits roughly in 0.01..0.1, with the VAD speech threshold ~0.012, so
// a modest linear gain maps a normal speaking level onto most of the bar.
export const DEFAULT_METER_GAIN = 12;
export const DEFAULT_METER_WIDTH = 12;

/// Map a normalized RMS (0..1) to a 0..1 display level via a gain. Pure.
export function rmsToLevel(rms, { gain = DEFAULT_METER_GAIN } = {}) {
  const r = Math.max(0, Number(rms) || 0);
  const g = Number(gain) > 0 ? Number(gain) : DEFAULT_METER_GAIN;
  return Math.max(0, Math.min(1, r * g));
}

/// Render a 0..1 level as a fixed-width bar, optionally marking the speech
/// threshold (also 0..1 in display terms) with a vertical bar. Pure.
export function formatLevelBar(level, { width = DEFAULT_METER_WIDTH, filled = "\u2588", empty = "\u2591", threshold } = {}) {
  const w = Math.max(1, Math.trunc(width) || DEFAULT_METER_WIDTH);
  const lv = Math.max(0, Math.min(1, Number(level) || 0));
  const n = Math.max(0, Math.min(w, Math.round(lv * w)));
  let cells = filled.repeat(n) + empty.repeat(w - n);
  if (Number.isFinite(threshold)) {
    const t = Math.max(0, Math.min(1, Number(threshold)));
    const ti = Math.max(0, Math.min(w - 1, Math.round(t * w)));
    cells = `${cells.slice(0, ti)}\u2502${cells.slice(ti + 1)}`;
  }
  return cells;
}

/// Compact "[bar] NN%" label for a level (0..1). Pure.
export function formatLevelLabel(level, opts = {}) {
  const lv = Math.max(0, Math.min(1, Number(level) || 0));
  return `[${formatLevelBar(lv, opts)}] ${String(Math.round(lv * 100)).padStart(2, " ")}%`;
}

/// Stateful input-level meter with fast attack + slow decay (so the bar tracks
/// speech responsively but does not flicker on every silent frame), fed raw RMS
/// or PCM frames. Deterministic -> unit-tested.
export class AudioLevelMeter {
  constructor({ gain = DEFAULT_METER_GAIN, decay = 0.8, width = DEFAULT_METER_WIDTH } = {}) {
    this.gain = Number(gain) > 0 ? Number(gain) : DEFAULT_METER_GAIN;
    this.decay = Math.max(0, Math.min(0.999, Number.isFinite(Number(decay)) ? Number(decay) : 0.8));
    this.width = Math.max(1, Math.trunc(width) || DEFAULT_METER_WIDTH);
    this.reset();
  }

  /// Feed one normalized RMS value; returns the updated display level (0..1).
  pushRms(rms) {
    this.lastRms = Math.max(0, Number(rms) || 0);
    const lv = rmsToLevel(this.lastRms, { gain: this.gain });
    // Fast attack: jump up to a louder level immediately; slow decay otherwise.
    this.level = lv > this.level ? lv : this.level * this.decay;
    this.peak = Math.max(this.peak * this.decay, lv);
    return this.level;
  }

  /// Feed a raw PCM16/24k/mono frame (or capture chunk); returns the level.
  pushFrame(frame) {
    return this.pushRms(normalizedRms(Buffer.isBuffer(frame) ? frame : Buffer.from(frame || [])));
  }

  /// Render the current level as a bar (optionally with the threshold caret).
  render({ threshold } = {}) {
    return formatLevelBar(this.level, { width: this.width, threshold });
  }

  /// Render "[bar] NN%".
  label({ threshold } = {}) {
    return `[${this.render({ threshold })}] ${String(Math.round(this.level * 100)).padStart(2, " ")}%`;
  }

  reset() {
    this.level = 0;
    this.peak = 0;
    this.lastRms = 0;
  }
}
