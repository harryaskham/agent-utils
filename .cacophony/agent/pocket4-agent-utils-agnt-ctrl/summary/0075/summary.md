# Session summary — Stale threshold tokens for snapshot links

## Goal

Let agents tune freshness windows directly in `/tendril-app links` while triaging Slack, Outlook, Teams, and Calendar snapshot links.

## Bead(s)

- `bd-e226d7` — Allow `/tendril-app links` stale threshold tokens

## Before state

- Failing tests: none known.
- Relevant metrics: `/tendril-app links` always used the default 60-minute stale threshold even though the native tool accepted `staleAfterMinutes`.
- Context: daily or multi-hour collaboration scans need a wider freshness window without forcing agents to drop to the native tool call.

## After state

- Failing tests: none from final validation.
- Relevant metrics: `npm run docs:build` passed, `npm run docs:check` passed, and `npm test` passed 102 tests.
- Context: the slash-command parser now accepts `stale-after:<minutes>`, `staleafter:<minutes>`, `stale-after-minutes:<minutes>`, and `staleafterminutes:<minutes>` tokens and passes them into link freshness calculation.

## Diff summary

- Commits: `b2871cc`
- Files touched: `README.md`, `docs/app-automation.md`, `docs/tools.json`, `docs/index.html`, `extensions/app-automation.js`, `extensions/app-automation/link-command.js`, `test/app-automation.test.js`
- Tests: extended link parser coverage for `stale-after:1440`; no tests removed or flipped.
- Behavioural delta: `/tendril-app links fresh stale-after:1440 ...` now evaluates freshness against a 24-hour window instead of the fixed 60-minute default.

## Operator-takeaway

Agents can now run concise all-app collaboration link scans with custom freshness windows, e.g. `/tendril-app links fresh kind:events sort:newest stale-after:1440 limit:5 standup`.
