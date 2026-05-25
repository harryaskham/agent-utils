# Session summary — Defer cursor relative placement until anchor exists

## Goal

Deeply audit why the 11×5 cursor glow still appears at +5,+2 after restoring the scroll regression fix. The desired placement is still H=-5,V=-2 relative to the transparent Unicode cursor anchor.

## Bead(s)

- `bd-f7e209` — Defer Pi cursor relative placement until after anchor render

## Before state

- Failing tests: none known.
- Relevant metrics: live cursor graphics were enabled and no longer catastrophically replicated lines after `C=1` was restored, but the glow still appeared with its top-left at the cursor anchor, as if H=-5,V=-2 were ignored.
- Context: inline APC after the placeholder had already proven unsafe for Pi's TUI render string. Immediate side-channel placement, however, runs while the editor line is still being rendered, before the TUI has physically written the transparent Unicode placeholder. That gives Kitty no concrete parent cell yet for the virtual placement.

## After state

- Failing tests: none.
- Relevant metrics: `node --test test/pi-graphics.test.js test/kitty-graphics.test.js` passed; `npm run docs:check` passed; `git diff --check` passed; `npm test` passed 289 tests.
- Context: live cursor relative placement stays out of editor text, but is deferred with a zero-delay timer so the current TUI render/write turn can publish the transparent placeholder before Kitty resolves the child relative placement. The command still carries C=1 and H=-5,V=-2.

## Diff summary

- Code/content commits: dcf180a.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`.
- Tests: updated source guards for deferred side-channel cursor placement and the anchor-written-before-relative rationale.
- Behavioural delta: live cursor graphics remain enabled; no raw APC is embedded in editor text; the relative command should now run after the anchor placeholder has a physical cell so H/V can take effect.

## Operator-takeaway

The likely failure was timing, not offset math: the relative placement was created before Kitty could derive the virtual parent position from the Unicode placeholder. The fix is delayed side-channel placement, not disabling the cursor or embedding APC inline.
