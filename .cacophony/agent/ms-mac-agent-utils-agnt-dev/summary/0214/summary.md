# Session summary — Graphical cursor anchoring fix

## Goal

Fix Harry's live report that the Pi graphical cursor still rendered several columns too far right and at least one row too low, sometimes appearing on footer/IME-adjacent chrome rather than centered on the actual editor cursor cell.

## Bead(s)

- `bd-399937` — Fix Pi graphics cursor centering on IME cursor cell

## Before state

- Failing tests: none known, but live visual behaviour was wrong.
- Relevant metrics: graphical cursor artwork was attached through a relative kitty placement using a stable transparent parent placement id and stale cleanup deleted by image id.
- Context: Reusing the same transparent parent placement id meant kitty could resolve the visible relative placement against an older same-id anchor elsewhere in the TUI/scrollback. Deleting by image id also fought the image cache instead of deleting only the prior visible placement. The reverse-video cursor matcher also only guarded `ESC[0m`, while Pi TUI input uses `ESC[27m` for reverse reset.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 100/100; full `npm test` passed 282/282; `npm run docs:check` passed; `git diff --check` passed.
- Context: Cursor anchors now reuse the transparent anchor image but get a fresh placeholder placement id on each render, the prior visible cursor is deleted by placement id only, and the reverse-video cursor matcher accepts both `ESC[0m` and Pi TUI's `ESC[27m` reset.

## Diff summary

- Code/content commits: `f2cce30`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`.
- Tests: updated source guards for fresh cursor anchor ids, placement-only stale deletion, inline Unicode placeholder line construction, and `ESC[27m` reverse reset handling.
- Behavioural delta: The visible 11x5 cursor image is still centered with half-width/half-height offsets, but it is now attached to the latest cursor-cell anchor rather than an ambiguous reused parent placement.

## Operator-takeaway

The cursor should now center on the live IME/editor cursor cell because each redraw creates a unique transparent anchor placement and deletes only the previous visible cursor placement.
