# Session summary — Cursor audit index command

## Goal

Add a read-only `/gfx cursor audit` index so operators can quickly see which cursor diagnostic or recovery command answers each question and whether it renders graphics or mutates state.

## Bead(s)

- `bd-2cf6cb` — Add Pi graphics cursor audit index command

## Before state

- Failing tests: none known.
- Relevant metrics: cursor commands existed for status, doctor, preview, clear, and debug, but there was no compact command index equivalent to the box audit ladder.
- Context: The command needed to be bounded, read-only, and non-mutating, with preview and clear clearly called out as the graphical/recovery paths.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 102/102; full `npm test` passed 285/285; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `cursorAuditLines()` and routed `/gfx cursor audit`, `/gfx cursor audits`, `/gfx cursor index`, `/gfx cursor commands`, and `/gfx cursor-audit`.

## Diff summary

- Code/content commits: `a929e27`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`.
- Tests: added source guards for cursor audit helper, aliases, no-render output, and settings overlay mention.
- Behavioural delta: Operators now have a no-render map of cursor status, doctor, preview, clear, and debug workflows.

## Operator-takeaway

Use `/gfx cursor audit` as the cursor command index; it explains when to use status, doctor, preview, clear, or debug diagnostics.
