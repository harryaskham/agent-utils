# Session summary — Box registry counts in status

## Goal

Add box chrome registry coverage counts to ordinary `/gfx status` so the main Pi graphics status readout points operators toward the newer no-render audit commands.

## Bead(s)

- `bd-5e840e` — Show Pi graphics box registry counts in status

## Before state

- Failing tests: none known.
- Relevant metrics: `/gfx box status`, `/gfx box summary`, and `/gfx box doctor` exposed box registry coverage, but ordinary `/gfx status` only showed box mode/effect settings.
- Context: The status addition needed to be read-only, bounded, and share count logic with the dedicated box commands.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 102/102; full `npm test` passed 284/284; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `boxChromeRegistryCountLine()` and reused it from box summary/status/doctor and the ordinary `/gfx status` output.

## Diff summary

- Code/content commits: `0c422a5`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`.
- Tests: extended source guards for shared registry count helper and `/gfx status` output.
- Behavioural delta: `/gfx status` now reports mapped surface and unique-effect counts with a pointer to `/gfx box status|summary`.

## Operator-takeaway

The main `/gfx status` now gives enough box registry coverage signal to decide whether to open the detailed status, compact summary, doctor, or visual preview commands.
