# Session summary — realtime model fallback clamp

## Goal

Ensure realtime startup clamps invalid or unavailable requested realtime model IDs to the supported `gpt-realtime-2` configuration instead of carrying a bad provider/model combination forward.

## Bead(s)

- `bd-279a12` — Voice plugin should clamp realtime provider/model fallback

## Before state

- Failing tests: none observed.
- Relevant metrics: user report described missing `gpt-realtime-2` / bad requested realtime model paths proceeding with an unclamped provider/model selection.
- Context: `startRealtime()` used `config.model` directly and built a fallback model object with that ID, so a bad `PI_RT_MODEL` such as a text model could become an `openai-realtime/<bad-id>` selection.

## After state

- Failing tests: none observed.
- Relevant metrics: `npm run docs:check` passed and full `npm test` passed 153/153.
- Context: realtime model IDs are normalized through a supported set (`gpt-realtime-2`, `gpt-realtime`). Invalid env/config/model-select IDs clamp to `gpt-realtime-2`. Startup tries the requested supported model, then the default, and only then creates a fallback object for the normalized realtime model.

## Diff summary

- Code/content commits: `65f98d3`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`
- Tests: +1 regression test setting `PI_RT_MODEL=gpt-4o-mini` and asserting `/rt start nolisten` selects `openai-realtime/gpt-realtime-2`.
- Behavioural delta: realtime/voice startup should no longer proceed with unsupported text-model IDs in the realtime provider path.

## Operator-takeaway

Bad realtime model settings now fail closed to the supported default rather than producing a broken provider/model pairing.
