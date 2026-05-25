# Session summary — Cursor relative placement ordering

## Goal

Fix Harry's report that the 11×5 Pi graphics cursor glow is badly offset because the relative-placement offsets are not being applied. The intended geometry is centered on the one-cell cursor anchor with H=-5,V=-2.

## Bead(s)

- `bd-f12d16` — Fix Kitty relative placement offsets for Pi cursor glow

## Before state

- Failing tests: none known.
- Relevant metrics: the cursor code computed the right 11×5 geometry and H=-5,V=-2, but emitted the child relative placement out-of-band before the TUI printed the Unicode placeholder anchor. The Kitty helper also emitted `C=1` on relative placements even though the protocol says relative placements never move the cursor regardless of C.
- Context: in live use the glow appeared with its top-left at/near the cursor rather than centered, indicating the relative H/V was not resolving against the physical placeholder cell.

## After state

- Failing tests: none.
- Relevant metrics: `node --test test/kitty-graphics.test.js test/pi-graphics.test.js` passed 112 focused graphics tests; `npm run docs:check` passed; `git diff --check` passed; `npm test` passed 288 tests.
- Context: live and preview cursor paths now append the relative placement escape inline immediately after the anchor placeholder text, so Kitty sees the physical placeholder before resolving H/V. `buildRelativePlacementCommand()` no longer emits `C` for relative placements.

## Diff summary

- Code/content commits: f26266b.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/kitty-graphics.js`, `extensions/pi-graphics.js`, `test/kitty-graphics.test.js`, `test/pi-graphics.test.js`, `docs/kitty-graphics-protocol-audit.md`.
- Tests: updated Kitty relative-placement serialization coverage and Pi source guards for inline anchor-then-relative cursor ordering.
- Behavioural delta: cursor glow placement should resolve as a real relative placement centered at H=-5,V=-2 instead of racing the TUI frame write and appearing offset.

## Operator-takeaway

The math was already right; the bug was command semantics/timing. Relative placements are now minimal protocol commands and are emitted after the anchor placeholder that gives Kitty the physical parent position.
