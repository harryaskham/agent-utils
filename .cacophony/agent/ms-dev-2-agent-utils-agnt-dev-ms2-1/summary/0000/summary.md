# Summary — bd-f3a1e9

## Goal
Eliminate a stray left-to-right horizontal gradient strip that appeared on the
editor / its railings even with box and editor-background graphics off, and
redraw the footer background per operator (Harry) direction as a 1x1 unicode
underlay.

## Bead(s)
- bd-f3a1e9 — Redraw pi-graphics footer background as a 1x1 unicode underlay
  (kill stray horizontal gradient). P2 task. Operator-directed.

## Before state
- The footer segment background (`ensureFooterSegmentBackground` in
  `extensions/pi-graphics.js`) rendered a left-to-right horizontal glow gradient
  (`renderPromptEnclosure`, accent -> editorBg) as a **relative placement**
  anchored to each footer divider cell at `PI_GRAPHICS_Z.BACKGROUND` with
  `hOffset: FOOTER_DIVIDER_WIDTH`.
- Relative-placement keys were cached in `relativeUploaded` and only cleared on a
  full reset. On footer relayout/resize the BACKGROUND-z horizontal gradient
  could persist or re-anchor against a stale/moved divider and detach onto the
  editor row or rails — the stray gradient Harry observed. It was the only live
  horizontal gradient in the plugin under his settings (status-indicator,
  trailing-workspace, and row-background horizontal gradients were all gated off;
  the actual editor borders use a different vertical/stroke renderer).

## After state
- New `renderFooterUnderlay` in `extensions/pi-graphics/affordances.js`: a
  full-width 1-row image with a solid hline along the BOTTOM edge and a mild glow
  radiating UPWARD (fading to alpha 0 at the top) — like a gentle 1-row editor
  top border, but milder (lower glow alpha, thin stroke, no horizontal gradient).
  Nord defaults: lightest dark base (`editorBg` #101729) glow fading out, nord
  deep-blue (`borderAccent` #5e81ac) hline.
- New `buildFooterUnderlayCell(width)` in `extensions/pi-graphics.js` draws this
  as a single 1x1 unicode placeholder whose image is transmitted at full terminal
  width (placement `c` = full width, `z = PI_GRAPHICS_Z.BACKGROUND`), so it spills
  under the entire footer line with no relative-placement shenanigans.
- `buildSegmentedFooterLine` now prepends the 1-cell underlay marker (LHS gains
  one column), lays out footer text into `width - 2` columns, and appends one
  trailing space on the RHS so the line ends `provider/model<space>` and fills the
  terminal width exactly.
- Removed the now-unused `ensureFooterSegmentBackground` and its relative
  footer-bg placement entirely.

## Diff summary
- `extensions/pi-graphics/affordances.js` (+52): add exported `renderFooterUnderlay`.
- `extensions/pi-graphics.js` (~124): import `renderFooterUnderlay`; remove
  `ensureFooterSegmentBackground`; add `buildFooterUnderlayCell`; rework
  `buildSegmentedFooterLine` layout (LHS marker + RHS space).
- `test/pi-graphics.test.js` (+/-8): repin source assertions — assert the new
  `buildFooterUnderlayCell` / `renderFooterUnderlay` / BACKGROUND-z placement and
  assert absence of `ensureFooterSegmentBackground` and the old
  `hOffset: FOOTER_DIVIDER_WIDTH`.

## Validation
- `node --test`: 499 pass / 0 fail (rebased onto latest main first).
- `npm run pi-graphics:smoke`: OK. `npm run docs:check`: OK.
- Direct render check: `renderFooterUnderlay({columns:120,...})` emits a valid
  224-byte PNG (1 row, 120 cols).

## Operator-takeaway
The stray editor/rail gradient was the footer segment background detaching from
its relative anchor. It is gone: the footer background is now a single 1x1
unicode-anchored underlay (mild upward glow + bottom hline, themed milder than
the editor border), so there are no relative placements left to drift onto the
editor. Footer now reads `provider/model<space>` flush to the right edge.
