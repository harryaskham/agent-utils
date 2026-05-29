# Session summary — bd-9c1894 post-compaction assistant-role continuation guard

## Bead

- `bd-9c1894` — Fix post-compaction continue from assistant role

## Problem

Pi core refuses to continue an agent loop when the current model-context transcript ends with an assistant message (`Cannot continue from message role: assistant`). After compaction, the rebuilt context can legally contain a compaction summary followed by retained recent messages whose newest entry is assistant-authored. A retry/manual continue from that boundary can therefore fail before a new user/custom/tool-role entry is present.

## Change

- Added `extensions/compaction-continue-guard.js`.
- Registered it in `package.json` before auth/update helpers.
- On `session_compact`, it appends a hidden custom checkpoint message (`agent-utils.compaction-continue-boundary`) without triggering a turn.
- Custom Pi messages convert to user-role LLM messages, so the post-compaction transcript ends at a valid user/custom boundary rather than an assistant boundary.
- The checkpoint text tells automatic retries to continue the interrupted/most recent user request, while otherwise waiting for the next explicit instruction.
- Added opt-out: `PI_COMPACTION_CONTINUE_GUARD=0`.

## Validation

- `node --test test/compaction-continue-guard.test.js` — pass, 4 tests.
- `npm run docs:check` — pass.
- `git diff --check` — pass.
- `npm test` — pass, 336 tests.
