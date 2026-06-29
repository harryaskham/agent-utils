# Session summary — bd-15beec slice 1: fast direct-Azure `speak` tool (cascade with pi brain)

## Goal

Give the loaded Pi agent a "mouth": a fast `speak` tool that synthesizes a reply
via the direct Azure Speech REST path (no `caco msg speak` daemon hop) in the
configured cascade/MAI voice and plays it locally. This is the low-latency
replacement for force-agent-speech's slow daemon precis, and slice 1 of routing
`/cascade n=1` through the actual Pi agent (operator request, Harry).

## Bead(s)

- `bd-15beec` — Cascade: route peer chat through Pi inference engine (n=1 = loaded Pi model), not litellm directly (slice 1 of N; bead stays open for the cascade-mode integration + n>1)

## Before state

- Failing tests: none (1112 green).
- Cascade n=1 made its own chat-completions call to PI_CASCADE_MODEL/MAPI_MODEL_ID via the proxy → 401 (wrong model/auth), not the Pi agent. force-agent-speech only spoke via the slow daemon `caco msg speak` with the daemon voice.

## After state

- Failing tests: none. Full suite 1113/1113 (+1). npm run check green.
- New `speak` Pi tool (pi.registerTool in realtime-agent.js): synthesizes via synthesizeAzureSpeechDirect (direct Azure REST, no daemon) in the cascade voice, plays locally, half-duplex aware. Defaults from PI_CASCADE_VOICE/PI_CASCADE_SPEAKER/PI_CASCADE_LANG/PI_CASCADE_SPEED, per-call override; concrete voice required; creds from AZURE_SPEECH_* env (never hardcoded).
- New pure resolveSpeakToolParams helper + test. Docs: speak-tool subsection in docs/realtime-agent.md.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: extensions/lib/realtime-tts-batch.js (resolveSpeakToolParams), extensions/realtime-agent.js (import + speak tool), test/realtime-tts-batch.test.js (+1), docs/realtime-agent.md.
- Tests: +1. Suite 1113/1113.
- Behavioural delta: the agent can call `speak("...")` to talk out loud in the MAI voice with low latency; pairs with /rt stt local-vad so the Pi agent is the cascade brain.

## Operator-takeaway

The Pi agent now has a fast in-session voice via the `speak` tool (direct Azure,
no daemon). Next slice: make the agent reply EXCLUSIVELY via speak (mandatory
voice mode) and wire it into /cascade start n=1 so one command turns the loaded
Pi agent into the cascade. n>1 parallel subagents is the larger follow-on.
