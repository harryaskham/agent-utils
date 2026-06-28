# Session summary — /rt k=v Azure settings + GA defaults + 1006 doctor hint

## Goal

Harry asked, mid-incident-recovery, to drive the realtime Azure connection from
`/rt key=value` commands instead of env vars, and to default the Azure config to
the freshly-deployed gpt-realtime-2 GA model. Folded in the realtime-2 connect
diagnostic the peers surfaced (the silent 1006 close before session.created), as
one realtime-agent.js branch so the fleet didn't 3-way collide on the file.

## Bead(s)

- `bd-d0124f` — /rt k=v: add Azure connection + model settings keys
  (direct_azure, endpoint, deployment, api_version, protocol, model) (feature).
- folds in `bd-5406ff` (msm-2's 1006 connect-diagnostic design, closed into this).
- relates to `bd-0b40ce` (msm-0 connect tracker) and `bd-cb6625` (cacophony/infra
  proxy GA-realtime routing — the remaining upstream blocker).

## Before state

- `/rt` k=v only exposed `base_url`; model/directAzure/azureEndpoint/
  azureDeployment/azureApiVersion/azureProtocol were env-var-only
  (PI_RT_AZURE_*). Azure api-version defaulted to the deprecated
  `2025-04-01-preview`. A connect that opened then died before session.created
  surfaced a generic "WebSocket closed".
- Suite: 1078 green (peers also landing).

## After state

- `/rt model=… azure=true endpoint=… deployment=… api_version=none protocol=v1`
  applies at runtime via new controls setters; snapshot exposes the azure fields
  + an `effectiveUrl` echo (api key is a header, never in the URL).
- Azure defaults target the gpt-realtime-2 canadacentral GA deployment, api-version
  omitted ("none"); key stays in sops, never hardcoded. direct_azure stays
  opt-in by default (pending Harry's call on defaulting it on).
- A WS that opens then closes before session.created (silent 1006) now yields a
  clear reason pointing at the upstream GA-realtime session / proxy routing
  (bd-cb6625), surfaced in `/rt doctor`.
- Suite: 1084 green; `npm run check` (lint:workflows + docs:check) green.

## Diff summary

- Code: `80b8ed5` (pending final squash SHA from the reintegration receipt).
- Files: extensions/lib/realtime-config.js (GA Azure defaults + DEFAULT_AZURE_*),
  extensions/realtime-agent.js (setters, snapshot azure fields + effectiveUrl,
  envArgsToRealtimeParams keys, applyRealtimeParams, normalizeRealtimeToolParams
  coercion, echo, usage, 1006 connect capture), extensions/lib/realtime-text.js
  (realtimeSessionStartFailureReason + isRealtimeSessionStartFailure),
  extensions/lib/realtime-status.js (doctor hint), test/realtime-agent.test.js
  (+5 tests), test/realtime-config.test.js (defaults assertion updated).
- Tests: +6 (5 new, 1 updated). Behavioural delta: Azure realtime is runtime-
  configurable via /rt; GA is the default; connect failures are legible.

## Operator-takeaway

Harry can now point Pi realtime straight at the gpt-realtime-2 GA deployment with
one `/rt azure=true start=vad` (defaults preset; key from sops) — no env-var
juggling — and bypass the still-broken LiteLLM proxy. The actual GA connect
remains gated on the proxy fix (bd-cb6625) for the proxy path; the new doctor hint
makes that failure self-explaining. Open decision: whether direct_azure should
default ON (it's off now).
