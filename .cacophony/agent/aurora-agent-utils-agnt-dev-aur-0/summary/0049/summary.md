# Session summary — omittable Azure realtime api-version (bd-cb74b5)

## Goal

Fix Harry's gpt-realtime-2 connect failure ("only available on the GA API") caused
by the helsinki LiteLLM proxy no longer accepting the dated Azure api-version.

## Bead(s)

- `bd-cb74b5` — realtime: make Azure api-version omittable for GA-only LiteLLM
  proxies (bug; landed).

## Change

azureRealtimeUrl now omits &api-version=... entirely when the value is blank,
"none", or "ga" (case-insensitive), for both v1 and beta protocols. Non-breaking:
the default api-version is still appended; the operator drops it by setting
PI_RT_AZURE_API_VERSION=none. Env-var doc comment updated.

## Verification

- +1 test: omit cases (blank/whitespace/none/GA/null/undefined) across v1 + beta.
- Full suite 1014 green; npm run check green.

## Diff summary

- Code/content commit: pending final squash SHA.
- Summary artefact: intentionally omitted.
- Files: realtime-helpers.js (azureRealtimeUrl), realtime-agent.js (doc comment),
  realtime-lib.test.js (+1).
- Behavioural delta: api-version is now droppable via PI_RT_AZURE_API_VERSION=none.

## Operator-takeaway

Set PI_RT_AZURE_API_VERSION=none and reconnect realtime to route gpt-realtime-2 to
the GA endpoint through the LiteLLM proxy.
