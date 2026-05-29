# Session summary — Avoid static thinking animation redraw ticks

## Goal

Reduce redundant Kitty/Pi redraws during animation-style ticks in tmux. The main live offender in the current code was contextual thinking rail animation when editor animation was off: it repeatedly requested full TUI redraws just to advance decorative thought-bubble masks.

## Bead(s)

- `bd-fc8986` — Eliminate redundant Kitty graphics redraws during animation ticks in tmux

## Before state

- Manual Kitty frame animation already used `a=a,c=<frame>` without redrawing Unicode placeholders.
- However, when editor animation was disabled, thinking-context rail masks still used `requestEditorContextFrame()` to schedule repeated `editorRenderTui.requestRender(true)` calls.
- Those ticks could redraw text/Unicode placeholders even though no characters had moved.

## After state

- Contextual thinking redraw ticks are disabled by default.
- If `editor.animation` is enabled, pre-rendered Kitty frames continue to be advanced via `ensureManualAnimationLoop` and protocol `a=a,c=<frame>`.
- If `editor.animation` is disabled, thinking-context rail masks remain static until real editor/TUI state changes.
- Added opt-in diagnostic/env escape hatch: `PI_GRAPHICS_EDITOR_CONTEXT_REDRAW=1` restores the old repeated full-redraw context tick behavior for comparison/testing.

## Diff summary

- Code/content commit: 780b6e8.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`.
- Tests updated: source guards assert `PI_GRAPHICS_EDITOR_CONTEXT_REDRAW`, the no-redraw default guard, and the comment documenting that pre-rendered frames are advanced via `a=a,c=<frame>`.

## Validation

- `node --test test/pi-graphics.test.js` — pass, 91 tests.
- `npm run docs:check` — pass.
- `git diff --check` — pass.
- `npm test` — pass, 329 tests.

## Operator-takeaway

Decorative thinking-context ticks should no longer force full editor/TUI redraws by default. Use actual editor animation for moving rails; static mode stays static unless text/state changes.
