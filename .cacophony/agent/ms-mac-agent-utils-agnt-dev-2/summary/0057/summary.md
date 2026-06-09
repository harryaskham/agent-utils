# Session summary — web-search model-fallback resilience

## Goal

Harden the web-search plugin against the exact failure that broke it this
session: a retired default model. Add a bounded model-fallback so a future model
retirement degrades gracefully instead of hard-failing.

## Bead(s)

- `bd-b05d58` — web-search: bounded model-fallback resilience against retired models

## Before state

- Failing tests: none (suite 589 green).
- web-search 400ed hard when the configured model was unavailable; no test file.

## After state

- Failing tests: none. New test/web-search.test.js (5 tests); full suite 594 green.
- On a model-availability 400, web-search retries the next candidate (requested,
  default, then fallbacks gpt-5.3-codex/gpt-5.5/gpt-5.4, deduped). Non-model
  errors surface immediately. Overridable via WEB_SEARCH_FALLBACK_MODELS.
- Pure helpers extracted to extensions/web-search-models.js (typebox-free) for
  unit testing.

## Diff summary

- Code/content commits: pending final squash SHA from reintegration receipt
- Files touched: `extensions/web-search.js`, `extensions/web-search-models.js` (new),
  `test/web-search.test.js` (new)
- Tests: +5 / -0
- Behavioural delta: web-search now survives a retired/unavailable model by
  falling back to a known-good one.

## Operator-takeaway

Web search no longer breaks on a single model retirement; the bounded fallback
keeps it working and the model list is operator-overridable.
