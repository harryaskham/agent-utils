# Session summary — local-vad capture re-framing fix (bd-343617)

## Goal

Critical self-review of the just-landed bd-9399e7 local-vad wiring (before operator
mic validation) found a real correctness bug: raw capture pipe chunks were pushed
straight into the VadSegmenter, which is designed for small fixed frames.

## Bead(s)

- `bd-343617` — local-vad: re-frame arbitrary capture chunks into fixed 100ms VAD
  frames (bug; landed).

## Before state

- LocalVadController.pushFrame pushed each arbitrary-size capture chunk directly to
  VadSegmenter.push. Variable/large chunks (OS pipe buffering, up to ~1.3s) each
  got one averaged RMS + coarse silence accumulation, degrading segmentation.

## After state

- LocalVadController buffers incoming audio and re-frames it to fixed
  DEFAULT_FRAME_BYTES (4800 = 100ms) before pushing; flush() drains the sub-frame
  remainder first. +2 tests (unaligned chunks -> same insert/commit; sub-frame
  chunks buffer until flush). Backward-compatible with the existing 8 tests. Full
  suite 881 green; npm run check green. No realtime-agent.js wiring change needed.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Summary artefact commit: intentionally omitted (no self-reference).
- Files touched: extensions/lib/realtime-local-vad.js (re-framing),
  test/realtime-local-vad.test.js (+2 tests).
- Tests: +2 / -0 / flipped 0.
- Behavioural delta: improves segmentation accuracy for real (variable-size)
  capture; transparent for frame-aligned input.

## Operator-takeaway

Verify-don't-assume applied to my own unverifiable code: critically re-reading the
local-vad wiring caught that real capture chunks would have segmented poorly, and
the fix (re-frame to 100ms inside the controller) landed before Harry's mic
validation would have surfaced it as erratic VAD. The fix is fully unit-tested
without a mic.
