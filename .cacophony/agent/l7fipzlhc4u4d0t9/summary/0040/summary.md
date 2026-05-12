# Session summary — realtime summary context mode

## Goal

Add a default-off `/rt summary=true|false` control so realtime calls can avoid replaying full conversation history into the realtime WebSocket, while protecting full-history mode from exceeding the 128k realtime context window.

## Bead(s)

- `bd-49c61b` — Add /rt summary option for compact realtime context

## Before state

- Failing tests: none observed.
- Relevant metrics: realtime forwarded full `context.messages` into the WSS history replay path; no explicit guard aborted oversized histories before opening the realtime socket.
- Context: the operator requested `summary=true/false`, default false, and an abort when full history exceeds the 128k `gpt-realtime-2` context window.

## After state

- Failing tests: none observed.
- Relevant metrics: `npm test` passed 99/99 before rebase; after rebase, `npm test -- test/realtime-agent.test.js` passed 30/30 and `npm run docs:check` passed.
- Context: `/rt summary=true` and the `summary` tool/env-style parameter now enable compact-summary history replay. Full-history mode estimates outgoing realtime context and aborts when it exceeds the model context window. Summary mode remains default false.

## Diff summary

- Commits: `7acab6b`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`, `docs/realtime-agent.md`, `README.md`
- Tests: +2 realtime tests covering summary-mode forwarding and oversized full-history abort; existing Pulse/tool control test updated to cover `summary` toggling.
- Behavioural delta: realtime status now reports `summary:on/off`; summary mode forwards existing Pi compaction/branch summaries plus the current turn, with a bounded recent-message fallback if no saved summary is present.

## Operator-takeaway

Realtime now has a safe, opt-in compact context path: use `/rt summary=true` before a call when the session is large, while the default `/rt summary=false` still preserves the old full-history behavior and refuses to overflow the realtime model context.
