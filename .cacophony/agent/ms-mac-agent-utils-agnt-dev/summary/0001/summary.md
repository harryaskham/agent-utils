# Session summary — realtime provider startup registration

## Goal

Make the realtime Pi extension advertise `openai-realtime/gpt-realtime-2` during extension startup, so Pi model pattern resolution and startup/list-model surfaces can see the model before any `/rt` command is invoked.

## Bead(s)

- `bd-16f204` — Register openai-realtime provider during realtime extension startup

## Before state

- Failing tests: none observed before editing.
- Relevant metrics: realtime provider registration was gated behind `PI_RT_REGISTER`, `PI_RT_ALWAYS_REGISTER`, explicit `PI_MODEL=openai-realtime/...`, or later `/rt` force-registration.
- Context: startup could warn that no models matched `openai-realtime/gpt-realtime-2` because the extension had not registered the provider/model early enough.

## After state

- Failing tests: none in targeted validation.
- Relevant metrics: `realtimeAgentExtension(pi)` now registers the provider immediately during the extension factory path; the provider remains available after realtime is disabled or a text model is selected.
- Context: the realtime provider uses dedicated API id `openai-realtime`, so keeping it registered does not route normal text-provider turns through the realtime stream.

## Diff summary

- Code/content commits: `af7214b`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`
- Tests: updated realtime tests to assert startup registration and provider availability while preserving text-model STT behavior.
- Behavioural delta: `openai-realtime/gpt-realtime-2` is now model-visible as soon as the realtime extension loads, and `/rt-off`/text model selection no longer unregisters the provider.
- Validation: `npm test -- test/realtime-agent.test.js`.

## Operator-takeaway

The startup model-warning path should be fixed: enabling the realtime extension now makes the realtime provider/model known immediately instead of waiting for a `/rt` command.
