# Session summary — Box effects audit command

## Goal

Add a read-only `/gfx box effects` audit so operators can see all selectable box chrome effects, which are currently mapped to surfaces, and which remain explicit variants without rendering preview graphics.

## Bead(s)

- `bd-cd6072` — Add Pi graphics box effects audit command

## Before state

- Failing tests: none known.
- Relevant metrics: `/gfx box status`, `/gfx box summary`, and `/gfx box doctor` exposed mapped surface coverage, but none listed all `BOX_EFFECT_NAMES` or separated mapped effects from explicit selectable variants.
- Context: The new command needed to stay bounded, no-render, and non-mutating while complementing the existing status/summary/doctor/preview ladder.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 102/102; full `npm test` passed 284/284; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `boxChromeEffectsLines()` and routed `/gfx box effects`, `/gfx box variants`, `/gfx box effect-list`, and `/gfx box-effects` to the audit output.

## Diff summary

- Code/content commits: `47af3f2`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`.
- Tests: extended source guards for the effects audit helper, aliases, doctor guidance, and settings overlay text.
- Behavioural delta: The box chrome audit ladder now includes total effect counts plus mapped-vs-explicit effect variant lists without emitting graphics.

## Operator-takeaway

Use `/gfx box effects` when you want to audit the available visual vocabulary itself; use status/summary for surface mappings and preview only when visual rendering is useful.
