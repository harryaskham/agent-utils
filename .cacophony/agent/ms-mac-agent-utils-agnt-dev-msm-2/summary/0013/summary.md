# Session summary — Audio-native /rt round orchestrator (Phase 3c)

## Goal

Build the orchestration logic for the audio-native /rt group chat (bd-07bb7f):
sequence which audio each participant hears (the human, then every earlier speaker
this round) and serialize playback, delegating the live realtime injection/response
to an injected adapter so the routing logic is testable without a live endpoint.

## Bead(s)

- `bd-7c6790` — group-chat epic (in_progress).
- `bd-07bb7f` — /rt audio-native multi-session (draft; this is its orchestrator).

## Before state

- rt-multi had the audio-routing primitive PAIR (inject + collect) but no
  orchestrator tying them into a round. Suite: 1019 (1026 after pipelining).

## After state

- `extensions/lib/realtime-rt-multi.js`: new `runRtMultiRound` — model-agnostic
  routing. For each participant in planTurnRound order it passes the to-hear audio
  segments (human + every earlier speaker) to an injected
  `injectAndRespond(index, audioSegments, turn)` dep, accumulates each output for
  the next speaker, and serializes playback to the human via a play-chain. The
  realtime injection model lives entirely in the adapter (deferred for live
  validation), so the orchestrator's routing/sequencing is testable now.
- `test/realtime-rt-multi.test.js`: +5 tests (routing, ordered playback, silent
  turn / missing human, play-error), 17 total, all passing.
- Suite: 1031 passing, 0 failing; node --check clean.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files: extensions/lib/realtime-rt-multi.js, test/realtime-rt-multi.test.js.
- Tests: +5, 0 flipped. Library only.
- Behavioural delta: none at runtime; the orchestrator is wired to live realtime
  sessions (the injectAndRespond adapter) + a /rt-multi command in the live slice,
  which needs a real realtime endpoint to validate.

## Operator-takeaway

The audio-native /rt half now has its full testable spine: the routing
orchestrator (this), the inject primitive (buildHearAndRespondEvents), and the
collect primitive (RtOutputCollector). What remains is purely the LIVE adapter —
wiring injectAndRespond to real parallel realtime websockets and a /rt-multi
command — which genuinely needs a live endpoint and your ears to validate the
audio-injection model (concatenated segments vs separate items). That's the one
piece I'm intentionally not building blind.
