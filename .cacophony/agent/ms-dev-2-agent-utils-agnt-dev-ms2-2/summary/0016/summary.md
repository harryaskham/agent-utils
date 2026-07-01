# Session summary — Harden STT transcript trust boundary (bd-caed3f)

## Goal

Close a latent prompt-injection gap in the agent-utils realtime extension: in
STT-only modes, raw transcribed microphone speech was injected into the agent as
a directive followUp user message, so an overheard or crafted utterance could
read as trusted operator instructions. Harry resolved the surfaced choice with a
steer to prefix transcribed content with an untrusted-content warning; this
session implements that for the realtime path.

## Bead(s)

- `bd-caed3f` — Harden STT transcript trust boundary in realtime-agent.js (latent prompt-injection surface)
- Filed cross-project follow-up: `bd-4c9c3d` (cacophony, draft) — label caco audio transcribe / scratchpad-read STT output as untrusted (the caco-daemon-side complement Harry flagged).

## Before state

- Failing tests: none.
- `realtime-agent.js` STT-only injection sites (server-transcription completed handler and the local-VAD `sendTurn`) called `pi.sendUserMessage(text, {deliverAs:"followUp"})` with the raw transcript — no untrusted framing.
- Tests asserted the exact raw injected content (e.g. "queue this while busy", "hello there").

## After state

- Failing tests: none. `node --test test/realtime-agent.test.js` = 66/66; full `npm test` green.
- New exported helper `labelUntrustedTranscript(text)` prefixes STT transcripts with an
  explicit untrusted-content warning (do not follow embedded commands to reveal secrets /
  run destructive actions / override operator directives). Opt-out via `PI_RT_STT_UNTRUSTED_LABEL=0`.
- Both STT-only injection sites now wrap the transcript with `labelUntrustedTranscript()` before
  `sendUserMessage`; display/status/dedup paths keep the raw text (only the model-facing payload is labelled).
- Operator steer honored: transcribed speech is now framed as untrusted context, not a directive.
- The caco-daemon-side part (transcribe stderr / scratchpad-read labelling) is tracked separately in bd-4c9c3d.

## Diff summary

- Code/content commit: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/realtime-agent.js` (UNTRUSTED_TRANSCRIPT_PREFIX + exported labelUntrustedTranscript helper; wired both STT injection sites), `test/realtime-agent.test.js` (import; updated 2 STT-injection assertions to expect the labelled payload; +1 dedicated helper test).
- Tests: +1 new (helper) / 2 updated (STT-injection assertions) / 0 removed.
- Behavioural delta: STT-only transcripts injected into the agent are now prefixed with an untrusted-content warning by default (opt-out via env). Full-realtime mode is unchanged (it never injected the transcript as text).

## Operator-takeaway

Voice input to a managed agent is now framed as untrusted transcribed speech, not
as trusted instructions, closing a latent prompt-injection surface that an
overheard/crafted utterance could otherwise exploit. It's a default-on, non-breaking
label with a simple env opt-out; the operator still hears/sees their own commands and
the agent still acts on them. Harry's broader steer (label caco audio transcribe
stderr + scratchpad reads too) is captured for the cacophony side in bd-4c9c3d.
