# Session summary — Bound copilot-auth-refresh retry to stop reply storms

## Goal

The operator reported that a "GitHub Copilot auth was refreshed... Retry the
previous request now:" message was being repeatedly injected into the agent
conversation, causing reply storms that fill the context window. The goal was
to find the source and make the auth-refresh retry bounded so it stops
re-injecting after a few attempts instead of looping.

## Bead(s)

- `bd-364a68` — copilot-auth-refresh extension injects unbounded retry user-messages -> reply storm / context fill (agent-utils)
- (initial mis-scoped filing `bd-46cb54` in cacophony was superseded; root cause is this project's plugin, not the core harness)

## Before state

- Failing tests: none (suite green at 460)
- `extensions/copilot-auth-refresh.js` `agent_end` hook injected a
  `pi.sendUserMessage` retry on every github-copilot missing-API-key error.
- Dedup guard keyed on `${timestamp}:${retryText}`; successive failures carry a
  fresh assistant-error timestamp, so the guard passed every time -> unbounded
  re-injection (reply storm, context fill).
- No bounded retry budget existed.

## After state

- Failing tests: none (suite green at 462, +2 new regression tests)
- Added `MAX_COPILOT_AUTH_RETRIES = 2` and a retry budget keyed on the stable
  retry text. After the cap, a single terminal error notify is emitted instead
  of another injected user message. Budget resets when the request text changes.
- Existing exact-duplicate guard preserved.

## Diff summary

- Code/content commit: 6097d89 (final landed squash SHA will come from the reintegration receipt)
- Files touched: extensions/copilot-auth-refresh.js, test/copilot-auth-refresh.test.js
- Tests: +2 (distinct-timestamp storm bounding; budget reset on request-text change); suite 460 -> 462
- Behavioural delta: copilot auth retry injections are now capped per request instead of unbounded, eliminating the reply-storm / context-fill failure mode.

## Operator-takeaway

The reply storm was NOT a core-harness bug — it was this project's own Pi
extension re-injecting an auth-retry user message on every transient copilot
auth failure, with a dedup key (timestamp+text) that never matched across
genuine retries. The fix bounds retries per underlying request (cap 2) and
surfaces one terminal notice on exhaustion. If copilot auth genuinely stays
broken, the agent now sees a single error rather than an endless retry loop.
