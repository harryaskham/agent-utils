# Session summary — Group-chat foundation: participant roster (Phase 1)

## Goal

Begin building Harry's group-chat feature: let `/rt` and `/stt` (and a new
`/cascade` mode) host MULTIPLE AI participants who take turns and hear each
other. This session lands Phase 1 — the pure, fully-tested foundation that the
later audio-orchestration phases build on.

## Bead(s)

- `bd-7c6790` — Multi-participant group-chat for /rt + new /cascade mode
  (STT+TTS turn-taking, agents hear each other). Epic; stays in_progress for
  Phases 2–4.

## Before state

- `extensions/realtime-agent.js` was single-session only (one WSS, one voice).
- No participant-roster concept, no turn-round planning, no `/cascade` notion.
- Test suite: 882 tests passing.

## After state

- New `extensions/lib/realtime-participants.js`: pure roster modelling —
  spec parsing (`participants=name[voice=..,model=..,base_url=..,tts=..]`,
  `;`/`,` separated, bracket-aware), mode-aware default voices (rt assigns
  distinct pool voices, main defaults to marin / env voice; cascade defaults all
  to the caco azure embedding voice unless overridden), and `planTurnRound`
  which produces the turn order (fixed / random / round-robin) plus each turn's
  `hearsFrom` (human + every earlier speaker this round — the "agents hear each
  other" rule).
- New `test/realtime-participants.test.js`: 24 tests, all passing.
- Full suite: 906 tests passing, 0 failing.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/lib/realtime-participants.js` (new),
  `test/realtime-participants.test.js` (new).
- Tests: +24, 0 flipped. No existing code modified, so zero regression surface.
- Behavioural delta: none yet at runtime — this is library substrate not wired
  into a command. Wiring lands in Phase 2 (cascade) / Phase 3 (rt multi-session).

## Operator-takeaway

The group-chat substrate is in and proven: how participants are declared, how
each gets a voice, and how a single human turn fans out to one ordered turn per
agent where each agent hears the humans and everyone who spoke before it this
round. It is deliberately pure/unit-tested so the risky audio plumbing (cascade
STT→LLM→TTS, and routing one realtime agent's audio into the next's input) can be
layered on a verified core. Next: Phase 2 wires `/cascade` end to end.
