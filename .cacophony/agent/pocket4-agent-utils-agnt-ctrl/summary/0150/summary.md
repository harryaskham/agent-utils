# Session summary — remove adaptive thinking overrides

## Goal

Remove the agent-utils adaptive-thinking shim that had become redundant and potentially harmful now that Pi natively supports adaptive thinking and refreshed Claude Opus metadata. The operator specifically requested that adaptive be handled by Pi core, with no agent-utils payload rewriting and no Opus 4.8 special-casing.

## Bead(s)

- `bd-a8c14e` — Remove legacy adaptive-thinking payload shim after Pi 0.77 native support
- Related historical bead: `bd-a6c521` — Support adaptive thinking effort

## Before state

- Failing tests: none observed before changes.
- Relevant metrics: agent-utils `extensions/effort.js` contained a `before_provider_request` hook, `patchAdaptiveThinkingPayload`, output-config effort clamping, model metadata interpretation, and a GitHub Copilot Claude Opus 4.8 explicit clamp to `medium`.
- Context: Pi 0.77.0 release notes said Claude Opus 4.8 metadata and Opus adaptive-thinking coverage are now native, while the operator reported the old local shim was breaking sessions.

## After state

- Failing tests: none. `npm test` passed 441 tests; `npm run docs:check` passed.
- Relevant metrics: removed 283 lines and added 32 lines across docs, extension code, and tests.
- Context: `/effort` now delegates all values, including `adaptive`, directly to Pi core via `setThinkingLevel`; it no longer registers provider request hooks or mutates payloads. `true-defaults` delegates adaptive through `setThinkingLevel` like any other value.

## Diff summary

- Code/content commits: `410a3f1`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `README.md`, `extensions/effort.js`, `extensions/true-defaults.js`, `test/effort-command.test.js`, `test/true-defaults.test.js`
- Tests: updated effort and true-default tests; no net test failures. Full `npm test` passed 441 tests, and docs inventory check passed.
- Behavioural delta: agent-utils no longer rewrites adaptive-thinking request payloads, adds `output_config.effort`, interprets model adaptive metadata, or special-cases Claude Opus 4.8. Adaptive thinking semantics are owned by Pi core.

## Operator-takeaway

The breaking local adaptive shim is gone: agent-utils now treats adaptive as a native Pi thinking level instead of trying to emulate or patch provider payloads itself.
