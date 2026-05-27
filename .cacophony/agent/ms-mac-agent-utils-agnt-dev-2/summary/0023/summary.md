# Session summary — Direct cursor cell plus relative 11×5 halo

## Goal

Restore the intended large live cursor glow while preserving the proven direct Unicode cursor placement. Harry clarified that the point of the original 11×5 cursor was to let glow expand beyond the cell, and proposed drawing the cell cursor anyway then attempting the additional relative halo.

## Bead(s)

- `bd-eaf440` — Restore large cursor glow without relative placement drift

## Before state

- Failing tests: none known.
- Relevant metrics: live cursor was visible and correctly positioned again, but only as a 1×1 direct Unicode placeholder glow; the intended larger 11×5 halo was missing.
- Context: trailing workspace proves direct Unicode placeholders in the render text flow land correctly. The relative halo should be an out-of-band lifecycle/graphics addition, not the sole cursor representation.

## After state

- Failing tests: none.
- Relevant metrics: `node --test test/pi-graphics.test.js test/kitty-graphics.test.js test/box-chrome.test.js` passed; `npm run docs:check` passed; `git diff --check` passed; `npm test` passed 295 tests.
- Context: glow mode now renders a direct one-cell Unicode cursor first, then side-channel emits the 11×5 relative halo against that same visible cursor placement with H=-5,V=-2. The halo is drawn at background z-index so, if it drifts/fails, it should not hide the proven cursor cell.

## Diff summary

- Code/content commits: 1383bac.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `docs/pi-graphics.md`, `docs/kitty-graphics-protocol-audit.md`, `test/pi-graphics.test.js`.
- Tests: updated source guards to require direct cursor cell plus relative halo in glow mode.
- Behavioural delta: live default `glow` is now a hybrid: direct visible cursor cell in render text flow + best-effort 11×5 relative halo emitted side-channel after render.

## Operator-takeaway

This preserves the robust position/visibility path while reintroducing the large halo as an additive layer. If the halo still anchors wrong, the cursor cell remains correct and visible, giving us a stable baseline for further probing of relative placement timing/IDs.
