# Session summary — keep kitty uploads out of TUI lines

## Goal

Use the Pi TUI docs/source to determine what can de-draw kitty graphics on input redraws, then remove the cause from the editor graphics path.

## Bead(s)

- `bd-553242` — minimal Pi kitty graphics editor border animation refinement

## Before state

- Failing tests: none in targeted graphics validation.
- Relevant metrics: outside tmux, static/animated images disappeared as soon as typing caused the next TUI redraw; inside tmux images stayed but animation remained frozen.
- Context: Pi TUI docs say line styles are reset at line end; source inspection showed a more important graphics-specific behavior: the TUI scans rendered lines for raw kitty `ESC_G` image uploads and deletes collected image ids when those lines change.

## After state

- Failing tests: none in targeted graphics validation.
- Relevant metrics: `node --test test/kitty-graphics.test.js test/pi-graphics.test.js` passes 93/93.
- Context: Editor border/rail render lines now contain only Unicode placeholder cells. The raw kitty upload command is written out-of-band via `ctx.ui.write`, so Pi's differential renderer no longer records the image id in `previousLines` and therefore should not delete it on the next redraw.

## Diff summary

- Code/content commits: `1ef9683`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/pi-graphics.js`
- Tests: targeted graphics suite still 93/93 passing
- Behavioural delta: The first render still uploads the static/animated image once, but the rendered TUI line is now just placeholder SGR + placeholder cells, avoiding Pi TUI's kitty-image cleanup mechanism.

## Operator-takeaway

The disappearing-on-typing bug was likely self-inflicted by embedding raw kitty upload escapes in rendered lines; Pi TUI treats those as managed image lines and deletes their ids on changed-line redraws.
