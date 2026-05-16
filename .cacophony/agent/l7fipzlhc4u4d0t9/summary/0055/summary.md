# Session summary — live realtime tool call IDs

## Goal

Fix realtime tool calls failing after invocation with `tool_call_id not found in conversation`, while preserving the earlier protection against overlong historical tool IDs.

## Bead(s)

- `bd-f0af65` — Realtime tool-call ID not found after tool invocation

## Before state

- Failing tests: none in repository; live `/rt` showed every tool call killing realtime with a call-id-not-found error.
- Relevant metrics: full `npm test` passed 149/149 before this patch.
- Context: the previous long-ID fix mapped all tool IDs, including IDs emitted by the live realtime model. For live tool calls, the realtime server already knows the original `call_id`; mapping the tool result to a new short ID makes the server reject the output as not found.

## After state

- Failing tests: none observed.
- Relevant metrics: after rebase, `npm test -- test/realtime-agent.test.js` passed 44/44.
- Context: `realtimeCallId()` now preserves IDs that were emitted by the live realtime model and only maps long/replayed historical IDs. Tool result forwarding uses the original live call ID when present in `callIdsEmittedByModel`.

## Diff summary

- Commits: `af78a90`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`
- Tests: +1 regression test simulating a live model-emitted function call, then forwarding a tool result and asserting the original `call_live_123` ID is used for `function_call_output`.
- Behavioural delta: live realtime tool calls should no longer die with missing call ID errors, while long historical IDs remain sanitized to satisfy the 32-character Realtime limit.

## Operator-takeaway

There are two ID paths now: live realtime call IDs are preserved exactly; replayed historical IDs are sanitized only when necessary.
