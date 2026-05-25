# Session summary — Revert inline cursor APC regression

## Goal

Fix the major regression Harry reported after the cursor relative-placement change: typing replicated the input line and scrolled the rest of the TUI off screen.

## Bead(s)

- `bd-b7d96b` — Revert inline cursor relative placement scroll regression

## Before state

- Failing tests: none known.
- Relevant metrics: previous fix emitted raw Kitty APC relative-placement escapes inline in the editor line after the Unicode placeholder. Harry observed live input-line duplication and TUI scrolling, consistent with Pi's TUI width/diffing path seeing raw escape content inside the rendered editor string.
- Context: the safe part of the prior fix is still valid: Kitty relative placements should not emit `C`, and the command still carries H=-5,V=-2.

## After state

- Failing tests: none.
- Relevant metrics: `node --test test/pi-graphics.test.js test/kitty-graphics.test.js` passed; `npm run docs:check` passed; `git diff --check` passed; `npm test` passed 289 tests.
- Context: the live cursor path again returns only the one-cell anchor placeholder in rendered editor text, and emits the relative placement through the graphics side-channel. This keeps raw APC out of the editor string and should stop line replication/scrolling while preserving `C` omission in the Kitty helper.

## Diff summary

- Code/content commits: f881323.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`.
- Tests: updated source guards to assert side-channel emission and no inline anchor+APC live cursor return.
- Behavioural delta: live editor text no longer contains raw Kitty APC; cursor glow relative placement is still emitted with H=-5,V=-2 and no `C` from the Kitty helper.

## Operator-takeaway

The immediate regression is fixed by keeping APC escapes out of rendered editor text. If centering is still wrong, the remaining fix must happen in side-channel timing/Kitty semantics, not by embedding raw APC in the TUI line.
