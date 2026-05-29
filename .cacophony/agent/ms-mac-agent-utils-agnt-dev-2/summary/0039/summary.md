# Session summary — Confirmed app automation snapshot cleanup apply tool

## Goal

Add a safe executable companion to the existing dry-run app automation snapshot cleanup planner.

## Bead(s)

- `bd-145135` — Add confirmed app automation snapshot cleanup apply tool

## Before state

- `app_automation_snapshots_cleanup_plan` could identify old readable snapshot artifacts.
- There was no bounded apply tool; cleanup required manual filesystem deletion.
- `keepLatest: 0` was effectively impossible because `Number(keepLatest) || 20` coerced zero back to the default.

## After state

- Added `applySnapshotCleanup()` in `extensions/app-automation/artifacts.js`.
  - Reuses `planSnapshotCleanup()`.
  - Deletes only candidate artifacts returned by the planner.
  - Revalidates each candidate through state-root containment before unlinking.
  - Never deletes protected `latest-run.json` / `auth-required.json` artifacts because the planner excludes them from candidates.
  - Returns deleted/failed lists and counts.
- Added `renderSnapshotCleanupApply()` for concise deletion summaries.
- Added Pi tool `app_automation_snapshots_cleanup_apply`.
  - Requires `confirmed=true`; otherwise returns the cleanup plan as dry-run guidance.
  - Supports `app` and `keepLatest` params.
- Fixed cleanup planning/tool calls to preserve explicit `keepLatest: 0` via nullish defaulting.

## Diff summary

- Code/content commit: 0f69902.
- Files touched:
  - `extensions/app-automation/artifacts.js`
  - `extensions/app-automation.js`
  - `test/app-automation.test.js`

## Validation

- `node --test test/app-automation.test.js` — pass, 58 tests.
- `npm run docs:check` — pass.
- `git diff --check` — pass.
- `npm test` — pass, 330 tests.

## Operator-takeaway

Agents can now safely inspect snapshot cleanup candidates and then delete them with an explicit confirmed tool call, without hand-deleting files under the app automation state root.
