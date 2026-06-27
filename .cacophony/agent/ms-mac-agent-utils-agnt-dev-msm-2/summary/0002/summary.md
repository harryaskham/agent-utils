# Session summary — Cascade orchestration logic (Phase 2b)

## Goal

Build the heart of the `/cascade` group chat: the turn-taking logic where one
human utterance fans out to one reply per agent, in order, with each agent
hearing the human and everyone who already spoke this round — realised as text
context. Keep it pure/injectable so the whole round is unit-tested without a live
LLM or audio.

## Bead(s)

- `bd-7c6790` — Multi-participant group-chat for /rt + /cascade. Epic; stays
  in_progress (Phase 2b; live wiring + a peer-LLM caller + command UX follow).

## Before state

- Cascade had its two I/O primitives (stt-batch, tts-batch) but no orchestration:
  nothing sequenced turns or built each agent's "what I heard" context.
- Suite: 952 tests.

## After state

- New `extensions/lib/realtime-cascade.js`:
  - `defaultCascadeSystem` / `buildCascadeTurnMessages` — pure: build a
    participant's chat messages from the running conversation. The agent's own
    prior turns become `assistant` messages; the human and other speakers become
    speaker-labelled `user` messages, so the model tracks who said what.
  - `runCascadeRound` — async orchestration with injected deps (`runTurn`,
    `speak`, `onTurn`): picks the order via planTurnRound, runs each turn
    sequentially, appends each reply so the next agent hears it, and returns the
    round transcript + accumulated conversation.
- New `test/realtime-cascade.test.js`: 11 tests, all passing — including the
  key property that the Nth speaker's context contains the human plus the N-1
  earlier speakers.
- Suite: 962 tests passing, 0 failing.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/lib/realtime-cascade.js` (new),
  `test/realtime-cascade.test.js` (new).
- Tests: +11, 0 flipped. New library only; zero regression surface.
- Behavioural delta: none at runtime yet; the round-runner is wired to a live
  peer-LLM caller and the tts/play deps in the next slices.

## Operator-takeaway

The conversation logic now exists and is proven: agents take turns in arbitrary
order and genuinely hear each other, expressed as labelled chat context, with a
clean seam (`runTurn` / `speak` deps) where the real LLM call and the warm tts
voice plug in. What remains for a talking demo is small and mechanical: a
fetch-based peer chat-completions caller, the warm-tts speak dep, and the
`/cascade` command that drives a round on each human turn.
