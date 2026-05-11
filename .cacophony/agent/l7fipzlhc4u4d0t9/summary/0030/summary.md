# Session summary — Tendril screenshot describe command

## Goal

Extend the new user-facing Tendril sharing surface with a text-description path for cases where the active model should receive visual context as text instead of direct image input.

## Bead(s)

- `bd-14b4e8` — Tendril sharing: add describe command for screenshot context

## Before state

- Failing tests: none at start of this slice.
- Relevant metrics: `npm test` had 57 passing tests after the initial `/tendril list|window|display` slice landed.
- Context: users could send screenshot images to image-capable active models, but there was no `/tendril describe` or `/tendril-describe` path to have a separate VLM summarize the screenshot into text for the active model.

## After state

- Failing tests: none; `node --check extensions/tendril-share.js`, `npm test`, `npm run docs:check`, and `git diff --check` pass.
- Relevant metrics: node test suite now has 59 passing tests.
- Context: `/tendril describe window <id> [prompt]`, `/tendril describe display <id> [prompt]`, and `/tendril-describe window|display <id> [prompt]` capture PNGs, call a configurable image-capable model, and inject the resulting text as a user message. Busy sessions queue the description as a follow-up.

## Diff summary

- Commits: `3a52643`
- Files touched: `extensions/tendril-share.js`, `test/tendril-share.test.js`, `README.md`, `docs/tools.json`, `docs/index.html`
- Tests: +2 / -0 / flipped 0
- Behavioural delta: users can now share visual context either as direct screenshot image content or as a VLM-generated text description.

## Operator-takeaway

The Tendril sharing extension now supports both image-to-model and describe-to-text workflows. The describe model defaults to `litellm-anthropic/claude-opus-4-7` and can be overridden with `TENDRIL_SHARE_DESCRIBE_MODEL=provider/model`.
