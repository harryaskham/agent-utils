# Session summary — STT provider routing fix

## Goal

Fix the realtime/STT failure observed during live testing where transcript injection after `/rt stt` or regular STT could be routed into the realtime provider while the selected model was still a normal text model such as `litellm-openai/gpt-5.5`.

## Bead(s)

- `bd-060ed4` — Fix STT-only realtime provider routing after transcript injection

## Before state

- Failing tests: none in the repository before the fix; live session reported `realtime-agent: model litellm-openai/gpt-5.5 is not a realtime model` after STT/realtime testing.
- Relevant metrics: realtime tests were 30/30 before this patch; full suite was 99/99 before the follow-up bugfix.
- Context: STT-only startup force-registered the `openai-realtime` provider while keeping the current Pi text model selected, which could misroute later transcript-injected text turns.

## After state

- Failing tests: none observed.
- Relevant metrics: full `npm test` passed 101/101 before rebase; after rebase, targeted `npm test -- test/realtime-agent.test.js` passed 32/32 and `npm run docs:check` passed.
- Context: STT-only startup no longer force-registers the realtime provider; full realtime startup still registers it before switching to `openai-realtime`. Disabling realtime or selecting a non-realtime model unregisters the realtime provider. Agent tool calls that combine `start` and `status` now still start realtime instead of status-short-circuiting.

## Diff summary

- Commits: `8ce0c5d`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`
- Tests: +2 targeted realtime tests for STT provider non-registration and `realtime_agent_control` start+status behavior.
- Behavioural delta: STT transcript injection remains on the selected text provider, avoiding realtime-provider errors for non-realtime models.

## Operator-takeaway

The observed live error was a real routing bug: STT mode should use realtime only for microphone transcription, not claim the normal text-model completion path. That provider registration is now limited to full realtime mode and cleaned up when realtime is disabled.
