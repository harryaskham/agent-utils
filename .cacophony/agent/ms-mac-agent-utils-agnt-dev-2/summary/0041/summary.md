# Session summary — Document app automation snapshot cleanup apply workflow

## Goal

Update app automation docs for the newly-added confirmed snapshot cleanup apply tool and `/tendril-app` cleanup commands.

## Bead(s)

- `bd-5003c7` — Document app automation snapshot cleanup apply workflow

## Before state

- `docs/app-automation.md` still described cleanup planning as dry-run only.
- The docs did not mention `app_automation_snapshots_cleanup_apply`.
- The `/tendril-app` command docs did not mention `cleanup` / `cleanup-apply` or their shortcuts.

## After state

- Exposed surfaces list now includes:
  - `app_automation_snapshots_cleanup_apply`
  - `/tendril-app cleanup [app] [keep:<n>]`
  - `/tendril-app cleanup-apply [app] [keep:<n>] confirm`
  - `/tendril-app-cleanup`
  - `/tendril-app-cleanup-apply`
- Recommended workflow now says to inspect cleanup candidates first, then use confirmed apply only after review.
- Snapshot inspection section now documents:
  - cleanup planning stays dry-run,
  - apply refuses to delete without `confirmed=true` or slash-command `confirm`,
  - only planner candidates are deleted,
  - protected latest/auth diagnostics are preserved.

## Diff summary

- Code/content commit: 6f1d21e.
- Files touched: `docs/app-automation.md`.

## Validation

- `npm run docs:check` — pass.
- `git diff --check` — pass.
- `node --test test/app-automation.test.js` — pass, 58 tests.
- `npm test` — pass, 330 tests.

## Operator-takeaway

The documented app automation workflow now matches the implemented cleanup tool/command behavior and no longer implies cleanup is plan-only.
