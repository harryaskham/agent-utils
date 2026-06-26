# Session summary — local-vad orchestration core (bd-9399e7, part 1)

## Goal

Operator-signed-off feature (Harry approved my proposed defaults via caco choices):
wire a live /rt stt local-vad mode. Part 1 lands the testable orchestration core
(the heart of the feature), following bd-d4ff24's pattern of landing the
VadSegmenter core before the live wiring.

## Bead(s)

- `bd-9399e7` — realtime: wire live /rt stt local-vad mode (feature; IN PROGRESS —
  this is part 1 of 2: the tested core; live ctx wiring follows).

## Before state

- VadSegmenter core (bd-d4ff24) landed but unwired; no orchestration layer.

## After state

- New extensions/lib/realtime-local-vad.js: LocalVadController (injectable
  transcribe/insertPartial/sendTurn/onError; insert=delta, commit=whole-turn per
  sign-off) + parseLocalVadConfig (PI_RT_LOCAL_VAD_* knobs, clamped) +
  describeLocalVadConfig. test/realtime-local-vad.test.js: +8 tests, 100% line.
  Full JS suite green.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Summary artefact commit: intentionally omitted (no self-reference).
- Files touched: extensions/lib/realtime-local-vad.js (new),
  test/realtime-local-vad.test.js (new).
- Tests: +8 / -0 / flipped 0.
- Behavioural delta: net-new unused lib (no wiring yet) — zero runtime change,
  consistent with how bd-d4ff24 landed the segmenter core.

## Operator-takeaway

The orchestration logic is done and fully unit-tested without needing a mic. The
remaining live wiring (local capture bypassing the OpenAI WebSocket + an `stt
--stdin --transcription-model` batch subprocess + /rt stt local-vad command +
status-line/doctor) is ctx/IO glue that needs Harry's mic/Pulse to validate
end-to-end; it plugs the real transcribe/insert/send into this tested core.
