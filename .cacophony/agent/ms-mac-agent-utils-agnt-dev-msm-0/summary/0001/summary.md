# Session summary — document gpt-realtime-2 GA/proxy workaround + test pr_auto_merge

## Goal

Document the bd-0b40ce finding (a LiteLLM-style proxy beta-routes the GA-only
gpt-realtime-2 model, causing an "only available on the GA API" rejection; the
fix is the direct-Azure path) as a troubleshooting note in the realtime docs,
and use this small doc change to definitively test whether `--mode pr_auto_merge`
now dispatches a PR on agent-utils post daemon restart (1.2.1472). agent-utils
has no branch protection, so it may succeed where cacophony's strict-policy path
fails (bd-dc8d45).

## Bead(s)

- `bd-0b40ce` — gpt-realtime-2 GA connect tracker (documents the workaround; bead stays open as the connect-verification tracker).
- Operator context: Harry's repeated push to prefer pr_auto_merge / PR-based reintegration.

## Before state

- Failing tests: none (suite green at 1103; 4 green CI checks).
- docs/realtime-agent.md had no troubleshooting note for the GA-rejection.
- Daemon restarted to 1.2.1472; pr_auto_merge dispatch untested on agent-utils since restart; all recent landings direct squash.

## After state

- Failing tests: none. `npm run check` green (workflows lint + docs inventory).
- docs/realtime-agent.md gains a "Troubleshooting: gpt-realtime-2 rejected as only available on the GA API" subsection.
- pr_auto_merge dispatch result on agent-utils: recorded in the reintegration receipt for this session.

## Diff summary

- Code/content commits: pending final squash/PR SHA from the reintegration receipt.
- Files touched: docs/realtime-agent.md (one new troubleshooting subsection).
- Tests: +0 / -0 (doc-only).
- Behavioural delta: none in code; documents the GA/proxy workaround. Reintegration mode pr_auto_merge is exercised as a live test of the PR landing path.

## Operator-takeaway

Doubles as the empirical pr_auto_merge test Harry wanted: agent-utils has no
branch protection, so unlike cacophony it should not hit "base branch policy
prohibits the merge". Whether this lands as a real PR or falls back to direct is
the answer to whether PR mode is usable on agent-utils today.
