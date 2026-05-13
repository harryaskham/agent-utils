# Session summary — run `/update` from home

## Goal

Ensure Pi's `/update` command and `pi_self_update` tool run `pi update` from the user's home directory rather than inheriting an arbitrary project Git checkout as the working directory.

## Bead(s)

- `bd-1af5c0` — Run Pi self-update from home directory

## Before state

- Failing tests: none in repository.
- Relevant metrics: full suite was 109/109 before this patch.
- Context: `/update` inherited the current Pi/session cwd. The operator observed that running it from inside a Git repository did not fully update the home-directory agent package state.

## After state

- Failing tests: none observed.
- Relevant metrics: after rebase, `npm test -- test/pi-self-update.test.js` passed 10/10 and `npm run docs:check` passed.
- Context: both the slash command and tool paths call `pi update` with `cwd` set to `os.homedir()`. The spawn fallback also sets `cwd` to home. Dry-run output reports that update would run from the home directory.

## Diff summary

- Commits: `a43e580`
- Files touched: `extensions/pi-self-update.js`, `test/pi-self-update.test.js`
- Tests: +1 cwd regression test and updated `/update` success test to assert the home-directory notification and exec cwd.
- Behavioural delta: `/update` is now independent of the current project checkout and should update the home package state consistently.

## Operator-takeaway

The updater no longer depends on where Pi was launched or which Git repo you are sitting in; `pi update` is always invoked from `$HOME`.
