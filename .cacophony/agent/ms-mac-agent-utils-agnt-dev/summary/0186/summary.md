# Session summary — Scrim overlay Pi graphics chrome

## Goal

Continue differentiating Pi graphics surfaces by giving overlay/modal rows a dedicated scrim motif instead of sharing the frost effect.

## Bead(s)

- `bd-b22f9f` — Add efficient scrim Pi graphics overlay chrome

## Before state

- Failing tests: none known.
- Relevant metrics: overlay surfaces mapped to `frost`, a cold crystal/glint motif that remained useful but was less directly modal/scrim-like.
- Context: The new effect needed deterministic sparse rectangle drawing, cached strip reuse, and no timers, animation loops, dense textures, masks, glyph dependencies, graph layout, broad opacity fields, or repaint loops.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics/box-chrome.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 100/100; full `npm test` passed 279/279; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `scrim` to the effect registry and mapped `overlay` to `scrim`; `frost` remains an explicit cold-overlay variant.

## Diff summary

- Code/content commits: `48c6051`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics/box-chrome.js`, `test/box-chrome.test.js`, `docs/pi-graphics.md`.
- Tests: extended effect-distinctness coverage to include `scrim`.
- Behavioural delta: Overlay chrome now renders sparse dimmer curtains, focus brackets, and modal edge ticks while retaining `frost` as a selectable variant.

## Operator-takeaway

Overlay surfaces now read as modal scrims rather than cold/frosted panels, while keeping the same static deterministic cached kitty strip path.
