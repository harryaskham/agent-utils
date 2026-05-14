# Session summary — realtime fork option

## Goal

Add `fork=true` support to `/rt` so realtime can start in a fork from the current tree/session position while preserving the other supplied realtime parameters.

## Bead(s)

- `bd-dc5206` — Support /rt fork=true from current tree position

## Before state

- Failing tests: none observed.
- Relevant metrics: full suite was 141/141 before this patch.
- Context: `/rt` env-style parameters could configure backend, Pulse routing, summary mode, and lifecycle start, but could only continue in-place in the current session branch.

## After state

- Failing tests: none observed.
- Relevant metrics: after rebase, `npm test -- test/realtime-agent.test.js` passed 41/41 and `npm run docs:check` passed.
- Context: `fork=true` is parsed alongside other env-style `/rt` and `realtime_agent_control` parameters. It forks from `ctx.sessionManager.getLeafId()` with `position: "at"`, then applies the remaining realtime params in the replacement session.

## Diff summary

- Commits: `e11eb71`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`, `docs/realtime-agent.md`
- Tests: +1 realtime test asserting `/rt fork=true summary=true start=nolisten` forks the current leaf, preserves summary/start params, starts realtime, and notifies the forked session.
- Behavioural delta: users can start voice mode from a clean branch with commands like `/rt fork=true summary=true backend=pulse source=source.default start=vad` instead of contaminating the current tree position.

## Operator-takeaway

`fork=true` now composes with the normal `/rt` key/value arguments; it is not a separate mode, it is a preflight session fork before applying the requested realtime setup.
