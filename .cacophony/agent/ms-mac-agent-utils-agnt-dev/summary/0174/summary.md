# Session summary — Sigil skill Pi graphics chrome

## Goal

Continue differentiating Pi graphics surfaces by giving skill/capability panels a sigil/seal motif instead of sharing the rune effect.

## Bead(s)

- `bd-fad4f3` — Add efficient sigil Pi graphics skill chrome

## Before state

- Failing tests: none known.
- Relevant metrics: skill surfaces mapped to `rune`, a compact rect-sigil motif that remained useful but was less explicitly tied to capabilities/invocation surfaces.
- Context: The new effect needed deterministic sparse rectangle drawing, cached strip reuse, and no timers, dense textures, masks, glyph dependencies, graph layout, or repaint loops.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics/box-chrome.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 100/100; full `npm test` passed 279/279; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `sigil` to the effect registry and mapped `skill` to `sigil`; `rune` remains an explicit compact-rune variant.

## Diff summary

- Code/content commits: `36066b7`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics/box-chrome.js`, `test/box-chrome.test.js`, `docs/pi-graphics.md`.
- Tests: extended effect-distinctness coverage to include `sigil`.
- Behavioural delta: Skill chrome now renders sparse rune-like seals, binding ticks, and invocation marks while retaining `rune` as a selectable variant.

## Operator-takeaway

Skill surfaces now look like explicit capability invocations rather than generic rune decoration, while staying deterministic and glyph-free.
