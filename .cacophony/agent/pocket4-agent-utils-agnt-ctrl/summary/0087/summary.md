# Session summary — Scanned counts in non-empty link headers

## Goal

Make non-empty Slack, Calendar, Outlook, Teams, and canvas snapshot-link summaries show how many artifacts were scanned, matching the empty-result behaviour.

## Bead(s)

- `bd-c8962d` — Render scanned counts in non-empty link summary headers

## Before state

- Failing tests: none known.
- Relevant metrics: empty link reports showed scanned artifact counts, but non-empty link summary headers only showed total/matched/freshness/sort/app/kind/filter labels.
- Context: users need to judge whether a link sample is broad or narrow even when it returns matches.

## After state

- Failing tests: none from final validation.
- Relevant metrics: `npm run docs:build` passed, `npm run docs:check` passed, and `npm test` passed 103 tests.
- Context: `collectSnapshotLinks` now exposes `scannedArtifactCount`, and `renderSnapshotLinks` includes `scanned=<n>` in non-empty headers.

## Diff summary

- Commits: `4525bee`
- Files touched: `README.md`, `docs/app-automation.md`, `docs/tools.json`, `docs/index.html`, `extensions/app-automation/artifacts.js`, `test/app-automation.test.js`
- Tests: updated per-app and aggregate link rendering coverage to assert `scanned=<n>` in non-empty summary headers.
- Behavioural delta: `/tendril-app links` and `/tendril-app overview links` reports now show scanned artifact counts whether links are present or absent.

## Operator-takeaway

Snapshot-link output is now consistently self-describing: total, matched, scanned, filters, and truncation are visible in the rendered summary path agents actually read.
