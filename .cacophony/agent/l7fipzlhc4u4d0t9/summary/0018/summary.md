# Session summary — realtime usage help API

## Goal

Continue realtime discoverability polish by exposing the canonical `/rt` usage text through the unified `pi.realtime` control API.

## Bead(s)

- `bd-09d41f` — Realtime plugin: expose unified /rt usage through controls API

## Before state

- Failing tests: none at start of this slice.
- Relevant metrics: `npm test` had 46 passing tests after connection flags landed.
- Context: `/rt help` had a canonical usage string inside the slash-command handler, but future UI/extensions using `pi.realtime` would have to duplicate that text.

## After state

- Failing tests: none; `npm test` and `npm run docs:check` pass.
- Relevant metrics: node test suite remains at 46 passing tests with expanded unified-control assertions.
- Context: the usage text now lives in a shared constant and is exposed as `pi.realtime.usage()` / `pi.realtime.help()`. `/rt help` uses the same control API path, and docs list the new methods.

## Diff summary

- Commits: `133c861`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`, `docs/realtime-agent.md`
- Tests: +0 / -0 / flipped 0; existing unified-control test now asserts usage/help methods.
- Behavioural delta: future UI/help surfaces can render the canonical realtime command usage without duplicating command text.

## Operator-takeaway

The realtime controls API now exposes both what commands can do and the exact usage text users see from `/rt help`.
