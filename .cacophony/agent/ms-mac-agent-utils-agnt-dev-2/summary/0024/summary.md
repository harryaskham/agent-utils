# Session summary — Keep cursor halo above editor background

## Goal

Answer/audit Harry's question about whether the cursor relative halo chain is correctly targeting the direct cursor Unicode placement, and fix the report that the 11×5 halo shows on first load but disappears after typing.

## Bead(s)

- `bd-81cfa7` — Fix cursor relative halo z-index visibility

## Before state

- Failing tests: none known.
- Relevant metrics: direct 1×1 Unicode cursor remained visible, but the additive 11×5 relative halo appeared only on first load and then disappeared after editor repaint/typing.
- Context: hardware cursor setting was suspected. Audit showed Pi graphics installs a guard that forces TUI `showHardwareCursor` false while graphics cursor styling is active, so the terminal hardware cursor is not the thing hiding the halo.

## After state

- Failing tests: none.
- Relevant metrics: `node --test test/pi-graphics.test.js test/kitty-graphics.test.js test/box-chrome.test.js` passed; `npm run docs:check` passed; `git diff --check` passed; `npm test` passed 295 tests.
- Context: the ID chain is correct: direct cursor image/placement is the virtual Unicode parent; relative halo uses a distinct image id and placement id with `P=<direct cursor image id>`, `Q=<direct cursor placement id>`, `H=-5`, `V=-2`. The likely bug was z-index: halo was at `PI_GRAPHICS_Z.BACKGROUND`, below Kitty's non-default-cell-background threshold, so editor row repaint could hide it. Halo now uses `PI_GRAPHICS_Z.BOX_CHROME`, which remains negative/under text but above non-default editor cell backgrounds.

## Diff summary

- Code/content commits: f813777.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`, `docs/kitty-graphics-protocol-audit.md`.
- Tests: updated source guard to require halo `zIndex: PI_GRAPHICS_Z.BOX_CHROME` and document why background z-index disappeared after editor repaint.
- Behavioural delta: direct cursor remains the stable visible baseline; additive relative halo should no longer be hidden by non-default editor row backgrounds after typing.

## Operator-takeaway

The parent/child IDs were wired as intended; the more plausible disappearance bug was z-index rather than hardware cursor or parent targeting. Hardware cursor is guarded off during graphics cursor mode. The halo is now drawn under text but above non-default cell backgrounds.
