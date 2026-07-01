# Session summary — voiced real-agent loop via /rt speak-replies (bd-095b3d)

## Goal

Harry field-tested cascade n=1 and found it ran a stateless background completion,
not his real agent (no tools/session). Make n=1 a GENUINE voiced agent: his speech
drives his actual Pi agent (tools/MCP/history) and its reply is spoken back — plus
an opt-in to voice thinking summaries, all durable in settings.json.

## Bead(s)

- `bd-095b3d` — Cascade n=1 should drive the REAL Pi agent session, not a
  stateless completion (follow-up to bd-15beec).

## Before state

- /rt stt local-vad already fed operator speech to the REAL agent via
  sendUserMessage (tools/history), but the agent's REPLY was not auto-spoken
  except via force-agent-speech (daemon precis) — no fast direct-Azure auto-speak.
- A pinned `model=` cascade peer took the raw chat-completions path (context-free).
- Suite: 1164 -> 1172 (post bd-b45224).

## After state

- `/rt speak-replies on` auto-speaks the real agent's replies via the fast
  direct-Azure path (cascade voice) on the `agent_end` event. `/rt speak-thinking
  on` also voices reasoning summaries (opt-in). Both durable in settings.json
  (agentUtils.realtime.speakReplies/.speakThinking), env > persisted > default,
  never clobbered. Architecture: n=1 voice loop = stt local-vad + speak-replies;
  cascade = group-chat layer on top.
- Suite: 1176 green (+12), npm run check clean.

## Diff summary

- Code/content commit: 46e6db7 (pending final squash SHA from reintegration receipt).
- Files: extensions/lib/realtime-tts-batch.js (assistantReplyText,
  pickLastAssistantReply, thinkingSummaryText), extensions/lib/realtime-config.js
  (speakReplies/speakThinking env>persisted>default), extensions/lib/realtime-settings.js
  (persisted fields + registry rows), extensions/realtime-agent.js (agent_end
  auto-speak hook, setters, snapshot, /rt verbs, usage), test/realtime-tts-batch.test.js,
  test/realtime-settings.test.js, docs/realtime-agent.md.
- Tests: +12 (text extractors + dedupe; speakReplies/speakThinking precedence).
- Behavioural delta: opt-in voiced real-agent loop; off by default; no change when off.

## Operator-takeaway

n=1 is now a genuine voiced agent: `/rt stt local-vad` + `/rt speak-replies on`
= talk to your real Pi agent (your tools/history) by voice. speak-thinking is an
opt-in extra. Confirmed speed maps to Azure `<prosody rate>` (1.2 -> +20%).
Open question captured as a draft: whether Pi surfaces reasoning-summary text in
the agent_end message (thinkingSummaryText extracts it if present, no-op if not).
