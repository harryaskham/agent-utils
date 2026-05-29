# Session summary — Show adaptive effort in footer

## Goal

Fix the Pi graphics footer so extension-managed adaptive effort displays as `adaptive` rather than falling back to the core Pi thinking level such as `medium`.

## Bead(s)

- `bd-a5f99d` — Show adaptive effort in Pi graphics footer

## Before state

- The effort extension tracked adaptive mode internally only.
- Pi graphics footer rendered `pi.getThinkingLevel()` directly, so when adaptive was active the footer could still show `medium`.
- After configuring adaptive true-defaults, the operator observed a footer like `ghcp/opus-4.8 ... medium`.

## After state

- The effort extension exposes `pi.agentUtilsEffort` with:
  - `getLevel(ctx)` — returns `adaptive` when extension-managed adaptive mode is active, otherwise returns the core thinking level.
  - `isAdaptive()` — boolean adaptive state.
- Pi graphics footer now prefers `pi.agentUtilsEffort.getLevel(ctx)` before falling back to `pi.getThinkingLevel()`.
- `/effort status` and footer integrations can now agree on `adaptive`.

## Diff summary

- Code/content commit: 7d82cd6.
- Files touched: `extensions/effort.js`, `extensions/pi-graphics.js`, `test/effort-command.test.js`, `test/pi-graphics.test.js`.
- Tests added/updated:
  - effort extension exposes adaptive state for status/footer integrations,
  - pi-graphics source guard checks footer reads `agentUtilsEffort.getLevel(ctx)` before core thinking level.

## Validation

- `node --test test/effort-command.test.js test/pi-graphics.test.js` — pass, 110 tests.
- `npm run docs:check` — pass.
- `git diff --check` — pass.
- `npm test` — pass, 328 tests.

## Operator-takeaway

After updating/reloading, the footer should show `adaptive` when adaptive true-defaults or `/effort adaptive` are active instead of showing the underlying core value `medium`.
