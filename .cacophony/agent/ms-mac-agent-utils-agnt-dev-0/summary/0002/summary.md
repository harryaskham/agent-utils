# Session summary — Fix realtime echo-injection after the first agent turn

## Goal

Operator (Harry) reported that after the first agent turn the realtime session
frequently errors due to a "bad injection," and asked for an audit + tidy of the
realtime state machine.

## Bead(s)

- None (direct operator instruction; audit + fix).

## Root cause

The WSS history-forwarding cursor (forwardNewMessages -> forwardMessage) re-sent
every assistant message in the new tail as a conversation.item.create. The
realtime model's own replies are already present server-side in the WSS
conversation, and Pi also appends them to canonical history. The pi.on("context")
hook strips the extension's hidden RT_CUSTOM_TYPE trigger messages but not the
assistant replies, so on turn 2+ the model's own prior reply was re-injected
into the WSS — an "echo" injection it then reacted to. Tool calls were already
deduped via callIdsEmittedByModel, but assistant TEXT had no equivalent guard.

## Before state

- forwardMessage(assistant) re-sent text unconditionally; only tool_calls were
  deduped. Self-authored realtime replies were re-injected each subsequent turn.
- No tests covered the multi-turn forwarding cursor or custom-message-filter
  interaction.

## After state

- New responseIdsEmittedByModel set, populated on response finalize.
- forwardMessage skips self-authored assistant messages (matched by emitted
  response id; defensively also by provider "openai-realtime" / realtime api).
  External assistant messages still replay normally (cross-model history intact).
- The new set is cleared at every cursor-reset point: close(), session_compact /
  before_compact, model_select, and summary-mode reset — symmetric with the
  existing callIdsEmittedByModel resets.
- Added test-only __RealtimeSessionForTest export + a two-turn regression test
  proving the self-authored reply is not re-forwarded while a genuinely external
  assistant message still is.

## Diff summary

- Files: extensions/realtime-agent.js (dedup set + guard + 4 reset sites +
  finalize record + test export), test/realtime-agent.test.js (+1 regression).
- Tests: 478 -> 479, 0 failing.
- Behavioural delta: realtime no longer re-injects its own prior replies into
  the WSS after the first turn, eliminating the post-first-turn echo/error.

## Operator-takeaway

The "bad injection after the first turn" was the realtime model being fed its
own previous reply back into the live audio conversation. The forwarding state
machine now dedups self-authored assistant replies the same way it already
deduped tool calls, and the dedup state resets cleanly on close/compact/model
switch. /rt and /stt should no longer error or talk to themselves after turn 1.
