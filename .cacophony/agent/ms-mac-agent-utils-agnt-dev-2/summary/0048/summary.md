# Session summary — Reduce Pi graphics tmux keypress redraw flicker

## Goal

Reduce extreme full-screen redraw/flicker on keypress when Pi editor graphics are enabled inside tmux, while preserving static rails/box chrome and opt-in live dynamics.

## Bead(s)

- `bd-8a327b` — Reduce Pi graphics tmux keypress redraw flicker

## Diagnosis

The live editor path was still updating typing heat/impulse state and scheduling decorative redraws. In tmux, even coalescible editor redraws can cause visible full-screen flicker when Unicode placeholder text/graphics keys change on every keypress.

## Changes

- Added `runningInsideTmux()` detection.
- Added `editorLiveDynamicsEnabled()`.
  - Honors `PI_GRAPHICS_EDITOR_DYNAMIC=0` globally.
  - Disables live editor dynamics inside tmux by default.
  - `PI_GRAPHICS_EDITOR_DYNAMIC_IN_TMUX=1` opts back into the old live dynamics in tmux for diagnostics/preferred setups.
- `requestEditorHeatFrame()` and thinking-context frame ticks now no-op when live dynamics are disabled.
- `updateEditorTypingHeat()` now returns stable zero heat and clears impulse state when live dynamics are disabled, avoiding per-key changing editor border/cursor heat keys.
- `editorRailHeat()` returns zero when live dynamics are disabled.
- Docs now describe the tmux-safe default and opt-in escape hatch.
- Source guards updated for the tmux dynamics gate.

## Validation

- `node --test test/pi-graphics.test.js` — pass, 92 tests.
- `npm run docs:check` — pass.
- `git diff --check` — pass.
- `npm test` — pass, 332 tests.

## Operator-takeaway

Inside tmux, static Pi graphics rails/box chrome stay available, but typing heat/impulse animations are disabled by default to avoid keypress flicker. If you want the old live heat behavior in tmux, set `PI_GRAPHICS_EDITOR_DYNAMIC_IN_TMUX=1` and reload.
