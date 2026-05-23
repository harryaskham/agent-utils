# Session summary — Cursor diagnostics in gfx status

## Goal

Make the live cursor anchoring readout visible in ordinary `/gfx status`, not only the cursor-specific/debug commands.

## Bead(s)

- `bd-9e0a93` — Show cursor anchoring in Pi graphics status

## Before state

- Failing tests: none known.
- Relevant metrics: `/gfx cursor status`, `/gfx debug`, and `/gfx cursor preview` exposed cursor diagnostics, but the default status path did not.
- Context: The change needed to keep `/gfx status` read-only and bounded while surfacing anchor sequence, visible placement id, offsets, stale deletion mode, and reverse reset support.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 102/102; full `npm test` passed 284/284; `npm run docs:check` passed; `git diff --check` passed.
- Context: `/gfx status` now includes `cursor: ${cursorAnchorDiagnosticLine()}` in the normal settings summary.

## Diff summary

- Code/content commits: `a1c1797`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`.
- Tests: extended source guards to require cursor diagnostics in the standard status summary.
- Behavioural delta: Operators can see cursor anchor state from the default status readout without rendering previews or enabling debug widgets.

## Operator-takeaway

`/gfx status` is now enough to inspect whether the graphical cursor is using the current anchoring contract before choosing deeper preview/debug/clear commands.
