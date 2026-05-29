# Session summary — status placeholder prefix artifact

## Goal

User showed `/gfx status` output with visible one-cell Kitty placeholder prefixes on every line (`􎻮...`) plus stray glyphs at the bottom. The artifact is active rendering, not stale and not row background/trailing workspace.

## Bead(s)

- `bd-782b85` — Make Pi graphics status indicator placeholders opt-in

## Findings

- The visible prefixes come from Pi graphics' status/notification indicator path:
  - `decorateNotificationValue()` prefixes every non-empty notification line.
  - `decorateStatusValue()` emits a one-cell `renderPromptEnclosure()` placeholder via `buildStatusIndicatorPrefix()`.
- This path becomes active when box rails/chrome patches UI surfaces, so `/gfx status` and similar diagnostics get a graphical one-cell marker on every line.
- In terminals where the image does not paint instantly, those placeholder codepoints are visible and read as a stray left-to-right gradient/editor-background artifact.

## Work completed

- Added `statusIndicatorsEnabled()` gated by `PI_GRAPHICS_STATUS_INDICATORS`.
- Status/notification/working-message/working-indicator graphical prefixes now default off.
- Existing indicator behavior remains available with `PI_GRAPHICS_STATUS_INDICATORS=1`.
- Updated docs to describe the opt-in and why diagnostic output stays plain by default.
- Added source-invariant tests.

## Validation

- `node --check extensions/pi-graphics.js`
- `node --test test/pi-graphics.test.js` — 91/91 pass
- `npm run docs:check` — pass
- `git diff --check` — pass

## Commit

- `2719a5b` before reintegration.
