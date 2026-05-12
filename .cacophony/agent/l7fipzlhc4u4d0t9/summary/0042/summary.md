# Session summary — realtime lifecycle routing hardening

## Goal

Fix the follow-up realtime lifecycle bugs discovered during live `/rt` testing: full realtime looked like STT-only, compaction tried to summarize with `gpt-realtime-2`, and text turns could still route through the realtime handler after `/rt off` restored `gpt-5.5`.

## Bead(s)

- `bd-e467e1` — Clarify and harden full realtime audio-turn path

## Before state

- Failing tests: none in repository; live session showed `Realtime transcription timed out`, compaction active-response errors, and text-model turns failing with `gpt-5.5 is not a realtime model` after realtime shutdown.
- Relevant metrics: realtime targeted suite was 32/32 after the prior STT routing fix.
- Context: the realtime provider registered itself under Pi's global `openai-responses` API stream handler, so other OpenAI-style text models could be routed into `realtime-agent.streamSimple` while the provider was registered.

## After state

- Failing tests: none observed.
- Relevant metrics: `npm test -- test/realtime-agent.test.js` passed 34/34 after rebase; `npm run docs:check` passed; full `npm test` passed 103/103 before rebase.
- Context: the realtime provider now uses a dedicated `openai-realtime` API dispatch key, compaction pauses realtime/restores the previous text model and cancels the current compaction attempt, and status/snapshot expose whether the last mic turn was full realtime `input:audio` or STT-only `input:transcript`.

## Diff summary

- Commits: `536b569`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`, `docs/realtime-agent.md`
- Tests: +2 targeted realtime tests for dedicated API dispatch and compaction-time realtime shutdown/restore.
- Behavioural delta: realtime no longer overrides Pi's normal `openai-responses` text model dispatcher, `/rt off` cleanup is reinforced by the dedicated API key, and compaction avoids using the realtime model while an audio response/session is active.

## Operator-takeaway

The post-`/rt off` `gpt-5.5 is not a realtime model` error came from registering realtime as the global `openai-responses` stream handler. Realtime now has its own dispatch API and compaction backs out to the text model instead of trying to summarize through the realtime socket.
