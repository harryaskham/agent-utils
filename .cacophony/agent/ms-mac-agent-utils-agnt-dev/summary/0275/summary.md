# Session summary — tmux editor flicker guard

## Goal

User reported that enabling Pi graphics inside tmux causes extreme flicker/full-screen redraws on every keypress, likely because tmux sees live Unicode placeholder text changing in the editor.

## Bead(s)

- `bd-081ce7` — Reduce Pi graphics tmux keypress redraw flicker

## Work completed

- Added tmux detection via `TMUX` and a new opt-in escape hatch:
  - `PI_GRAPHICS_TMUX_LIVE_EDITOR=1`
- By default when running inside tmux, Pi graphics now disables live in-editor dynamic paths that churn text/placeholder rows on keypress:
  - graphical cursor replacement in the input row
  - trailing workspace placeholder fill
  - editor row background relative placement
  - typing heat updates and heat fade redraw timers
  - thinking-mode repeated TUI redraw timer when not using uploaded animation frames
- Static/non-keypress graphics remain enabled:
  - editor rails/borders
  - box chrome and box rails
  - footer/status surfaces
  - Kitty frame-command animations
- Editor border rendering freezes typing heat/impulse cache-key variation in tmux by default, preventing new editor rail image ids and placeholder rows from being generated on each keypress.
- Resolved a rebase conflict with main's newer decorative-render and typing-impulse gates by preserving both: tmux dynamic editor graphics are gated, and decorative redraws remain non-forced / opt-in.
- Updated docs and source-invariant tests.

## Validation

- `node --check extensions/pi-graphics.js`
- `node --test test/pi-graphics.test.js` — 92/92 pass
- `npm run docs:check` — pass
- `git diff --check` — pass

## Commits

- `e8dfe06` / `44dabe9` before reintegration (squashed by direct reintegration).
