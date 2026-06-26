# Session summary — realtime local-VAD batch-STT segmenter core (spike)

## Goal

Answer Harry's realtime-plugin question — can it do LOCAL VAD with a batch model
(mai-transcribe-1.5): listen, transcribe-and-insert on ~1s silence, send on ~3s
silence, reset on speech? — by delivering the hardware-independent CORE so the
design/thresholds can be reviewed before touching his live voice flow. The live
`/rt stt local-vad` wiring + UX tuning is intentionally deferred to an
operator-gated follow-up (he asked to pick first).

## Bead(s)

- `bd-d4ff24` — realtime: local-VAD batch-STT segmenter core (VadSegmenter +
  tests), unwired spike
- follow-up (filed draft): wire the live `/rt stt local-vad` listen mode using
  `VadSegmenter` + a batch `stt` model, pending operator UX sign-off

## Before state

- Failing tests: none.
- The realtime extension only had OpenAI server-side VAD over the streaming
  WebSocket (`micMode` vad/continuous) + PTT; transcription locked to realtime
  streaming models. No local-VAD + batch-model path existed.

## After state

- Failing tests: none. New `test/realtime-vad-segmenter.test.js` → `node --test`
  6/6 pass. No existing behavior changed (new module is not yet wired in).
- A pure `VadSegmenter` state machine exists: local energy/RMS VAD + two
  trailing-silence thresholds (insert ~1s, commit ~3s) + reset-on-speech +
  min-speech noise gate; emits `insert`/`commit` events with whole-turn audio +
  delta; `flush()` finalizes on stop.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/lib/realtime-vad-segmenter.js` (new, ~140 lines),
  `test/realtime-vad-segmenter.test.js` (new, 6 tests).
- Tests: +6; 0 removed; 0 flipped.
- Behavioural delta: none in shipping paths — this is an unwired, tested core
  module that a future live mode will consume.

## Operator-takeaway

The realtime plugin can't do local-VAD-with-a-batch-model today, but the hard,
reusable part — the silence-segmentation state machine — now exists and is
fully unit-tested without any mic/Pulse. What remains is the live wiring
(`/rt stt local-vad`: feed capture frames in, run `stt --stdin
--transcription-model mai-transcribe-1.5` on each event, insert partials on
`insert`, send on `commit`) and the operator-tunable thresholds / insert-vs-commit
semantics — all of which are your calls on your personal voice UX, so they wait
for your go-ahead (the follow-up draft tracks it). Note: `node --test` with the
default reporter hung when piped in this environment; `--test-reporter=dot|tap`
works — worth pinning in CI/non-TTY contexts.
