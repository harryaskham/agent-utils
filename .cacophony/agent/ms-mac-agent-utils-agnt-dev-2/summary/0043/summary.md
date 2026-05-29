# Session summary — Scroll-safe editor graphics redraws

## Goal

Prevent decorative Pi editor graphics redraws from forcing terminal scrollback back to the live bottom while users are reading older output.

## Bead(s)

- `bd-356ebe` — Fix scroll behavior when editor graphics are enabled

## Before state

- Cursor heat decay and thinking-context editor graphics used `requestRender(true)`.
- In real terminal/tmux sessions, forced redraws can jump scrollback to the live bottom, making it difficult to scroll up while editor graphics are active.

## After state

- Added `requestEditorDecorativeRender()`.
- Decorative editor graphics now use non-forced/coalescible `requestRender(undefined)` by default.
- `PI_GRAPHICS_EDITOR_FORCE_REDRAW=1` restores old forced redraw behavior for diagnostics only.
- Cursor heat decay, optional thinking-context ticks, and context-mode transitions now use the scroll-safe helper.
- Documentation now calls out the scroll-safe default and diagnostic override.

## Diff summary

- Code/content commit: a5c4b3a.
- Files touched:
  - `extensions/pi-graphics.js`
  - `test/pi-graphics.test.js`
  - `docs/pi-graphics.md`

## Validation

- `node --test test/pi-graphics.test.js` — pass, 92 tests.
- `npm run docs:check` — pass.
- `git diff --check` — pass.
- `npm test` — pass, 330 tests.

## Operator-takeaway

The speed-responsive cursor glow remains enabled, but its decorative decay redraws should no longer force terminal scrollback to jump to the bottom.
