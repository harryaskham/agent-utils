# Session summary — Keep cursor anchor 1×1 and order H/V before guards

## Goal

Fix the still-misplaced Pi graphics glow cursor without changing the cursor anchor into a multi-cell virtual placement. Harry correctly clarified that the transparent virtual placement should remain a 1×1 anchor at the cursor; the larger glow image should be centered relative to that anchor.

## Bead(s)

- `bd-1edcf5` — Fix cursor glow centering with multi-cell Unicode anchor
  - Note: implementation corrected course from the bead title. The final fix keeps the anchor 1×1.

## Before state

- Failing tests: none known.
- Relevant metrics: previous live attempts still rendered the 11×5 glow with top-left at the cursor. A bad in-progress idea briefly changed the anchor to 11×5; that was reverted before commit.
- Context: Kitty protocol docs confirm `H`/`V` on relative placements are terminal-cell offsets, not pixels. A 1×1 transparent Unicode parent at the cursor plus `H=-5,V=-2` is the right model for an 11×5 glow.

## After state

- Failing tests: none.
- Relevant metrics: `node --test test/pi-graphics.test.js test/kitty-graphics.test.js test/box-chrome.test.js` passed; `npm run docs:check` passed; `git diff --check` passed; `npm test` passed 294 tests.
- Context: the live cursor path is restored to a 1×1 transparent anchor and 11×5 relative child with `H=-5,V=-2`. `buildRelativePlacementCommand()` now serializes semantic `H`/`V` before generic `C`/`q` guard flags, matching the most conservative live/debug command shape.

## Diff summary

- Code/content commits: b3a2293.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/kitty-graphics.js`, `extensions/pi-graphics.js`, `docs/pi-graphics.md`, `docs/kitty-graphics-protocol-audit.md`, `test/kitty-graphics.test.js`, `test/pi-graphics.test.js`, `test/box-chrome.test.js`.
- Tests: updated relative-placement test to expect `H=-5,V=-2` before `C=1,q=2`; restored source guards for one-cell anchor cell offsets; corrected box/docs wording away from pixel offsets.
- Behavioural delta: no 11×5 virtual parent. Cursor anchor remains 1×1. Centering uses Kitty cell offsets. Only serialization order changed to avoid any live parser/tmux ambiguity around late H/V keys.

## Operator-takeaway

Harry was right: the anchor must remain 1×1. The prior pixel-offset diagnosis was wrong according to the actual Kitty spec. The plausible remaining cause for H/V being ignored was command-shape/order or live parsing ambiguity, so H/V now appear before C/q in relative placement commands.
