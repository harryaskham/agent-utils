# Session summary — kitty image preview describe model: settings.json + Copilot Opus 4.8

## Goal

Make the kitty image preview's image-understanding ("describe") path configurable from `settings.json` and default to `github-copilot/claude-opus-4.8`, matching what tendril descriptions already do, so an operator can pin the vision model used for `kitty_image_preview_*` describe calls. Confirm the call reuses pi's Copilot auth rather than needing a separate JWT/auth.json hook.

## Bead(s)

- `bd-02c6ff` — kitty image preview describe path should read settings.json and default to github-copilot/claude-opus-4.8

Related context filed earlier this session (owned by peers): `bd-470314` (border-duplicate + FD-29 warnings, landed by dev-2), `bd-0ad3fd` (tendril/kitty scrollback, owned by dev-1).

## Before state

- Failing tests: none in scope (a separate broken-on-main xvfb test was owned/fixed by dev-1).
- `extensions/kitty-image-preview/constants.js`: `DEFAULT_DESCRIBE_MODEL = "litellm-anthropic/claude-opus-4-7"`.
- `resolveVisionModel` resolved only from per-call `describeModel` param -> `KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL` env -> constant default. It did NOT read `settings.json`.
- By contrast `tendril-share.js` already read `settings.json` keys and defaulted to `github-copilot/claude-opus-4.8`.

## After state

- Failing tests: none. 43 scoped tests pass (`node --test` on the new describe-model suite + touched kitty modules), including 11 new tests.
- `DEFAULT_DESCRIBE_MODEL = "github-copilot/claude-opus-4.8"` with a `FALLBACK_DESCRIBE_MODELS` chain (mirrors tendril-share) for graceful degradation on nodes lacking the exact id.
- New pure module `extensions/kitty-image-preview/describe-model.js` resolves the describe model by precedence: per-call param -> `KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL` env -> `settings.json` (`kittyImagePreview.describeModel` / `agentUtils.kittyImagePreview.describeModel`) -> default+fallback.
- `resolveVisionModel` delegates to the new resolver; auth path unchanged (`ctx.modelRegistry.getApiKeyAndHeaders`), so `github-copilot/*` models reuse pi's baked Copilot token.

## Diff summary

- Code commit on the agent branch: `8e8b1b6` (final landed squash SHA will come from the reintegration receipt).
- Summary artefact commit: intentionally omitted (must not self-reference its own mutable SHA).
- Files touched: `extensions/kitty-image-preview/constants.js`, `extensions/kitty-image-preview/describe-model.js` (new), `extensions/kitty-image-preview.js`, `extensions/kitty-image-preview/schema.js`, `test/kitty-image-preview-describe-model.test.js` (new).
- Tests: +11 (describe-model precedence, default=Copilot Opus 4.8, fallback engagement, settings.json disk read, text-only/unregistered error paths).
- Behavioural delta: kitty preview describe now defaults to Copilot Opus 4.8 and is settings.json-configurable; describe remains a separate `complete()` call (not a pi turn) that authenticates via pi's model registry.

## Operator-takeaway

Image-understanding for both tendril descriptions and the kitty preview is now a Copilot-Opus-4.8-by-default, settings.json-configurable, out-of-band-but-pi-authenticated `complete()` call — no separate Copilot JWT/auth.json plumbing is required because `ctx.modelRegistry.getApiKeyAndHeaders` already resolves pi's token. To change either path, set `tendril.describeModel` and/or `kittyImagePreview.describeModel` in settings.json. The two describe paths now share the same shape but not the same code — a follow-up to extract a shared helper would remove the duplication.
