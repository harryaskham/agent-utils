# Session summary — Fix copilot-auth-refresh retry-budget reset (real root cause of the auth storm)

## Goal

Acting on the operator directive to "progress lanes and improve projects" with an
empty open queue, find and land a small, well-scoped in-lane agent-utils fix. The
fix that emerged addresses the real root cause of the recurring GitHub Copilot
auth-retry "reply storm" that I personally experienced again this session during a
crash/revive window.

## Bead(s)

- `bd-57477b` — copilot-auth-refresh retry budget resets every cycle because the injected retry message mutates the budget key (real root cause of the bd-efcf8d storm)
- Context: supersedes the "stale running process" framing of `bd-efcf8d` (draft) as the primary cause; the prior fix `bd-364a68` (closed) was incomplete.

## Before state

- Full suite: green at 516 tests.
- `extensions/copilot-auth-refresh.js` bounded auto-injected copilot auth retries
  with `MAX_COPILOT_AUTH_RETRIES = 2`, but keyed the budget on the raw most-recent
  user-message text. The `agent_end` handler re-injects a follow-up user message
  `"GitHub Copilot auth was refreshed... Retry the previous request now:\n\n${retryText}"`.
  On the next failure that injected message is the most-recent user message, so the
  newly-extracted text differs from the prior budget text and the counter resets to
  0 every cycle — the bound never triggers and the storm continues unbounded.
- Observed live: 6+ stacked "Retry the previous request now" injections in a single
  window in this very session.
- The existing "no storm" regression test fed a STATIC user text across failures, so
  it never exercised the real feedback loop and passed while production stormed.

## After state

- Full suite: green at 518 tests (+2 new).
- Budget now keys on the recovered underlying request via `underlyingRetryText()`,
  which strips one or more nested injection prefixes. Distinct injected timestamps
  with the same recovered request correctly cap at `MAX_COPILOT_AUTH_RETRIES`, then a
  single terminal error notify fires instead of another injection.
- New regression test simulates the true loop (failure -> capture injected text ->
  feed it back as next lastUser) and asserts the cap holds and injected messages do
  not accrete nested prefixes. Verified the test FAILS on pre-fix code and PASSES with
  the fix.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/copilot-auth-refresh.js`, `test/copilot-auth-refresh.test.js`.
- Tests: +2 (`underlyingRetryText strips ... nested injection prefixes`; `... bounds retries when the injected message feeds back as the next request (real storm loop)`). 0 flipped, 0 removed.
- Behavioural delta: copilot auth-retry injections are now genuinely bounded across the
  real injection feedback loop, not just when the underlying request text happens to be
  static. Extracted `COPILOT_RETRY_INJECTION_PREFIX` as a single source of truth.

## Operator-takeaway

The Copilot auth "reply storm" kept reappearing after the first fix because both the
original fix (bd-364a68) and the follow-up report (bd-efcf8d) assumed the retry text
was constant — but the auto-injection rewrites that text each cycle, resetting the very
budget meant to stop the storm. Reloading the process never fully fixed it. Keying the
budget on the normalized underlying request closes the loop; the new regression test
reproduces the real failure so it cannot silently regress again.
