# Session summary — Facet input Pi graphics chrome

## Goal

Continue differentiating Pi graphics surfaces by giving input fields a focused facet/glass-control motif instead of sharing the prism effect.

## Bead(s)

- `bd-36a9da` — Add efficient facet Pi graphics input chrome

## Before state

- Failing tests: none known.
- Relevant metrics: input surfaces mapped to `prism`, a diagonal glass motif that remained useful but was broader than input/editable controls.
- Context: The new effect needed deterministic sparse rectangle drawing, cached strip reuse, and no timers, dense textures, masks, glyph dependencies, graph layout, or repaint loops.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics/box-chrome.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 100/100; full `npm test` passed 279/279; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `facet` to the effect registry and mapped `input` to `facet`; `prism` remains an explicit glass-facet variant.

## Diff summary

- Code/content commits: `c9e8499`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics/box-chrome.js`, `test/box-chrome.test.js`, `docs/pi-graphics.md`.
- Tests: extended effect-distinctness coverage to include `facet`.
- Behavioural delta: Input chrome now renders sparse angled facets, entry glints, and prompt guide cuts while retaining `prism` as a selectable variant.

## Operator-takeaway

Input fields now have a dedicated focused-glass control language that avoids dense diagonal shader work and keeps the existing cached strip architecture.
