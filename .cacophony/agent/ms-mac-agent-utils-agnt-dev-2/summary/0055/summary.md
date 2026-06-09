# Session summary — true-defaults preserves runtime model changes

## Goal

The operator reported that the true-defaults extension was reverting runtime
model switches (e.g. switching to claude-opus-4.8 got yanked back to the
configured default claude-fable-5.0 within seconds). Make runtime/temp model and
effort changes survive continuing sessions.

## Bead(s)

- `bd-ea040a` — true-defaults: preserve runtime model changes on continuing sessions (reload/resume/fork)

## Before state

- Failing tests: none (suite 587 green).
- `session_start` unconditionally called `applyRuntimeDefaults` -> `pi.setModel`
  with the true default; `session_shutdown` re-persisted defaults on
  reload/resume/fork too. A runtime model switch (which triggers reload/resume)
  was reverted.

## After state

- Failing tests: none. true-defaults file 9 tests (+2 regression); full suite 589 green.
- true-defaults seeds the default only on FRESH session starts (startup/new) and
  re-persists only on clean end (quit/new). Continuing reasons
  (reload/resume/fork) preserve runtime/temp model + effort changes.

## Diff summary

- Code/content commits: pending final squash SHA from reintegration receipt
- Files touched: `extensions/true-defaults.js`, `test/true-defaults.test.js`
- Tests: +2 / -0
- Behavioural delta: runtime model/effort switches now survive reload/resume/fork;
  the persisted true default still governs the next fresh launch.

## Operator-takeaway

true-defaults guards the *persisted* default for fresh launches; it no longer
re-asserts that default on a continuing session, so an operator `/model` switch
sticks for the working session.
