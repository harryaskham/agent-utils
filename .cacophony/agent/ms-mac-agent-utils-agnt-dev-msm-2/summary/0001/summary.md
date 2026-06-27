# Session summary — Cascade TTS primitive (Phase 2a)

## Goal

Add the missing output primitive for the new `/cascade` group-chat mode: turn an
agent's text reply into audio it can speak directly, bypassing `caco msg speak`
and the daemon for latency (operator request). This mirrors the existing batch
STT primitive so cascade has both halves of speech in / speech out.

## Bead(s)

- `bd-7c6790` — Multi-participant group-chat for /rt + /cascade. Epic; stays
  in_progress (this is Phase 2a; the orchestrator + command UX follow).

## Before state

- Cascade had STT (`realtime-stt-batch.js`) but no TTS primitive; the realtime
  path only produced audio via the websocket.
- Suite: 926 tests.

## After state

- New `extensions/lib/realtime-tts-batch.js`: `buildTtsBatchArgs` (pure) +
  `synthesizeToPcm` (injectable spawn) that run `tts --stdout --response-format
  pcm -- <text>` and resolve with raw PCM16/24k/mono — the exact format
  `playPcmBuffer` already consumes, so cascade output needs no transcoding.
- New `test/realtime-tts-batch.test.js`: 10 tests, all passing.
- Suite: 936 tests passing, 0 failing.
- Verified end to end against the real `tts` CLI: a short clip synthesised to
  ~2.16s of valid PCM.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/lib/realtime-tts-batch.js` (new),
  `test/realtime-tts-batch.test.js` (new).
- Tests: +10, 0 flipped. New library only; zero regression surface.
- Behavioural delta: none at runtime yet (substrate); wired in the cascade
  orchestrator next.

## Operator-takeaway

Cascade now has both speech halves as tested, daemon-free primitives: `stt`
in, `tts` out, both as raw 24kHz PCM that drops straight into the existing
player. One real-world note worth flagging: a cold `tts` round-trip took ~43s
for a 2-second clip in this environment (python + proxy cold start), so the
cascade orchestrator should keep a WARM resident tts process (the CLI's
streaming `--stdin` mode) rather than cold-spawning per utterance — that is the
latency path Phase 2b should take.
