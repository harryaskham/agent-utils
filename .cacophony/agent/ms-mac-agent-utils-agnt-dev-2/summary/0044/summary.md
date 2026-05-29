# Session summary — Tendril describe default model

## Goal

Make Tendril description features default to `github-copilot/claude-opus-4.8`, persistently configurable through settings.json, while preserving explicit overrides.

## Bead(s)

- `bd-1051f6` — Set default model for tendril description features

## Before state

- Tendril slash-command descriptions defaulted to `github-copilot/claude-opus-4.7`.
- The only explicit override path was `TENDRIL_SHARE_DESCRIBE_MODEL`.
- `tendril_settings` did not report the active description model.

## After state

- Default Tendril description model is now `github-copilot/claude-opus-4.8`.
- Fallback order includes Copilot Opus 4.8 variants first, then previous Opus 4.7 variants and LiteLLM fallback.
- Settings-aware configuration added:
  - `tendril.describeModel`
  - `tendrilShare.describeModel`
  - `agentUtils.tendril.describeModel`
  - `agentUtils.tendrilShare.describeModel`
- Env override still wins:
  - `TENDRIL_SHARE_DESCRIBE_MODEL=provider/model`
- `tendril_settings` now reports `describeModel=<spec> source=<env|settings|default>`.
- Current managed agent settings.json was updated outside the repo with:
  - `tendril.describeModel = github-copilot/claude-opus-4.8`

## Diff summary

- Code/content commit: f304450.
- Files touched:
  - `extensions/tendril-share.js`
  - `test/tendril-share.test.js`
  - `README.md`

## Validation

- `node --test test/tendril-share.test.js` — pass, 15 tests.
- `npm run docs:check` — pass.
- `git diff --check` — pass.
- `npm test` — pass, 331 tests.

## Operator-takeaway

Tendril `/tendril describe ...` now prefers Copilot Opus 4.8 by default and can be persistently changed in settings.json without relying on environment variables.
