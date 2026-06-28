# Session summary — Cascade latency pipelining (Phase 2j)

## Goal

Cut /cascade round latency (the main UX weakness Harry flagged): overlap each
turn's TTS synthesis with playback so a multi-agent round runs roughly in half
the time, without changing the "agents hear each other" semantics.

## Bead(s)

- `bd-7c6790` — Multi-participant group-chat epic (in_progress; implemented per
  Harry's "dev workers don't idle, implement ready work" directive while the
  agent-utils queue is empty and I'm worker-scope-locked to it).

## Before state

- runCascadeRound was strictly sequential per turn: LLM -> synth -> play, awaited
  one at a time, so a 3-agent round was ~LLM+synth+play times three (~50s).
  Suite: 1019.

## After state

- `extensions/lib/realtime-cascade.js`: runCascadeRound gains optional `synth` +
  `play` (+ `onSpeak`) deps. In pipelined mode the LLM turns stay sequential (each
  hears the last) but each turn's synthesis is kicked off CONCURRENTLY as its text
  is ready, while playback is serialized in turn order via a play-chain. Independent
  TTS network calls overlap across turns and hide under earlier playback. The
  sequential `speak` path is unchanged (backward compatible).
- `extensions/lib/realtime-cascade-session.js`: `makeCascadeSynth` /
  `makeCascadePlay` factories (sanitise + synth; ordered play); CascadeController
  threads synth/play/onSpeak.
- `extensions/realtime-agent.js`: /cascade uses the pipelined path by DEFAULT
  (opt out with `pipeline=false` or PI_CASCADE_PIPELINE=0); onTurn updates the
  transcript at text-ready, onSpeak updates "now: speaking" at play time.
- Tests: +7 (pipeline order/concurrency/onSpeak/error + the two factories +
  controller pipelined round). Suite 1026 passing; node --check clean; the
  extension-importing realtime-agent.test.js green.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files: extensions/lib/realtime-cascade.js, extensions/lib/realtime-cascade-session.js,
  extensions/realtime-agent.js, test/realtime-cascade.test.js,
  test/realtime-cascade-session.test.js.
- Tests: +7, 0 flipped. Sequential path preserved.

## Operator-takeaway

A /cascade round should now feel roughly twice as quick: the agents' replies are
synthesised in parallel and played back in order, so the room doesn't pause a
full synth between every voice. The "each agent hears the previous" behaviour is
unchanged (it's text-context, computed before playback). Final feel still wants
your ears — a warm/faster TTS provider (bd-67b916) would compound this — but the
ordering, concurrency, and error handling are unit-proven, and you can A/B it
against the old behaviour with `/cascade start pipeline=false`.
