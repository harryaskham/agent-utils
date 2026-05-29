# Session summary — /fast toggles -fast model variants only

## Goal

Correct the prior interpretation of `/fast`. The operator clarified that Claude fast mode should be represented in this setup as a separate configured model with a `-fast` suffix, not as lower reasoning effort.

## Bead(s)

- `bd-c3c717` — Fix /fast to model Claude fast mode, not low effort

## Before state

- `/fast` toggled an internal flag and caused adaptive request rewriting to use `output_config.effort=low`.
- `/fast` also implicitly enabled adaptive mode.
- This incorrectly conflated fast mode with lower effort, even though Claude Code fast mode keeps the same model quality/capabilities and is separate from effort level.

## After state

- `/fast` is intentionally dumb:
  - from `provider/model` it selects `provider/model-fast` when configured,
  - from `provider/model-fast` it selects `provider/model`,
  - `/fast on` forces the suffixed model,
  - `/fast off` forces the unsuffixed model.
- `/fast` no longer changes thinking level, no longer enables adaptive mode, and no longer mutates provider payloads.
- Adaptive thinking support remains separate under `/effort adaptive` and model compatibility metadata.
- GitHub Copilot Opus 4.8 adaptive thinking clamp still applies to both `claude-opus-4.8` and `claude-opus-4.8-fast` by normalizing the `-fast` suffix for the support check.

## Diff summary

- Code/content commit: 770a111.
- Files touched: `extensions/effort.js`, `test/effort-command.test.js`, `README.md`.
- Tests added/updated:
  - `/fast` switches only between model ids with/without `-fast`,
  - `/fast` preserves thinking level,
  - stale `fast` payload option no longer rewrites request payloads,
  - missing `-fast` counterpart reports a warning instead of changing effort.

## Validation

- `node --test test/effort-command.test.js` — pass, 15 tests.
- `npm run docs:check` — pass.
- `git diff --check` — pass.
- `npm test` — pass, 323 tests.

## Operator-takeaway

`/fast` now just toggles between configured `-fast` model variants. It does not mean low effort and will not send `output_config.effort=low`.
