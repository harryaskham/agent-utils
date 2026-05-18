# Session summary — Pi graphics ambient proof strip

## Goal

Harry repeated that Pi kitty graphics still did not look visibly different enough in the live terminal. This slice adds a compact default fallback visual proof strip so the extension produces an unmistakable truecolor signal even if kitty image placement, theme activation, or package reload is the weak link.

## Bead(s)

- `bd-c767aa` — Add Pi graphics fallback proof strip and visual smoke validation

## Before state

- Failing tests: none at start of this slice.
- Relevant metrics: targeted Pi graphics + kitty graphics suite passed 80/80 after the rendered TUI surface scene work.
- Context: calm mode had a PNG/APNG rendered TUI surface, but if the operator could not see kitty placeholder output or if theme reload was stale, there was no tiny always-visible terminal-level proof comparable to Cacophony's visual smoke diagnostics.

## After state

- Failing tests: none in targeted validation.
- Relevant metrics: `npm test -- test/pi-graphics.test.js test/kitty-graphics.test.js` passes 81/81.
- Context: calm mode now includes `PI_GRAPHICS_AUTO_AMBIENT_PROOF` default-on. It writes a bounded three-line truecolor ANSI proof strip with a deep Nordic gradient, `TS RGBA→KITTY/APNG` label, rendered TUI surface dimensions, PNG bytes, color bucket count, luma delta, and reload sentinel. The proof is also available through `/pi-graphics-ambient-proof` and `pi_graphics_ambient_proof`, and can be disabled with `PI_GRAPHICS_AUTO_AMBIENT_PROOF=0`.

## Diff summary

- Code/content commits: `8392d38`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/pi-graphics/auto-widget.js`, `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`
- Tests: added ambient proof default/opt-out checks, truecolor ANSI escape checks, rendered-metric regex checks, and source wiring checks for command/tool exposure.
- Behavioural delta: Pi graphics mode should now be visibly different even in terminals where image placement is unavailable, because the fallback proof uses raw truecolor ANSI output plus renderer-derived metrics.
- Validation: syntax checks for modified JS modules, `git diff --check`, and targeted tests passed.

## Operator-takeaway

This adds a small but hard-to-miss diagnostic bridge: if Harry still sees no difference after reload, the proof strip should reveal whether the extension is loading at all. If it appears but the richer APNG scene does not, the next bug is specifically kitty placeholder delivery rather than theme color or renderer generation.
