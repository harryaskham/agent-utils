# Session summary — stale-only app automation refresh

## Goal

Add a one-shot stale-only refresh path for the standard Slack, Outlook mail/calendar, and Teams snapshot bundle so agents can refresh missing or stale app state without rerunning fresh apps.

## Bead(s)

- `bd-bc81b3` — Add stale-only app automation refresh run
- parent: `bd-2fc6bf` — Build configurable app automation surface for API-less web apps

## Before state

- Failing tests: none known after overview staleness landed.
- Relevant metrics: agents could check snapshot staleness and could run the full standard refresh bundle once, but there was no tool that combined those decisions to refresh only stale/missing apps.
- Context: Harry continued the Slack/Outlook/calendar/Teams build loop, and this slice made refresh decisions less wasteful and less likely to churn authenticated browser sessions.

## After state

- Failing tests: none from targeted validation.
- Relevant metrics: `npm test` passed 80 tests; `npm run docs:check` passed.
- Context: `app_automation_refresh_stale_run_once` checks staleness for standard refresh-bundle apps, skips fresh apps, and runs or dry-runs only matching stale/missing Slack, Outlook, and Teams actions.

## Diff summary

- Commits: `a2a82a3`
- Files touched: `README.md`, `docs/app-automation.md`, `docs/index.html`, `docs/tools.json`, `extensions/app-automation.js`, `test/app-automation.test.js`
- Tests: packaging/source assertions updated for the stale refresh tool; no tests removed or flipped.
- Behavioural delta: agents can now choose full refresh, dry-run refresh, or stale-only refresh for the standard work-app bundle.

## Operator-takeaway

Use `app_automation_refresh_stale_run_once` when the overview reports stale/missing work-app snapshots and you want to avoid touching already-fresh Slack, Outlook, or Teams state.
