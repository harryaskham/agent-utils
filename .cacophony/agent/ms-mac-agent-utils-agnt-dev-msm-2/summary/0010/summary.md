# Session summary — Audio-native /rt: output collector completes the routing pair (Phase 3b)

## Goal

Add the complement to the audio injection builder: a collector that accumulates a
realtime session's OUTPUT audio (PCM) and transcript from its event stream, so the
audio-native /rt round can capture speaker A's voice and route it into speaker B.

## Bead(s)

- `bd-7c6790` — Multi-participant group-chat epic (in_progress).
- `bd-07bb7f` — /rt audio-native multi-session (draft; this advances its foundation).

## Before state

- rt-multi had the INPUT side (buildHearAndRespondEvents) but no OUTPUT side; output
  audio collection lived only inline in the single-session RealtimeSession. Suite: 1006.

## After state

- `extensions/lib/realtime-rt-multi.js`: new `RtOutputCollector` (+ AUDIO_DELTA_TYPES /
  TRANSCRIPT_DELTA_TYPES / RESPONSE_DONE_TYPES) accumulating response.audio.delta /
  response.output_audio.delta base64 PCM and the transcript deltas, with `.pcm()` /
  `.text()` / `.done` and an injectable decode. Mirrors the single-session
  Buffer.from(delta,"base64") + Buffer.concat path.
- `test/realtime-rt-multi.test.js`: +5 tests (12 total), all passing.
- Suite: 1011 tests passing, 0 failing.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files: extensions/lib/realtime-rt-multi.js, test/realtime-rt-multi.test.js.
- Tests: +5, 0 flipped. Library only.

## Operator-takeaway

The audio-native /rt half now has its COMPLETE tested routing pair: collect speaker
A's spoken output (RtOutputCollector) and make speaker B hear it and respond
(buildHearAndRespondEvents). Turn order is planTurnRound. The only remaining piece
for that half is the live N-session orchestration that wires these against real
parallel realtime websockets — which genuinely needs a live endpoint to validate
(bd-07bb7f), so it stays for an operator-present session.
