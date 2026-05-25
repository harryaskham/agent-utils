# Session summary — Realtime base URL override for plaintext LiteLLM

## Goal

Diagnose Harry's realtime `write EPROTO ... wrong version number` failure when connecting to `gpt-realtime-2` through the helsinki LiteLLM proxy, and provide a runtime way to select the correct plaintext realtime base URL.

## Bead(s)

- `bd-078e0e` — Diagnose realtime TLS wrong-version WebSocket errors

## Before state

- Failing tests: none known.
- Relevant metrics: full `npm test` was passing.
- Context: `OPENAI_BASE_URL=https://helsinki.miku-owl.ts.net:4000` caused realtime to derive `wss://helsinki.miku-owl.ts.net:4000/v1/realtime`. Curl confirmed the helsinki proxy is plaintext HTTP: `http://.../health` returns 401 JSON, while `https://.../health` fails with TLS wrong-version. An authenticated WebSocket upgrade against `http://.../v1/realtime?model=gpt-realtime-2` succeeds with HTTP 101 and a `session.created` event.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/realtime-agent.js`; `node --test test/realtime-agent.test.js` passed 49/49; full `npm test` passed 289/289; `npm run docs:check` passed; `git diff --check` passed.
- Context: `/rt` env-style args and `realtime_agent_control` now accept `base_url` / `baseUrl` / `openai_base_url` / `rt_base_url`. Setting `base_url=http://helsinki.miku-owl.ts.net:4000` makes realtime derive `ws://...`, while `https://api.openai.com/v1` normalizes to `https://api.openai.com` and derives `wss://...`.

## Diff summary

- Code/content commit: `7a8826b`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`, `docs/realtime-agent.md`.
- Behavioural delta: operators can override realtime's base URL per `/rt` command without recreating the Pi/caco environment.

## Operator-takeaway

For the current caco-ctrl-style environment, use `base_url=http://helsinki.miku-owl.ts.net:4000` (or set `PI_RT_BASE_URL` to that) so realtime uses plaintext `ws://` instead of deriving `wss://` from stale `OPENAI_BASE_URL=https://...`. Also note that `PI_RT_TRANSCRIPTION_MODEL=whisper-1` overrides `OPENAI_REALTIME_TRANSCRIPTION_MODEL`; if the proxy expects the realtime transcription deployment, pass `trans=gpt-realtime-whisper` or update that env var.
