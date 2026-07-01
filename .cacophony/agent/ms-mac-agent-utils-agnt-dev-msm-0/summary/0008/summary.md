# Session summary — durable cascade/stt settings + env-runtime-only (bd-b45224)

## Goal

Harry hit realtime settings.json values getting "reverted on load". Root-caused it,
and per his decision implemented the durable-settings contract: env wins for the
running session but is NEVER written back to settings.json (runtime-only override;
only explicit /rt changes persist), plus added durable persisted cascade + stt
settings slices so operator defaults can live in settings.json instead of env.

## Bead(s)

- `bd-b45224` — Realtime settings.json reverted on load (env>persisted shadows
  operator edits); add durable cascade/stt defaults.

## Before state

- Only `agentUtils.realtime` was persisted. Cascade had NO persisted slice
  (env PI_CASCADE_* + /cascade args only); stt fields lived only under realtime.
- No test asserted that env resolution leaves settings.json untouched.
- Suite: 1164 green at session start.

## After state

- `agentUtils.cascade` + `agentUtils.stt` durable slices added; cascadeRosterFromArgs
  falls back cascade main fields to the persisted cascade slice (args win);
  makeInitialConfig reads the stt slice as a fallback below realtime.
- Regression test locks: config resolution honors env at runtime but leaves
  settings.json byte-identical (env never persisted).
- Suite: 1172 green (+8), npm run check clean.
- Finding relayed to Harry: current agent-utils already keeps env runtime-only
  (traced every write path); his live plugin is published HEAD via
  `pi update --extensions`, so this reaches him on next update.

## Diff summary

- Code/content commit: 5e701b9 (pending final squash SHA from reintegration receipt).
- Files: extensions/lib/realtime-settings.js (cascade/stt read+persist helpers),
  extensions/lib/realtime-cascade-session.js (cascadeRosterFromArgs persisted
  fallback), extensions/lib/realtime-config.js (makeInitialConfig stt fallback),
  test/realtime-settings.test.js, test/realtime-cascade-session.test.js,
  docs/realtime-agent.md.
- Tests: +8 (env-not-persisted regression; cascade/stt round-trip + slice
  isolation; stt fallback; cascade persisted fallback).
- Behavioural delta: operators can move PI_CASCADE_VOICE / stt defaults into
  settings.json; env never clobbers the file.

## Operator-takeaway

settings.json is now authoritative + never clobbered by an env default: env is a
pure runtime overlay. Harry can drop the PI_RT_AZURE_* env (already defaulted in
the extension) and, once on the next update, move PI_CASCADE_VOICE into
agentUtils.cascade. The bigger want — cascade n=1 being his REAL agent (tools/
session/history), not a stateless completion — is the next bead, bd-095b3d.
