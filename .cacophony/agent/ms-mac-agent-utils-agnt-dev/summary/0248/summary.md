# Session summary — realtime compaction threshold diagnostics

## Goal

Expose enough `/rt` status/doctor information to explain reports that realtime compacts too early, without guessing whether Pi is using a 128k realtime model window, a larger text-model window, or a specific reserve/keep setting.

## Bead(s)

- `bd-725249` — Expose realtime compaction threshold diagnostics

## Work completed

- Added realtime context diagnostics in `extensions/realtime-agent.js`:
  - selected realtime context window
  - Pi compaction reserve tokens
  - derived compaction threshold (`contextWindow - reserveTokens`) with percentage
  - keepRecentTokens when available
  - current estimated full-history and summary-mode realtime context token usage when session context is accessible
- Wired the diagnostic line into `/rt status full` and `/rt doctor` via `statusLines(..., { full: true })`.
- Updated `test/realtime-agent.test.js` to assert the diagnostic line includes `window`, `compactAt`, `reserve`, `keep`, and full/summary estimates.
- Coordinated the separate kittwm viewport-row hypothesis to the two kittui agents via direct caco messages, without editing kittui from this agent-utils checkout.

## Validation

- `node --check extensions/realtime-agent.js`
- `node --test test/realtime-agent.test.js` — 49/49 pass
- `npm run docs:check` — pass
- `git diff --check` — pass
- `npm test` — 293/293 pass

## Diff summary

- Code commit: `602c5f6`.
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`.
- Behavioural delta: `/rt status full` and `/rt doctor` now show a line like `context: window:128,000 · compactAt:111,616 (87.2%) · reserve:16,384 · keep:40,000 · full:... · summary:...`.

## Operator-takeaway

This does not change compaction timing; it makes the selected realtime threshold explicit. If compaction appears around 50%, compare `/rt status full` against the actual footer percentage source. The kittwm row/viewport clamp itself is not finished here; it was handed to kittui agents to avoid overlapping checkouts.
