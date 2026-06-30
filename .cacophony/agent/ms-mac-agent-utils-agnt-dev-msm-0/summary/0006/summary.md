# Session summary — doc PI_CASCADE_SPEAK_VOICE + pr_auto_merge canary

## Goal

Document the undocumented PI_CASCADE_SPEAK_VOICE speak-tool voice override, and
use this small landing as the agent-utils pr_auto_merge CANARY now that the
ms-mac daemon updated to 1.2.1474 (past 2urj's PR-mode fix 6486998a7) — to verify
--mode pr_auto_merge now opens a real PR (the fleet-cutover unblock signal).

## Bead(s)

- No implementation bead — operator-context canary + doc fix (fleet pr_auto_merge verification).

## Before state

- Failing tests: none (1113 green). PI_CASCADE_SPEAK_VOICE read by resolveSpeakToolParams but undocumented.
- pr_auto_merge fell back to direct on the pre-fix daemon (1.2.1473).

## After state

- Failing tests: none. docs note for PI_CASCADE_SPEAK_VOICE added.
- Reintegration mode/pr_url recorded in the receipt = the canary result.

## Diff summary

- Files touched: docs/realtime-agent.md (one line).
- Tests: +0. Behavioural delta: none (doc).

## Operator-takeaway

This landing's reintegration receipt is the pr_auto_merge canary: pr_url set +
mode=pr_auto_merge means PR-mode now works on the updated daemon (fleet unblocked);
mode=direct fallback means still broken.
