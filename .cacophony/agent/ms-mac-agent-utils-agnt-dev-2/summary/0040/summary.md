# Session summary — `/tendril-app` snapshot cleanup commands

## Goal

Expose snapshot cleanup planning/apply through the `/tendril-app` command surface, matching the agent-visible cleanup tools.

## Bead(s)

- `bd-b3231a` — Add tendril-app snapshot cleanup commands

## Before state

- Agents could use tools for snapshot cleanup planning/apply, but the `/tendril-app` command surface had no cleanup commands.
- Operators using slash commands had to rely on tool-only access or manual filesystem deletion.

## After state

- Added `parseCleanupCommandArgs()`.
- Added `/tendril-app cleanup [app] [keep:<n>]`.
  - Dry-runs cleanup candidates with `renderSnapshotCleanupPlan()`.
  - Prints the explicit cleanup-apply command needed to delete candidates.
- Added `/tendril-app cleanup-apply [app] [keep:<n>] confirm`.
  - Refuses to delete without an unambiguous confirmation token.
  - Re-renders the plan in the refusal message.
  - Uses the same `applySnapshotCleanup()` safe deletion path as the tool.
- Added shortcuts:
  - `/tendril-app-cleanup`
  - `/tendril-app-cleanup-apply`
- Updated command description and source guards.

## Diff summary

- Code/content commit: 96bac82.
- Files touched:
  - `extensions/app-automation.js`
  - `test/app-automation.test.js`

## Validation

- `node --test test/app-automation.test.js` — pass, 58 tests.
- `npm run docs:check` — pass.
- `git diff --check` — pass.
- `npm test` — pass, 330 tests.

## Operator-takeaway

Cleanup can now be reviewed and applied directly from slash commands while preserving explicit-confirmation safety.
