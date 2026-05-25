# Session summary — Restore relative-placement C guard

## Goal

Fix the persistent live editor regression without hiding the cursor graphics behind a new off-by-default flag. Harry clarified that the cursor glow worked before the 11×5 fix and the regression should be fixed at the Kitty graphics helper level.

## Bead(s)

- `bd-8c38cb` — Restore C=1 for Kitty relative placements after cursor regression

## Before state

- Failing tests: none known.
- Relevant metrics: live typing still replicated the input line and scrolled the TUI after moving the relative placement back out of inline editor text. The remaining behavioral delta from the pre-regression working path was that `buildRelativePlacementCommand()` no longer emitted `C=1`.
- Context: while the Kitty protocol says relative placements should not move the cursor regardless of `C`, live Pi/tmux behavior indicated that omitting the defensive cursor-suppression key disturbed TUI cursor/scroll state.

## After state

- Failing tests: none.
- Relevant metrics: `node --test test/kitty-graphics.test.js test/pi-graphics.test.js` passed; `npm run docs:check` passed; `git diff --check` passed; `npm test` passed 289 tests.
- Context: `buildRelativePlacementCommand()` once again emits `C=1` while preserving `H=-5,V=-2` offsets. No new cursor-gfx opt-out was added; live cursor graphics remain enabled by default as before.

## Diff summary

- Code/content commits: ce78698.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/kitty-graphics.js`, `test/kitty-graphics.test.js`, `docs/kitty-graphics-protocol-audit.md`.
- Tests: updated relative-placement serialization test to require `C=1` as a defensive no-cursor-movement guard.
- Behavioural delta: relative placements regain the same cursor-movement suppression guard they had before the 11×5 cursor fix, which should address the scroll/input-line replication regression without disabling the cursor glow.

## Operator-takeaway

Do not hide the cursor effect. The regression is most likely the missing `C=1` guard on relative placements in live Pi/tmux, despite the protocol saying it should not be necessary.
