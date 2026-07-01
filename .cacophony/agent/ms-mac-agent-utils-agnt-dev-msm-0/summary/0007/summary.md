# Session summary — cascade n=1 routed through Pi inference (bd-15beec)

## Goal

Return to real agent-utils feature work (per Harry's overnight "others carry on"
directive) and land the core of bd-15beec: make a cascade `n=1` peer behave like
talking to the model already loaded in Pi, instead of a raw litellm
chat-completions call to a default model that 400'd with "no healthy deployments".

## Bead(s)

- `bd-15beec` — Cascade: route peer chat through Pi inference engine (n=1 =
  loaded Pi model), not litellm directly.

## Before state

- Cascade peer turns (`makeCascadeRunTurn` → `runChatCompletionTurn`) always
  POSTed to `/v1/chat/completions` on the proxy with `participant.model ||
  defaultModel` (gpt-5-mini). An unpinned peer therefore hit the proxy's stale
  default and could 400 (`no healthy deployments for github-copilot/...`).
- No path routed a cascade peer through Pi's own inference engine.
- Suite: 1113 green (start of session); ready queue empty.

## After state

- An UNPINNED cascade peer (no `model=`) routes through Pi's `complete()` on the
  loaded `ctx.model`, authenticated via `ctx.modelRegistry.getApiKeyAndHeaders` —
  so n=1 = the loaded Pi model, and it never touches the proxy default. A peer
  that pins `model=` keeps the direct chat-completions path.
- Suite: 1164 green (+51 vs start incl. peer landings; my +12 cascade tests),
  `npm run check` (actionlint + docs) clean.

## Diff summary

- Code/content commit: be1ad73 (pending final squash SHA from reintegration receipt).
- Files touched: extensions/lib/realtime-cascade-llm.js (piMessagesFromChat,
  extractPiReplyText, runPiInferenceTurn — lazy pi-ai import so the unit-tested
  lib resolves under bare `node --test`); extensions/lib/realtime-cascade-session.js
  (makeCascadePiInferenceTurn + makeCascadeRunTurn dispatch); extensions/realtime-agent.js
  (ensureCascadeController builds piInferenceTurn from ctx); test/realtime-cascade-llm.test.js,
  test/realtime-cascade-session.test.js; docs/realtime-agent.md.
- Tests: +12 (piMessagesFromChat, extractPiReplyText, runPiInferenceTurn,
  makeCascadeRunTurn routing, makeCascadePiInferenceTurn).
- Behavioural delta: unpinned cascade peers now answer as the loaded Pi model;
  pinned peers unchanged; no-ctx fallback keeps the old chat-completions path.

## Operator-takeaway

The n=1 "no healthy deployments" cascade failure is fixed at the routing layer:
an unpinned peer is now literally the model Pi already has loaded, via Pi's own
inference + auth, so it can't be broken by a stale proxy default. Live voice
verification (Harry's `/cascade start n=1`) and the n=2+ Pi-subagent plugin
remain follow-ups; the mandatory-voice `speak` wiring is the other open slice.
