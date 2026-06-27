# Session summary — Live /cascade command: working multi-agent voice group chat (Phase 2e)

## Goal

Wire the tested cascade engine into a live `/cascade` command so the group chat
actually runs: mic in, per-agent turns, per-agent voice out, with a typed `say`
mode so it can be exercised without a microphone.

## Bead(s)

- `bd-7c6790` — Multi-participant group-chat for /rt + /cascade. Epic; the
  /cascade half is now functional end to end (the /rt multi-session half remains).

## Before state

- All cascade libs existed and were tested, but nothing wired them into the
  extension; there was no runnable command. Suite: 989 tests.

## After state

- `extensions/realtime-agent.js`: new `/cascade` command + a CascadeController/mic
  harness mirroring the local-vad path. Verbs: `start [n= participants= order=
  voice= model= base_url=]` (mic group chat), `say <text>` (drive a round from
  typed text, no mic), `stop`, `reset`, `status`. Default peer model `gpt-5-mini`
  (overridable via PI_CASCADE_MODEL or per-participant model=); output via the
  existing playPcmBuffer.
- `extensions/lib/realtime-cascade-session.js`: `cascadeRosterFromArgs` maps the
  command args onto a roster (tested).
- `extensions/lib/realtime-cascade.js`: strengthened the spoken-output system
  prompt (stay in character; plain sentences, no markdown/emoji/lists/urls).
- Tests: +3 (cascadeRosterFromArgs); suite 992 passing, 0 failing; `node --check`
  clean; the extension-importing realtime-agent.test.js (57 tests) still green.

## Before/after metrics

- Before: no runnable cascade.
- After: VALIDATED end to end with real LLM (gpt-5-mini via the proxy) + real tts
  (azure via the tts CLI), mocking only audio playback — a 3-agent round where
  each agent heard the prior speakers and answered in character with its own
  synthesised voice:
    main: "Hi var and cedar, I'm Main."
    var:  "Hi Main and Cedar, I'm Var."
    cedar:"Hi Main and Var, I'm Cedar."
  Round produced 5.68s of real PCM across 3 turns. Round wall time ~40s, dominated
  by cold per-turn tts (the warm-tts latency follow-up still stands).

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: extensions/realtime-agent.js, extensions/lib/realtime-cascade.js,
  extensions/lib/realtime-cascade-session.js, test/realtime-cascade-session.test.js.
- Tests: +3, 0 flipped.
- Behavioural delta: `/cascade` now exists and runs a real group chat.

## Operator-takeaway

The cascade group chat is functionally complete and validated end to end: try it
with `/cascade say hello everyone` (n defaults can be set via `/cascade start
n=3`), or `/cascade start participants=var,cedar` for a live mic room. Agents
genuinely hear each other and answer in character, each in its own voice. Two
known follow-ups: (1) live audio-playback + mic still need your ears on a real
terminal — I could only verify the PCM is generated, not heard; (2) latency — a
warm resident tts process would cut the ~13s/turn cold-synthesis cost. The /rt
multi-session half (agents hearing each other as audio over parallel realtime
websockets) is the remaining epic slice.
