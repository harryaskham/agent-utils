# Session summary — Slick graphics placement and redraw repair

## Goal

Close out `bd-d6530d` (Slick: read-only graphical Slack TUI) by fixing the
remaining graphical defects the operator reported: panel backgrounds drawn
offset/clipped, text sliding off screen while moving the mouse, and stale
characters left behind after clicking between views.

## Bead(s)

- `bd-d6530d` — Slick: read-only graphical Slack TUI (this session closes it).

Profile-review beads filed in `cacophony` during the same window:
`bd-63ff08`, `bd-7064aa`, `bd-637373`, `bd-bfc302`.

## Before state

Slick rendered its Kitty-graphics chrome through `ratakittui`, but:

- every non-origin pane had its `x`/`y` applied twice — once inside the
  footprint-sized PNG and again by the Kitty placement — so sidebars and
  detail panes were clipped and visibly offset;
- full-height placements advanced the terminal cursor past the bottom row,
  scrolling the alternate screen by one line, so each later Ratatui diff
  landed one row low and left previous glyphs painted;
- OSC 8 hyperlink escapes were written into Ratatui buffer symbols, where
  `unicode-width` mis-measures them and the frame diff skipped neighbouring
  cells, leaving stale text to the right of every link.

## After state

- Chrome scenes are rasterized in image-local coordinates and only the
  placement footprint stays absolute.
- Absolute placements carry Kitty `C=1`, so an image never advances the
  cursor and never scrolls the text plane.
- Scenes are uploaded/placed only when their image id or footprint changes,
  so idle repaints emit no graphics traffic.
- Link runs are collected from the rendered buffer and emitted as OSC 8 after
  the frame flush using absolute cursor moves, leaving buffer symbols exactly
  one character wide.

Validated live in Ghostty via Tendril input plus `screencapture`: nine rapid
view switches and seven real mouse clicks both left the panes aligned with no
stale glyphs, and 40 injected mouse-motion events plus 8s of idle staleness
ticks produced byte-identical panes.

## Diff summary

- `slick/src/ui.rs` — image-local chrome scenes, `C=1` injection, placement
  diffing, post-flush OSC 8 link runs, thread stack, favorites view, sidebar
  and fullscreen toggles, chat-ordered conversations.
- `slick/src/markdown.rs` — URL extraction helper, shorter horizontal rules.
- `slick/src/model.rs`, `slick/src/slack.rs` — thread cache, self-activity
  ordering for "channels you're active in", conversation backfill.
- `slick/README.md` — graphics compatibility rules and key bindings.

Landed on `main` as `2e26ccc`, `a09ceb4`, `9f780ae`, `a52e7cb`.

## Embedded artefacts

None retained; the Ghostty validation screenshots were scratch captures under
`/tmp` and were not durable enough to publish.

## Operator-takeaway

The two root causes were upstream Kittui defects, not Slick misuse: chrome
geometry double-applied the pane origin, and absolute placements omitted
`C=1`. Slick now compensates locally so it is correct today, and the matching
upstream fix is prepared for the Kittui project.
