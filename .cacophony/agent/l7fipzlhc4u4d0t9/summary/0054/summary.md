# Session summary — realtime summaries as background and partial transcript UI

## Goal

Stop realtime summary-mode context from being spoken as a user turn, and improve realtime/STT transcription behavior while the agent is already busy.

## Bead(s)

- `bd-ec9413` — Keep realtime summary context out of spoken user turns
- `bd-1c096b` — Show realtime partial transcription as pending UI

## Before state

- Failing tests: none in repository; live `/rt summary=true` spoke the compaction summary, then reported `Realtime summary context is too large`, and auto-compaction retried through realtime. STT during active work could throw `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`
- Relevant metrics: full `npm test` passed 148/148 before rebase.
- Context: summary mode forwarded the compact summary as a realtime `user` conversation item. Partial transcription deltas were not displayed before final transcript completion.

## After state

- Failing tests: none observed.
- Relevant metrics: after rebase, `npm test -- test/realtime-agent.test.js` passed 43/43 and `npm run docs:check` passed.
- Context: summary mode now injects compact context into realtime session instructions, caps summary text, and forwards only the current turn/audio trigger as conversation items. Partial input transcription deltas update `rt-transcript` as pending UI. Completed STT-only transcripts queue with `deliverAs: "followUp"` so they can be captured while the agent is busy.

## Diff summary

- Commits: `ec4609d`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`, `docs/realtime-agent.md`
- Tests: updated summary-mode test to assert summaries live in `session.update.instructions`, not `conversation.item.create`; updated STT transcript test to cover pending partial UI and follow-up queueing.
- Behavioural delta: compaction summaries should no longer be spoken aloud, summary mode should stay bounded, and live partial transcript UI appears while final STT commits still happen only on completion.

## Operator-takeaway

Summary context is now background system context for realtime, not something the model hears as a user message; meanwhile STT can be used during active work because completed transcripts are queued as follow-ups.
