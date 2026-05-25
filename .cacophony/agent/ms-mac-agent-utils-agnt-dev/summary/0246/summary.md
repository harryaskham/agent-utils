# Session summary — realtime simple compaction stays in /rt

## Goal

Fix realtime compaction so `/rt` mode does not stop early, restore the previous text model, and cancel compaction. While realtime is active, compaction should use a simple/local path that avoids sending summarization requests to `gpt-realtime-2` and keeps realtime selected.

## Bead(s)

- `bd-1e125b` — Use builtin simple compaction while realtime is active

## Before state

- Realtime's `session_before_compact` handler disabled realtime, restored the previous text model, warned the user, and returned `{ cancel: true }`.
- Manual `/compact` during realtime needed a retry after the model restore; auto-compaction cancelled and waited for a later text-model turn.

## After state

- Realtime's `session_before_compact` handler now returns an extension-provided local/simple compaction result while realtime is active.
- The simple checkpoint preserves previous summary text, file lists from `preparation.fileOps`, role counts, and bounded excerpts from summarized messages.
- Realtime remains selected; no text-model restore is performed and no compaction request is sent to `gpt-realtime-2`.
- Realtime history cursor/session update caches reset after compaction so the next turn does not slice from stale pre-compaction message counts.

## Validation

- `node --check extensions/realtime-agent.js`
- `node --test test/realtime-agent.test.js` — 49/49 pass
- `npm run docs:check` — pass
- `git diff --check` — pass
- `npm test` — 293/293 pass

## Diff summary

- Code commit: `7bce227`.
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`, `docs/realtime-agent.md`.
- Behavioural delta: `/rt` compaction no longer exits realtime or cancels; it writes a deterministic simple compaction entry and keeps recent messages via Pi's normal `firstKeptEntryId` retention.

## Operator-takeaway

After updating/reloading the extension, manual and auto compaction during realtime should complete in-place. The UI notification should say realtime compaction used local simple mode and realtime stays active.
