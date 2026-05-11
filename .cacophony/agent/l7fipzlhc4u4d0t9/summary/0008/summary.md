# Session summary — realtime user guide

## Goal

Move realtime usage knowledge out of source comments and into operator-facing documentation that Harry can use while installing and testing the plugin.

## Bead(s)

- `bd-8dfc02` — Realtime plugin: add user guide for recommended workflows

## Before state

- Failing tests: none at start of this slice.
- Relevant metrics: `npm test` had 37 passing tests after the lifecycle test expansion.
- Context: realtime command/workflow guidance mostly lived in `extensions/realtime-agent.js` comments, making install-time testing harder.

## After state

- Failing tests: none; `npm test` and `npm run docs:check` pass.
- Relevant metrics: node test suite remains at 37 passing tests; docs inventory check passes.
- Context: `docs/realtime-agent.md` now covers full realtime, PTT, nolisten, STT-only, replay, diagnostics, Pulse/phone setup, VAD tuning, device listing, Azure mode, troubleshooting, and smoke testing. README links to it from the Pi package inventory.

## Diff summary

- Commits: `25bcb30`
- Files touched: `README.md`, `docs/realtime-agent.md`
- Tests: +0 / -0 / flipped 0
- Behavioural delta: no runtime change; realtime install/test workflows are documented in a dedicated guide.

## Operator-takeaway

Harry now has a practical checklist and command reference for testing the realtime plugin, especially the Pulse-first phone sink/source path and `/rt-doctor` diagnostics.
