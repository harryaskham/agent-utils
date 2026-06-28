# bd-d936b2 — make /rt-listen test hermetic for keyless CI runners

The last js-job red on the azure-ephemeral pool after the toolchain fix
(bd-7eb473) and msm-2's rt-peer cascade fix (bd-33c4d3).

## Problem
`test/realtime-agent.test.js` "/rt listen accepts the same continuous mode as
direct controls" reaches `_connect`'s apiKey check (extensions/realtime-agent.js
:559) but never set a fake API key, so it passed only with an ambient
OPENAI_API_KEY/PI_RT_API_KEY in the env (local dev) and failed
`No OpenAI API key` on the secretless ephemeral CI runners.

## Fix (test-only, no production change)
Set `process.env.PI_RT_API_KEY = "test-key"` (with save/restore in `finally`),
matching the established pattern already used by the other connect-touching
tests in this file (lines ~534/805/856/910). The global `FakeWebSocket`
(set at line 75) handles the connect, so no real network.

## Validation
- `realtime-agent.test.js` with **OPENAI_API_KEY + PI_RT_API_KEY both UNSET**
  (simulating the keyless runner): 64 tests, 64 pass, 0 fail, 0 cancelled
  (was failing the /rt-listen test with "No OpenAI API key").
- Full suite + `npm run check` green after rebase onto main (which carries
  msm-2's bd-33c4d3 rt-peer determinism fix).

## Landing
- Direct mode. Post-land: trigger a ci.yml validation run to confirm the js job
  goes GREEN — completing fully-green agent-utils CI (js + rust + audit) on the
  azure-ephemeral pool via the nix devShell.
