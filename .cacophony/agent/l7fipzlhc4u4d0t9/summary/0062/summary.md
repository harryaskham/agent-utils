# Session summary — reported realtime tool-call IDs

## Goal

Tie the broader open tool-call tracking beads to the realtime call-ID fix by adding regression coverage for the exact reported IDs that had produced “tool_call_id not found in conversation”.

## Bead(s)

- `bd-2d25b5` — Review and fix tool call tracking mechanism
- `bd-b6b2cc` — Investigate Tool call ID not found errors in conversation

## Before state

- Failing tests: none observed after the existing realtime call-ID fix.
- Relevant metrics: the open beads cited `call_1fk4b5p_1` and `call_1lg16bt_2` as missing from conversation context.
- Context: the implementation already distinguishes live realtime model-emitted call IDs from replayed historical IDs, but the broad P0/P1 beads remained open without a landed regression referencing the reported IDs.

## After state

- Failing tests: none observed.
- Relevant metrics: `npm test -- test/realtime-agent.test.js` passed 48/48, `npm run docs:check` passed, and full `npm test` passed 154/154.
- Context: the live-call-ID regression now covers `call_live_123`, `call_1fk4b5p_1`, and `call_1lg16bt_2`, asserting all are preserved exactly when creating realtime `function_call_output` items.

## Diff summary

- Code/content commits: `efd988f`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `test/realtime-agent.test.js`
- Tests: expanded realtime tool-call ID regression to include the exact reported sanitized-looking IDs.
- Behavioural delta: no runtime code changed in this slice; it locks in the previous runtime fix against the broad reported failure shape.

## Operator-takeaway

The broad tool-call tracking reports are covered by a concrete regression now: live realtime IDs that look like sanitized IDs must still be treated as server-known live IDs and preserved exactly.
