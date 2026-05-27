# Session summary — Tendril describe defaults to GitHub Copilot Opus

## Goal

Audit and fix `/tendril describe` VLM description path because it defaulted to a flaky LiteLLM Anthropic model. Prefer GitHub Copilot Claude Opus 4.7 so Pi can use its normal Copilot auth/token path, including system `~/.config/gh-auth-tokens` handling through the provider.

## Bead(s)

- `bd-0026c0` — Audit Tendril VLM describe Copilot model/auth

## Work completed

- Changed Tendril screenshot description default model from `litellm-anthropic/claude-opus-4-7` to `github-copilot/claude-opus-4.7`.
- Added fallback model resolution when `TENDRIL_SHARE_DESCRIBE_MODEL` is not explicitly set:
  1. `github-copilot/claude-opus-4.7`
  2. `github-copilot/claude-opus-4.7-1m-internal`
  3. `github-copilot/claude-opus-4-7`
  4. `github-copilot/claude-opus-4-7-1m-internal`
  5. `litellm-anthropic/claude-opus-4-7`
- Kept explicit `TENDRIL_SHARE_DESCRIBE_MODEL=provider/model` override strict: if set, only that model is attempted.
- Added image-input support filtering and a better error listing attempted defaults / text-only matches / missing specs.
- Updated README to document the new default/fallbacks and that Copilot provider auth uses Pi's normal GitHub token path.
- Updated tests so `/tendril describe` uses `github-copilot/claude-opus-4.7` by default and passes provider-scoped auth through `ctx.modelRegistry.getApiKeyAndHeaders()`.

## Validation

- `node --check extensions/tendril-share.js`
- `node --test test/tendril-share.test.js` — 10/10 pass
- `npm run docs:check` — pass
- `git diff --check` — pass
- `npm test` — 295/295 pass

## Diff summary

- Code commit: `0b313d0`.
- Files touched: `extensions/tendril-share.js`, `test/tendril-share.test.js`, `README.md`.
- Behavioural delta: `/tendril describe ...` should use GitHub Copilot Opus 4.7 when registered, falling back to known Opus ids only when necessary, rather than starting with LiteLLM.

## Operator-takeaway

After update/reload, run `/tendril describe window <id> ...`; the inserted description should say `from github-copilot/claude-opus-4.7` when that model is registered. If Copilot has a slightly different registered id, the fallback list should still cover common internal/hyphen variants before falling back to LiteLLM.
