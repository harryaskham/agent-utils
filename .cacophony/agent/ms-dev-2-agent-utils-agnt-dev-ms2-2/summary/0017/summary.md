# Session summary — /rt connect auto-fallback proxy 1006 -> direct-Azure GA (bd-0b255f)

## Goal

Make realtime connect resilient to the LiteLLM proxy silently dropping the
session-start WebSocket with a 1006 abnormal closure: instead of failing and
requiring the operator to manually re-run with `azure=true`, automatically retry
once via the direct-Azure GA path when Azure is configured. Picked up per Harry's
"good time for interesting/hard work" invite after he freed capacity.

## Bead(s)

- `bd-0b255f` — /rt connect auto-fallback proxy 1006 -> direct-Azure GA
- Builds on the landed 1006 classification (bd-d0124f) and connect-probe doctor (bd-c3ac07, already closed — the coordination dependency was resolved).

## Before state

- Failing tests: none.
- `_connect` (realtime-agent.js): on a WS close before session.created it computed the failure reason (bd-d0124f) and threw; the operator had to notice the 1006 and re-run with `azure=true` to reach the working GA endpoint.
- `config.azureEndpoint`/`azureApiVersion` were already populated (makeInitialConfig defaults to the canadacentral `DEFAULT_AZURE_ENDPOINT` + `api_version=none`), so only `directAzure` needed flipping + the Azure key needed to be present.

## After state

- Failing tests: none. `node --test test/realtime-agent.test.js` = 68/68; full `npm test` green.
- New `RealtimeSession.shouldAutoFallbackToAzure(closeCode)` guard: fires only when NOT already on Azure (loop-safe: proxy->azure only), auto-fallback is not opted out, the close was the 1006 signature, and Azure is configured (key + endpoint).
- `_connect`'s `wsClosedBeforeEvent` branch: when the guard passes, closes the dropped socket, flips `config.directAzure = true` (session-local, not persisted), notifies the operator, and retries `_connect` once. The `!directAzure` guard prevents an azure->azure loop.
- Opt-out via `PI_RT_CONNECT_AUTOFALLBACK=0` (documented in the top-of-file env block); default on when an Azure key is configured, and a no-op when it isn't (so non-Azure users are unaffected).

## Diff summary

- Code/content commit: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/realtime-agent.js` (shouldAutoFallbackToAzure guard + _connect 1006 auto-retry + env-doc line), `test/realtime-agent.test.js` (+2 tests: fallback fires and connects via azure; opt-out disables it).
- Tests: +2 / -0 / flipped 0.
- Behavioural delta: a 1006 proxy-drop on the proxy path now transparently retries via direct-Azure GA when Azure is configured, instead of failing the connect.

## Operator-takeaway

When the realtime proxy silently drops the session-start socket (the 1006 case),
realtime now heals itself by retrying the proven direct-Azure GA endpoint instead
of making you re-run with azure=true. It's loop-safe (one proxy->azure hop),
session-local (a fresh /rt start still tries the proxy first), only kicks in when
Azure is actually configured, and is one env var (PI_RT_CONNECT_AUTOFALLBACK=0)
away from off. This closes the last of my filed realtime-connect-resilience drafts.
