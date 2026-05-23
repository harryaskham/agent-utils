# Session summary — Terminal bash Pi graphics chrome

## Goal

Continue differentiating Pi graphics surfaces by giving bash/command-output rows a dedicated terminal motif instead of sharing the broader prompt effect.

## Bead(s)

- `bd-ee0e75` — Add efficient terminal Pi graphics bash chrome

## Before state

- Failing tests: none known.
- Relevant metrics: bash surfaces mapped to `prompt`, a shell-rail/cursor motif that remained useful but was less explicit about command output surfaces.
- Context: The new effect needed deterministic sparse rectangle drawing, cached strip reuse, and no timers, animation loops, dense textures, masks, glyph dependencies, graph layout, blinking cursors, or repaint loops.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics/box-chrome.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 100/100; full `npm test` passed 279/279; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `terminal` to the effect registry and mapped `bash` to `terminal`; `prompt` remains an explicit shell-prompt variant.

## Diff summary

- Code/content commits: `5cffa74`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics/box-chrome.js`, `test/box-chrome.test.js`, `docs/pi-graphics.md`.
- Tests: extended effect-distinctness coverage to include `terminal`.
- Behavioural delta: Bash chrome now renders sparse command rails, cursor blocks, and shell ticks while retaining `prompt` as a selectable variant.

## Operator-takeaway

Bash surfaces now read as command-output terminals rather than generic prompt strips, using deterministic cached kitty chrome with no live cursor or repaint behavior.
