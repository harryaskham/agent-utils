# Session summary — Audio-native /rt peer-turn adapter (Phase 3d)

## Goal

Build the concrete `injectAndRespond` adapter the rt-multi orchestrator needs:
inject the to-hear audio into one realtime peer session, trigger its response, and
collect the spoken output until done — built from the tested primitives and
decoupled from any live websocket via injected send/onEvent, so it is unit-tested.

## Bead(s)

- `bd-7c6790` — group-chat epic (in_progress).
- `bd-07bb7f` — /rt audio-native multi-session (draft; this is its turn adapter).

## Before state

- rt-multi had primitives (inject/collect) + the routing orchestrator, but nothing
  drove a single peer session's turn. Suite: 1040.

## After state

- New `extensions/lib/realtime-rt-peer.js`: `runPeerTurn` (inject concatenated
  to-hear audio + commit + response.create via buildHearAndRespondEvents, collect
  via RtOutputCollector until response.done, resolve {pcm,text}; timeout + cleanup)
  and `makeInjectAndRespond(sessions)` adapting indexed sessions into the
  orchestrator's dep. Both decoupled from the websocket via injected send/onEvent.
- New `test/realtime-rt-peer.test.js`: 6 tests (inject/commit/respond shape, output
  collection, no-audio still responds, timeout, missing-dep guards, per-index
  routing), all passing.
- Suite: 1051 passing; node --check clean.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files: extensions/lib/realtime-rt-peer.js (new), test/realtime-rt-peer.test.js (new).
- Tests: +6, 0 flipped. Library only.

## Operator-takeaway

The audio-native /rt half is now built end-to-end EXCEPT the live websocket glue:
roster + turn order (planTurnRound), routing orchestrator (runRtMultiRound),
per-turn inject/respond/collect (runPeerTurn/makeInjectAndRespond), and the
protocol primitives — all unit-tested. The single remaining piece is opening the N
parallel realtime websockets and wiring each session's send/onEvent to a live
endpoint, plus a /rt-multi command. That genuinely needs a live realtime endpoint
(and your ears for the concatenated-audio model) to validate, so it's the one part
left to build together rather than blind.
