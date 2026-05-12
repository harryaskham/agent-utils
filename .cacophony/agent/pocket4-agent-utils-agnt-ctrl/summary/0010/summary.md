# Session summary — Outlook and Teams live extraction plans

## Goal

Wire Outlook and Teams notification/calendar actions to live Playwright DOM extraction plans, completing the second app automation follow-up stack for Slack, canvas, Outlook, and Teams.

## Bead(s)

- `bd-d0b4ce` — Add live Outlook and Teams extraction selectors
- parent: `bd-ee8e57` — Build configurable app automation surface for API-less web apps

## Before state

- Failing tests: none known after `bd-53d66c` landed.
- Relevant metrics: Outlook and Teams had conservative supplied-extraction snapshot examples, but no live browser open or DOM extraction plan.
- Context: Harry asked to continue driving Slack, Outlook, calendar, Teams, and related app plugins.

## After state

- Failing tests: none from targeted validation.
- Relevant metrics: `npm test` passed 77 tests; `npm run docs:check` passed.
- Context: Outlook and Teams notification/calendar actions now plan `browser.open`, Microsoft DOM extraction, and generic snapshot normalization. A shared Microsoft extractor snippet provides conservative `[aria-label]`, list item, title, and data attribute extraction filtered by action-specific patterns.

## Diff summary

- Commits: `2e2908e`
- Files touched: `docs/app-automation.md`, `extensions/app-automation.js`, `extensions/app-automation/catalog.js`, `extensions/app-automation/microsoft.js`, `test/app-automation.test.js`
- Tests: expanded Outlook/Teams tests to verify live extraction step chains and Microsoft extractor snippet; no tests removed or flipped.
- Behavioural delta: Outlook and Teams have the same high-level live extraction shape as Slack, while retaining supplied extraction fallbacks.

## Operator-takeaway

The app automation stack now has stable live-extraction action plans across Slack, Outlook, and Teams, plus live paste planning for canvas. The remaining work is no longer scaffolding but hardening selectors against real authenticated web sessions.
