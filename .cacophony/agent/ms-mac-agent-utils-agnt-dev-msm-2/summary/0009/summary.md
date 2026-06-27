# Session summary — Audio-native /rt foundation: hear-and-respond event builders (Phase 3a)

## Goal

Begin the second half of the group-chat vision (audio-native /rt, bd-07bb7f):
build the pure, tested realtime-protocol primitive for "make participant B hear
participant A's output audio and take its turn" — the building block that lets
parallel realtime sessions hear each other.

## Bead(s)

- `bd-7c6790` — Multi-participant group-chat epic (in_progress).
- `bd-07bb7f` — /rt audio-native multi-session (draft; this is its foundation).

## Before state

- The /cascade half was complete; the audio-native /rt half had no code. The
  realtime protocol for injecting audio into a session lived only inline in the
  single-session mic path. Suite: 999 tests.

## After state

- New `extensions/lib/realtime-rt-multi.js`: pure `chunkBuffer`,
  `buildAudioInjectionEvents` (append chunks + commit), `buildResponseCreateEvent`,
  and `buildHearAndRespondEvents` (append+commit+response.create) — the wire
  events that make a realtime session hear PCM and respond. Turn ORDER is already
  provided by planTurnRound.
- New `test/realtime-rt-multi.test.js`: 7 tests, all passing.
- Suite: 1006 tests passing, 0 failing.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files: extensions/lib/realtime-rt-multi.js (new), test/realtime-rt-multi.test.js (new).
- Tests: +7, 0 flipped. New library only.
- Behavioural delta: none at runtime; this is the protocol substrate for the
  multi-session orchestration, which still needs live realtime validation.

## Operator-takeaway

The audio-native /rt half now has its core primitive: a tested way to feed one
agent's spoken audio into another agent's realtime input and trigger its reply.
The remaining work for that half is the live multi-session orchestration (N
parallel websockets routed through these events), which needs a real realtime
connection to validate — so it stays on bd-07bb7f for an operator-present session.
