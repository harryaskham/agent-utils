# Session summary — model-config driven adaptive effort

## Goal

Adjust the newly added adaptive effort support so it is not hard-coded to Claude Opus/Sonnet ids. `/effort adaptive` should use the new `thinking.type=adaptive` plus `output_config.effort` format whenever model settings indicate reasoning support, so arbitrary model ids from `models.json` can opt in.

## Bead(s)

- `bd-d4d533` — Make adaptive effort model-config driven

## Work completed

- Removed hard-coded adaptive model id matching from `extensions/effort.js`.
- `supportsAdaptiveThinkingModel(model)` is now model-config driven via `model.reasoning === true`.
- `patchAdaptiveThinkingPayload(...)` now rewrites to adaptive format only when adaptive/fast mode is explicitly enabled, preserving legacy thinking format otherwise.
- `output_config.effort` now comes from `model.thinkingLevelMap` first, then generic effort spelling fallbacks (`low`, `medium`, `high`, `xhigh`). This preserves model-config overrides like `{ "xhigh": "max" }` without inferring from model ids.
- `/fast` now gates on reasoning-capable model settings rather than id patterns.
- README and focused effort-command tests updated accordingly.

## Validation

- `node --check extensions/effort.js`
- `node --test test/effort-command.test.js` — 10/10 pass
- `npm run docs:check` — pass
- `git diff --check` — pass

## Diff summary

- Code commit: `ba94cbe`.
- Files touched: `extensions/effort.js`, `test/effort-command.test.js`, `README.md`.

## Operator-takeaway

To enable adaptive format for any model id, define it with `reasoning: true` in model settings and optionally provide `thinkingLevelMap` values such as `{ "xhigh": "max" }`. Then `/effort adaptive` uses `thinking.type=adaptive` and `output_config.effort` without any id-name whitelist.
