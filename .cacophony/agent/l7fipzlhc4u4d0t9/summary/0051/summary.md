# Session summary — realtime call-id sanitization

## Goal

Fix a live `/rt` crash caused by forwarding long historical tool call IDs into OpenAI Realtime, and ensure realtime errors do not leave the UI stuck in `speaking` or `thinking`.

## Bead(s)

- `bd-df860a` — Sanitize realtime tool call IDs and recover from realtime errors

## Before state

- Failing tests: none in repository; live `/rt` failed with `Invalid 'item.call_id': string too long. Expected a string with maximum length 32, but got a string with length 438`, then status stayed `mode:speaking`.
- Relevant metrics: full suite was 139/139 before this patch.
- Context: history replay forwarded Pi/tool call IDs directly as Realtime `call_id` values. Some IDs can be much longer than Realtime's 32-character limit.

## After state

- Failing tests: none observed.
- Relevant metrics: after rebase, `npm test -- test/realtime-agent.test.js` passed 40/40.
- Context: replayed tool calls/tool results now use a deterministic <=32-character realtime call ID mapped from the original Pi call ID, preserving pairing while satisfying the realtime API. Error events clear pending response state and return from `speaking`/`thinking` to `idle`.

## Diff summary

- Commits: `957d4a2`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`
- Tests: +1 realtime test that replays a 438-character tool call ID, asserts both function call and output use the same sanitized <=32-character ID, and asserts a server error resets phase to idle.
- Behavioural delta: large histories with old tool calls should no longer crash the realtime session, and realtime server errors should not leave the status stuck.

## Operator-takeaway

The immediate crash was not audio-related; it was history replay sending an invalid tool call ID to Realtime. Replayed tool IDs are now safely mapped, and error cleanup is more robust.
