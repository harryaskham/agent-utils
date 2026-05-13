# Session summary — realtime transcript display without duplicate turns

## Goal

Stop full realtime transcript display from waking a second assistant response after the audio-native realtime answer has already completed.

## Bead(s)

- `bd-701b88` — Prevent realtime transcript UI echoes from triggering follow-up turns

## Before state

- Failing tests: none in repository; live `/rt` showed the audio-native answer, then a visible `◇` transcript, then a duplicate assistant answer.
- Relevant metrics: realtime suite was 35/35 before the follow-up patch.
- Context: full realtime transcript display used `pi.sendMessage(..., { deliverAs: "followUp" })`, which can enqueue a follow-up custom message that wakes another model turn even without `triggerTurn`.

## After state

- Failing tests: none observed.
- Relevant metrics: after rebase, `npm test -- test/realtime-agent.test.js` passed 35/35 and `npm run docs:check` passed.
- Context: full realtime transcripts now update an `rt-transcript` UI status line directly. They are not session messages, not model-visible, and not follow-up queue entries. STT-only mode still injects transcript user messages by design.

## Diff summary

- Commits: `d526038`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`
- Tests: updated the audio-native realtime test to require exactly one hidden custom turn trigger, no `sendUserMessage`, and transcript display via status rather than `sendMessage`.
- Behavioural delta: full `/rt` should no longer produce duplicate assistant replies when the transcript arrives after the audio response trigger.

## Operator-takeaway

The duplicate response came from using the follow-up message queue for a transcript that was meant to be display-only. Full realtime transcripts now bypass the agent queues entirely.
