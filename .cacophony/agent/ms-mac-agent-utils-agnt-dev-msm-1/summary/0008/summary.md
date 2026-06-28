# Session summary — realtime doctor: explain the GA-only model rejection

## Goal

Add a /rt-doctor hint that turns the cryptic gpt-realtime-2 connect failure into
a self-explaining, actionable diagnosis. Complements the connection-fix owner's
(msm-0) live repro of the GA-only rejection, endorsed by him; this is the
display/diagnostics half (my lane) of a problem whose real fix is upstream.

## Bead(s)

- `bd-392386` — realtime doctor: explain the GA-only model rejection.
- Complements `bd-0b40ce` (msm-0, gpt-realtime-2 connect; root cause is the
  LiteLLM proxy routing realtime via the beta interface for a GA-only model).

## Before state

- Failing tests: none.
- When gpt-realtime-2 failed to connect, /rt-doctor showed only the raw error
  text ('Model ... is only available on the GA API') plus a generic "verify the
  model id/base URL/routing" hint — no explanation that this is a GA-vs-beta
  endpoint routing problem or that a client-side header change cannot fix it.

## After state

- Failing tests: none. realtime-status 21/21; full suite 1075/1075, EXIT 0.
- /rt-doctor now detects that exact error (in lastResponseError or the disconnect
  reason) and explains: the model is GA but the endpoint/proxy is routing via the
  BETA interface; the real fix is the proxy routing realtime through OpenAI's GA
  API (a client beta-header change alone does NOT connect); for a direct Azure GA
  endpoint set PI_RT_AZURE_API_VERSION=none. Falls back to the generic hint for
  other errors.

## Diff summary

- Code/content commit: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/lib/realtime-status.js` (GA-aware branch in
  diagnosticLines hints), `test/realtime-status.test.js` (+1 test).
- Tests: +1 / -0. Behavioural delta: the GA-only rejection is now self-diagnosing
  in the doctor; no functional connect change (that is msm-0's bead + the
  upstream proxy fix).

## Operator-takeaway

When realtime won't connect with 'only available on the GA API', the doctor now
explains why (GA model, beta-routing proxy) and where the real fix lives
(upstream proxy GA-realtime routing), so the operator isn't left guessing or
chasing a client-side header change that provably does not help. This is the
diagnostics complement to the connection-fix work tracked under bd-0b40ce.
