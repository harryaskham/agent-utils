# Session summary — Tile widget Pi graphics chrome

## Goal

Continue differentiating Pi graphics surfaces by giving widget/status surfaces a sparse dashboard-tile motif instead of sharing the mosaic effect.

## Bead(s)

- `bd-6cb916` — Add efficient tile Pi graphics widget chrome

## Before state

- Failing tests: none known.
- Relevant metrics: widget surfaces mapped to `mosaic`, a sparse offset-tile motif that remained useful but was less like a dashboard/status panel.
- Context: The new effect needed to be deterministic, cached, rectangle-only, low entropy, and avoid timers, dense textures, masks, glyph dependencies, or repaint loops.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics/box-chrome.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 100/100; full `npm test` passed 279/279; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `tile` to the effect registry and mapped `widget` to `tile`; `mosaic` remains an explicit variant.

## Diff summary

- Code/content commits: `a341a54`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics/box-chrome.js`, `test/box-chrome.test.js`, `docs/pi-graphics.md`.
- Tests: extended effect-distinctness coverage to include `tile`.
- Behavioural delta: Widget chrome now renders sparse dashboard panes, corner pins, and small separators; mosaic is still selectable as an explicit assembled-tile variant.

## Operator-takeaway

Widget/status surfaces now read more like compact UI dashboards, improving visual separation from the older mosaic variant while keeping rendering cheap and cached.
