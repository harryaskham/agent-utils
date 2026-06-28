# Session summary — realtime status: gain session.inputLevel before render

## Goal

Fix a scaling bug in the audio-input-level render I landed earlier (bd-fb0e53):
the meter bar barely moved because the raw smoothed RMS was rendered without the
display gain. Peers ms2-2 and msm-2 flagged it; this applies the rmsToLevel gain
so the "show audio input" bar is actually legible.

## Bead(s)

- `bd-7ff579` — gain session.inputLevel via rmsToLevel before render.
- Fixes `bd-fb0e53` (the original render, which shipped the raw-RMS bug).

## Before state

- Failing tests: none (the bug was a wrong value, not a crash; my original test
  asserted an incorrect post-render percentage).
- micCaptureSummary rendered `formatLevelLabel(session.inputLevel)` directly, but
  InputLevelTracker.push returns smoothed RAW normalizedRms (~0.01-0.1 at
  speech) with no gain — so a speech-level RMS displayed as ~5%, leaving the bar
  barely twitching. (cascade.inputLevel differs: it comes from AudioLevelMeter,
  already gained, hence rendered directly.)

## After state

- Failing tests: none. realtime-status 21/21; full suite green, EXIT 0.
- Render is now `formatLevelLabel(rmsToLevel(session.inputLevel), { width: 8 })`,
  mapping RMS to a 0..1 display level (gain 12: RMS 0.05 -> 60%, >=~0.083 ->
  100%). The test was corrected to RMS-domain inputs asserting the gained
  percentages.

## Diff summary

- Code/content commit: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/lib/realtime-status.js` (import rmsToLevel; apply it
  in micCaptureSummary), `test/realtime-status.test.js` (corrected level test).
- Tests: 0 net new (corrected the existing level test). Behavioural delta: the
  input-level bar now fills proportionally to speech instead of barely moving.

## Operator-takeaway

The "show audio input" bar is now actually usable — at normal speech it fills to
a meaningful level rather than a sliver. The subtle trap: two sibling level
fields in the realtime code carry different units (session.inputLevel is raw
RMS; cascade.inputLevel is pre-gained display level), so the generic render
needed the rmsToLevel step while the cascade render did not. Caught in review by
the peers who owned the data and the formatter.
