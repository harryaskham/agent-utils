# Session summary — adaptive effort and fast mode

## Goal

Support `/effort adaptive` and add `/fast` for adaptive-thinking models, especially GitHub Copilot Claude Opus 4.6 where the provider rejects legacy `thinking.type=enabled` and requires `thinking.type=adaptive` plus `output_config.effort`.

## Bead(s)

- `bd-a6c521` — Support adaptive thinking effort

## Work completed

- Extended `extensions/effort.js`:
  - accepted effort values now include `adaptive`
  - `/effort adaptive` enables extension-managed adaptive mode without passing an unsupported `adaptive` value through Pi core thinking-level clamping
  - added `/fast [on|off]` toggle for adaptive-thinking models
  - `/fast` enables adaptive mode and applies `output_config.effort=low`
- Added payload rewrite hook via `before_provider_request`:
  - detects adaptive-capable Anthropic/Copilot model ids such as Claude Opus/Sonnet 4.6/4.7
  - rewrites legacy `thinking: { type: "enabled", budget_tokens: ... }` payloads into `thinking: { type: "adaptive", display: ... }`
  - adds `output_config.effort` from the active Pi thinking level when applicable
  - maps Opus 4.6 `xhigh` to `max`, preserving the known model-specific effort spelling
- Updated README command summary.
- Added focused tests for accepted levels, adaptive model detection, legacy-to-adaptive payload conversion, `/effort adaptive`, and `/fast` toggle/rejection behavior.

## Validation

- `node --check extensions/effort.js`
- `node --test test/effort-command.test.js` — 10/10 pass
- `npm run docs:check` — pass
- `git diff --check` — pass

## Diff summary

- Code commit: `efe939b`.
- Files touched: `extensions/effort.js`, `test/effort-command.test.js`, `README.md`.

## Operator-takeaway

For `github-copilot/claude-opus-4.6`, use `/effort adaptive` or `/fast on` to avoid the provider error:

```text
"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" ...
```

`/fast` is intentionally limited to adaptive-thinking Claude 4.6/4.7 style models and applies low effort through `output_config.effort`.
