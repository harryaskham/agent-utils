# Session summary — Anchor-relative cursor preview

## Goal

Make `/gfx cursor preview` exercise the same transparent-anchor plus relative-placement path as the live graphical cursor, so centering regressions are visible without typing in the editor.

## Bead(s)

- `bd-47cbb2` — Make Pi graphics cursor preview exercise anchor-relative placement

## Before state

- Failing tests: none known.
- Relevant metrics: `/gfx cursor preview` displayed direct virtual-placement PNG variants and diagnostics, but it did not render a sample through the live cursor's anchor-relative positioning path.
- Context: The change needed to remain bounded and avoid mutating live editor cursor placement state while still making anchor centering inspectable.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 102/102; full `npm test` passed 284/284; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `buildAnchoredEditorCursorPreviewLine()` using preview-scoped anchor/image/placement ids and the same -5,-2 relative offsets. `/gfx cursor preview` now shows an anchored sample before the cool/warm/hot static variants.

## Diff summary

- Code/content commits: `d745b30`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`.
- Tests: added source guards requiring the anchored preview helper, preview-scoped anchor ids, relative placement ids, and preview invocation.
- Behavioural delta: Cursor preview now includes a bounded anchor-relative sample while leaving the live editor cursor state untouched.

## Operator-takeaway

The cursor preview now tests the same centering mechanism used by the live cursor, making future anchor-placement drift easier to catch visually.
