# Session summary — Queue realtime STT transcripts

## Goal

Fix the realtime/STT path that surfaced `Agent is already processing` when speech input arrived while Pi was still handling a prior turn, so spoken transcripts queue seamlessly instead of producing a runtime extension error.

## Bead(s)

- `bd-c16f28` — Queue realtime and STT messages while Pi is already processing

## Before state

- Failing tests: none known at session start.
- Relevant metrics: existing realtime unit coverage passed before this change, but there was no assertion that STT transcript injection supplied a queueing mode.
- Context: STT-only transcription called `pi.sendUserMessage(text)` without `deliverAs`, which can make Pi throw `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.` during active agent work.

## After state

- Failing tests: none in validation run.
- Relevant metrics: `node --test test/realtime-agent.test.js` passed 42 tests; `npm test` passed 147 tests.
- Context: STT-only completed transcripts are now sent with `{ deliverAs: "followUp" }`, matching the intended queueing behavior while leaving full realtime audio turns on the existing hidden follow-up trigger path.

## Diff summary

- Code/content commits: `b4d5e2e`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`
- Tests: +1 realtime regression test / -0 / flipped 0
- Behavioural delta: Realtime STT transcript input now queues as a follow-up turn if the agent is busy, preventing the user-visible already-processing error for speech-to-text input.

## Operator-takeaway

Speech-to-text turns should now behave like seamless queued follow-ups when the agent is mid-task, which is the right default for talking over a busy realtime session.
