# Session summary — Archive compaction Pi graphics chrome

## Goal

Continue differentiating Pi graphics surfaces by giving compaction summaries an archive/stack visual language instead of sharing the accordion fold motif.

## Bead(s)

- `bd-8f4ce1` — Add efficient archive Pi graphics compaction chrome

## Before state

- Failing tests: none known.
- Relevant metrics: `compaction` mapped to `fold`; fold remained useful as an explicit variant, but compaction summaries could better communicate stored/compressed context.
- Context: The new effect needed deterministic sparse geometry: stack bands, archive tabs, and binder ticks, with no timers, dense textures, masks, glyph dependencies, or repaint loops.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics/box-chrome.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 100/100; full `npm test` passed 279/279; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `archive` to the effect registry and mapped `compaction` to `archive`; `fold` remains an explicit effect variant.

## Diff summary

- Code/content commits: `121c954`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics/box-chrome.js`, `test/box-chrome.test.js`, `docs/pi-graphics.md`.
- Tests: extended effect-distinctness coverage to include `archive`.
- Behavioural delta: Compaction summaries now render compressed stack bands, archive tabs, and binder ticks; fold remains available but no longer owns compaction by default.

## Operator-takeaway

Compaction chrome now looks like context being stored away, not just folded, while still using deterministic cached strip artwork.
