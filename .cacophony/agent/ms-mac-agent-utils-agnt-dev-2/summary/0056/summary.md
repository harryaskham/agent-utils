# Session summary — Release v1.2.2

## Goal

Ship the true-defaults runtime-model fix promptly as a patch release.

## Bead(s)

- `bd-503a76` — Release v1.2.2 (true-defaults runtime model fix)

## Before state

- Failing tests: none. Suite 589 green. package.json 1.2.1.

## After state

- Failing tests: none. Suite 589 green; docs + fmt clean. package.json 1.2.2;
  annotated tag v1.2.2 to be published at the landed release commit.

## Diff summary

- Code/content commits: pending final squash SHA from reintegration receipt
- Files touched: `package.json`
- Tests: +0 / -0
- Behavioural delta: version bump only.

## Operator-takeaway

v1.2.2 ships the true-defaults fix so runtime model switches stick mid-session.
