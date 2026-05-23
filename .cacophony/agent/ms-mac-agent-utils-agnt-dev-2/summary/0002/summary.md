# Session summary — Kitty cursor movement policy

## Goal

Fix the Kitty display placement cursor-movement issue from Harry's protocol audit so inline image display commands cannot move the terminal cursor and desynchronize surrounding TUI rows.

## Bead(s)

- `bd-5f9ab2` — Add C=1 to inline Kitty display placement commands

## Before state

- Failing tests: none known before implementation.
- Relevant metrics: `buildPngDisplayCommand()` emitted `a=T` display commands without `C=1`, so Kitty's default placement cursor movement policy applied.
- Context: `kitty-image-preview` can prefix direct display commands into rendered text rows when cursor placement mode is used.

## After state

- Failing tests: none.
- Relevant metrics: `node --test test/kitty-graphics.test.js` passed 24 tests; `npm test` passed 282 tests; `npm run docs:check` passed; `git diff --check` passed.
- Context: non-transmit-only display commands now include `C=1`; transmit-only uploads remain unaffected.

## Diff summary

- Code/content commits: `6ff11e2`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/kitty-graphics.js`, `test/kitty-graphics.test.js`.
- Tests: added a regression asserting cursor display commands include `C=1`.
- Behavioural delta: inline display placements no longer ask Kitty to move the terminal cursor after drawing the image rectangle.

## Operator-takeaway

The direct/cursor display path now uses Kitty's explicit no-cursor-move policy, so image preview escape sequences embedded in text rows should not shift later text unexpectedly.
