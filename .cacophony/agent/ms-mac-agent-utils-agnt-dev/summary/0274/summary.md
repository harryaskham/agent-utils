# Session summary — thinking footer off fallback

## Goal

User reported thinking still renders as `thinking off`.

## Bead(s)

- `bd-ca9d9e` — Fix thinking UI rendering as thinking off

## Work completed

- Audited Pi graphics footer/status thinking display.
- The footer segment used only runtime `pi.agentUtilsEffort.getLevel(ctx) || pi.getThinkingLevel() || "off"`.
- In sessions where Pi runtime reports or misses `off` before effort/true-default state is visible, the footer displayed `off` even though settings default/true-default thinking level was configured.
- Added `configuredThinkingLevel()` with the same true-default/default-thinking fallback chain used elsewhere.
- Added `effectiveThinkingLevel(ctx, pi)` so missing/runtime `off` falls back to configured default; explicit configured off still shows off.
- Updated footer segment to use `effectiveThinkingLevel(ctx, pi)`.
- Added source-invariant tests.
- Rebase conflicted with main's new `boxUnicodeMode` tests; resolved by keeping both the new box-unicode assertions and this thinking footer assertion set.

## Validation

- `node --check extensions/pi-graphics.js`
- `node --test test/pi-graphics.test.js` — 91/91 pass
- `npm run docs:check` — pass
- `git diff --check` — pass

## Commit

- `ae59fb6` after rebase before reintegration.
