# Session summary — scrub box-edge Unicode placeholders when box chrome is off

## Goal

Fix reports that Unicode kitty image placeholder cells still marked box edges even when `piGraphics.boxChrome` / `/gfx box off` said box chrome was disabled.

## Bead(s)

- `bd-67fef5` — Do not emit box-edge unicode image placeholders when box chrome is off

## Root cause

Box chrome monkey-patches Pi component prototypes globally. Across extension reloads, a fresh `pi-graphics` extension instance can start with `boxChrome=false` and therefore have no current restore callback, while old process-global component prototypes remain wrapped from a previous box-chrome-on runtime. The disabled path set runtime state to null but did not necessarily scrub those old prototype wrappers, leaving Unicode placeholder edge cells in rendered boxes.

## Work completed

- Added `boxChromeComponentMap()` in `extensions/pi-graphics.js` so install and teardown use one canonical Pi component set.
- Changed `teardownBoxChrome(ctx)` to install a null-runtime box chrome owner and immediately restore it. This cleans stale global component prototype wrappers even when the current extension instance did not create them.
- Kept UI-surface restoration and runtime/cache nulling intact.
- Added a regression in `test/box-chrome.test.js` proving `installBoxChromeMonkeyPatch({ runtime: null })` stops placeholder edge emission and removes stale wrappers.
- Added a source guard in `test/pi-graphics.test.js` for the null-runtime scrub path.

## Validation

- `node --check extensions/pi-graphics.js`
- `node --test test/box-chrome.test.js test/pi-graphics.test.js` — 105/105 pass
- `npm run docs:check` — pass
- `git diff --check` — pass
- `npm test` — 294/294 pass

## Diff summary

- Code commit: `78484a1`.
- Files touched: `extensions/pi-graphics.js`, `test/box-chrome.test.js`, `test/pi-graphics.test.js`.
- Behavioural delta: when box chrome is disabled, stale process-global box chrome wrappers are scrubbed so normal text/unicode box borders render without kitty placeholder edge cells.

## Operator-takeaway

After update/reload, `/gfx box off` / `piGraphics.boxChrome:false` should stop box-edge Unicode image placeholders even if an earlier extension runtime had box chrome on. If placeholders still appear, they are likely from non-box features such as editor cursor/rails or debug placeholders and should be distinguished by `/gfx status` and `/gfx debug`.
