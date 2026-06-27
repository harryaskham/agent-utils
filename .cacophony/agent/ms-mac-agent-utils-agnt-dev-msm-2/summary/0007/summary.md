# Session summary — Cascade robustness: history cap + reply-length cap (Phase 2g)

## Goal

Harden the working /cascade for long-lived use: bound the running conversation so
context (and cost) does not grow without limit across many rounds, and keep spoken
replies short by default.

## Bead(s)

- `bd-7c6790` — Multi-participant group-chat for /rt + /cascade (epic; in_progress).

## Before state

- CascadeController.conversation grew unbounded; each turn's messages include the
  whole history, so a long group chat would inflate context/cost. Peer replies had
  no length cap. Suite: 992 tests.

## After state

- `extensions/lib/realtime-cascade-session.js`: CascadeController gains a
  `maxHistory` sliding-window cap (trims conversation to the last N entries after
  each round; 0 = unbounded). `makeCascadeRunTurn` now defaults `maxTokens` to 200
  so spoken replies stay short (overridable).
- `extensions/realtime-agent.js`: /cascade wires maxHistory (default 48, override
  via `maxhistory=` arg or PI_CASCADE_MAX_HISTORY).
- Tests: +3 (history cap kept/unbounded, maxTokens default/override); suite 995
  passing; node --check clean; realtime-agent.test.js (57) green.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files: extensions/lib/realtime-cascade-session.js,
  test/realtime-cascade-session.test.js, extensions/realtime-agent.js.
- Tests: +3, 0 flipped.

## Operator-takeaway

/cascade is now safe for long sessions: the conversation is a sliding window
(default 48 entries ≈ 12 rounds of four) and replies are capped short for natural
speech. Both are tunable. The feature is complete and hardened; remaining epic
work (audio-native /rt, warm tts) stays tracked as drafts.
