# Session summary — Cursor anchor diagnostics

## Goal

Make the recent graphical cursor anchoring fix easier to inspect live by adding compact diagnostics to Pi graphics cursor preview/debug output.

## Bead(s)

- `bd-21b8a3` — Show Pi graphics cursor anchor diagnostics

## Before state

- Failing tests: none known.
- Relevant metrics: `bd-399937` had just landed the fresh-anchor cursor fix, but `/gfx cursor preview` and `/gfx debug` did not expose the anchoring invariants an operator needs to verify live behaviour.
- Context: The diagnostic needed to stay bounded and non-mutating while reporting fresh anchor placement ids, visible placement id state, centered offsets, placement-only stale deletion, and Pi TUI reverse-reset matching.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 102/102; full `npm test` passed 284/284; `npm run docs:check` passed; `git diff --check` passed.
- Context: `/gfx debug` now shows cursor anchor sequence, visible placement id, offsets, stale-delete mode, and reset matcher support. `/gfx cursor preview` includes the same compact live-alignment diagnostic line.

## Diff summary

- Code/content commits: `e89afb8`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`.
- Tests: extended source guards to require cursor anchor diagnostics in debug/preview output.
- Behavioural delta: No rendering behaviour changed; operators get a direct readout of the cursor anchoring contract while inspecting preview/debug output.

## Operator-takeaway

Cursor alignment issues should now be easier to diagnose because `/gfx debug` and `/gfx cursor preview` display the fresh-anchor and placement cleanup invariants directly.
