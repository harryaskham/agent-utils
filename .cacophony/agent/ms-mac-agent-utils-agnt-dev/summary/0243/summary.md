# Session summary — Cursor relative placement ordering

## Goal

Fix the cursor glow relative-placement runtime behavior in plain Kitty. Harry clarified the issue is not tmux passthrough: the 11x5 glow still appears as if its top-left is on the Unicode placeholder cursor, so relative offsets are not visually taking effect.

## Bead(s)

- `bd-74247e` — Emit Pi cursor relative placement before anchor placeholder

## Before state

- Failing tests: none known.
- Relevant metrics: focused Pi/Kitty graphics tests and full `npm test` were passing.
- Context: command serialization was verified to be a relative placement (`a=p` with `P/Q/H/V`), and the failed empirical offset compensation had already been reverted. The live cursor path still returned the anchor placeholder text followed by the relative placement command in the same rendered line.

## After state

- Failing tests: none observed in focused validation.
- Relevant metrics: `node --check extensions/pi-graphics.js`; `node --test test/pi-graphics.test.js test/kitty-graphics.test.js` passed 112/112.
- Context: the live cursor now emits the child relative placement command before returning the anchor placeholder line, matching box chrome's working ordering. `/gfx cursor preview` similarly places the relative command before the visible label/anchor text.

## Diff summary

- Code/content commit: `01437a1`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`.
- Behavioural delta: relative placement setup is no longer appended after the anchor placeholder text. This should let Kitty apply parent-relative H/V offsets before the anchor text is interpreted as the visible parent location.

## Operator-takeaway

This is no longer treated as a passthrough issue. The command is relative, but the likely bug was emission order: cursor used anchor-then-relative while box chrome used relative-before-anchor. The cursor path now follows the box chrome ordering.
