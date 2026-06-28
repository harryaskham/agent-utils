# bd-421f65 — realtime: show audio input (capture-side smoothed input level)

## What
Part of Harry's 2026-06-28 realtime work ("coordinate amongst yourselves to fix
gpt-realtime-2 GA connect; polish the realtime/STT display, show audio input").
This is the **data-side** slice of "show audio input": produce a smoothed
microphone input level the status/widget display can render.

Today the realtime status only shows `lastMicBytes` (a byte count) — never an
actual input **level**. This adds the level.

## Changes
- **NEW `extensions/lib/realtime-input-level.js`** — pure, unit-tested
  capture-side primitive:
  - `clampUnit(v)` — coerce to finite 0..1.
  - `smoothLevel(prev, instant, {attack, decay})` — one exponential-smoothing
    step, fast attack / slow decay so the meter is stable between syllables.
  - `InputLevelTracker` — `push(pcm16Chunk)` → smoothed 0..1 level (reuses
    `normalizedRms` from `realtime-vad-segmenter.js`; **no new RMS**),
    `pushLevel`, `value`, `reset`. Contains **no formatter** (the level→bar
    formatter is msm-2's `realtime-audio-meter.js`) — zero duplication.
- **`extensions/realtime-agent.js`** mic-path wiring (generic capture only):
  initialise `session.inputLevel`/tracker in the constructor; write a smoothed
  `session.inputLevel` (0..1) from each mic chunk; decay toward 0 while the
  half-duplex guard mutes input (assistant speaking) and on mic exit; reset on
  mic start. Consumers (msm-1 status read, msm-2 widget) read `session.inputLevel`.
- **NEW `test/realtime-input-level.test.js`** — 10 hermetic tests.

## Coordination / boundaries (8-agent swarm)
Strict file split to avoid collisions: msm-0 = GA connect fix (bd-0b40ce);
ms2-1 = GA-handshake regression test; msm-2 = shared meter formatter + cascade
widget; msm-1 = realtime-status.js display read/robustness; **ms2-2 (me) = this
data slice**. I touch only the new lib + new test + the generic
mic-handler/constructor/mic-exit regions of realtime-agent.js — not
realtime-status.js, realtime-helpers.js, the connect code, or the formatter.
Additive and non-breaking: writes a field consumers read once their display
work lands, so landing early unblocks them.

## Validation
- `node --test` — 969 pass, 0 fail (incl. 10 new `realtime-input-level` tests).
- `npm run docs:check` — passes.
- `node --check extensions/realtime-agent.js` — clean.
