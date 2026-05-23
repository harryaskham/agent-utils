# Session summary — Rig tool-call Pi graphics chrome

## Goal

Continue differentiating Pi graphics surfaces by giving tool-call rows a dedicated rig/machinery motif instead of sharing the broader schematic effect.

## Bead(s)

- `bd-9a0190` — Add efficient rig Pi graphics tool chrome

## Before state

- Failing tests: none known.
- Relevant metrics: tool surfaces mapped to `schematic`, a circuit/bus-trace motif that remained useful but was less active/tool-execution specific.
- Context: The new effect needed deterministic sparse rectangle drawing, cached strip reuse, and no timers, animation loops, dense textures, masks, glyph dependencies, graph layout, SVG widgets, or repaint loops.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics/box-chrome.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 100/100; full `npm test` passed 279/279; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `rig` to the effect registry and mapped `tool` to `rig`; `schematic` remains an explicit tool-schematic variant.

## Diff summary

- Code/content commits: `86ea4c1`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics/box-chrome.js`, `test/box-chrome.test.js`, `docs/pi-graphics.md`.
- Tests: extended effect-distinctness coverage to include `rig`.
- Behavioural delta: Tool-call chrome now renders sparse harness rails, output sockets, and execution bolts while retaining `schematic` as a selectable variant.

## Operator-takeaway

Tool output now reads as active rigged machinery rather than a passive schematic, while staying deterministic and cached with no live graph/widget rendering.
