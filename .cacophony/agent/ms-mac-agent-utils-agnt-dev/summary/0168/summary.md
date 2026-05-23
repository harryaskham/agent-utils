# Session summary — Bevel border Pi graphics chrome

## Goal

Continue differentiating Pi graphics surfaces by giving generic border surfaces a raised bevel motif instead of sharing the chamfer effect.

## Bead(s)

- `bd-2564e7` — Add efficient bevel Pi graphics border chrome

## Before state

- Failing tests: none known.
- Relevant metrics: generic border surfaces mapped to `chamfer`, a cut-corner motif that remained useful but gave the border surface less depth than a dedicated bevel treatment.
- Context: The new effect needed to stay deterministic, cached, low-entropy, rectangle-only, and avoid timers, dense textures, masks, glyph dependencies, or repaint loops.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics/box-chrome.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 100/100; full `npm test` passed 279/279; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `bevel` to the effect registry and mapped `border` to `bevel`; `chamfer` remains an explicit variant.

## Diff summary

- Code/content commits: `5d7b801`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics/box-chrome.js`, `test/box-chrome.test.js`, `docs/pi-graphics.md`.
- Tests: extended effect-distinctness coverage to include `bevel`.
- Behavioural delta: Generic border chrome now renders sparse bevel planes, clipped-corner highlights, and shadow seams while retaining `chamfer` as a selectable cut-corner variant.

## Operator-takeaway

Generic Pi graphics borders now read more like raised UI edges, improving surface separation without changing the cached kitty strip architecture.
