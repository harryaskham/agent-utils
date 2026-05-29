# Session summary — editor gfx widgets full width with right previews

## Goal

Fix Pi graphics editor overflow/border widgets shrinking when the kitty image preview right-side panel is active. The editor graphics above/below the editor should render at full terminal width even if that overlaps the side preview.

## Bead(s)

- `bd-8ea791` — Keep editor graphics widgets full width with side previews
- Filed follow-up only: `bd-fd759f` — Fix Opus adaptive effort mapping for supported values (user asked to file and finish gfx first)

## Work completed

- Updated `extensions/pi-graphics.js` so editor border/overflow widgets mark themselves as full-width surfaces:
  - `__piGraphicsFullWidthWidget: true`
  - `__kittyImagePreviewFullWidthWidget: true`
- Updated `extensions/kitty-image-preview.js` side-panel renderer:
  - detects marked full-width components before the editor boundary
  - renders those components with full terminal width instead of side-panel main width
  - does not append side-panel blanking/image content over those rows, so editor gfx rows keep 100% width and win overlap rows
  - preserves existing side-panel behavior for ordinary transcript/top widgets
- Documented the behavior in `docs/pi-graphics.md`.
- Added focused source-invariant tests in kitty/pi graphics tests.

## Validation

- `node --check extensions/kitty-image-preview.js`
- `node --check extensions/pi-graphics.js`
- `node --test test/kitty-graphics.test.js test/pi-graphics.test.js` — 118/118 pass
- `npm run docs:check` — pass
- `git diff --check` — pass

## Commit

- `de747cf` before reintegration.
