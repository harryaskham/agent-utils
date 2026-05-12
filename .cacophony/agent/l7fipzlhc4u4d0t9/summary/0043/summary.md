# Session summary — audio-native realtime microphone turns

## Goal

Fix full `/rt` microphone turns so realtime inference is grounded in committed audio bytes rather than a transcript-injected user prompt, while still displaying transcripts in the UI for the operator.

## Bead(s)

- `bd-18ba3f` — Make full realtime mic turns audio-native instead of transcript-driven

## Before state

- Failing tests: none in repository; live tests showed the assistant could not infer melody/speaking-rate audio qualities and behaved like it only received transcript text.
- Relevant metrics: realtime suite was 34/34 before this patch.
- Context: full realtime used `create_response:false`, waited for `input_audio_transcription.completed`, injected that transcript with `pi.sendUserMessage()`, and relied on the resulting Pi turn to call `response.create`.

## After state

- Failing tests: none observed.
- Relevant metrics: full `npm test` passed 106/106 before rebase; after rebase, `npm test -- test/realtime-agent.test.js` passed 35/35 and `npm run docs:check` passed.
- Context: full realtime now triggers the Pi loop using a hidden `realtime-agent` custom message after `input_audio_buffer.committed`; the transcript is displayed as a custom UI message only and remains stripped from model context. STT-only mode still injects transcript user messages.

## Diff summary

- Commits: `7e084d1`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`, `docs/realtime-agent.md`
- Tests: +1 targeted realtime test proving full committed audio sends a hidden custom turn trigger, displays transcript as custom UI, never calls `sendUserMessage`, and never forwards transcript text to WSS.
- Behavioural delta: `/rt start vad` and `/rt listen vad` keep audio as the inference source; `/rt stt` remains transcript-driven by design.

## Operator-takeaway

This is the key fix for the melody/pace problem: in full realtime mode, transcripts are now UI artifacts, not the prompt the model reasons from. The model turn is triggered after the realtime server commits the audio item already in the realtime conversation.
