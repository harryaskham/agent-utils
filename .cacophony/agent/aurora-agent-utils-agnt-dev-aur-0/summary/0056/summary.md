# Session summary — fix slash-command crash (bd-53da92)

## Goal

Restore the harness: bd-9c9877 (force-agent-speech) crashed ALL slash commands with
"startsWith is not a function". Land the fix urgently.

## Bead(s)

- `bd-53da92` — [broken-on-main] force-agent-speech crashes ALL slash commands
  (registerCommand single-object misuse) (bug; landing).

## Before state

- Every slash command (/rt, /stt, etc.) throws "startsWith is not a function".
  force-agent-speech registered a command with a non-string name.

## After state

- /force-speech uses the correct two-arg pi.registerCommand("force-speech", {...});
  slash commands work. Test mock corrected to the real (name, def) signature.

## Diff summary

- Code/content commit: pending final squash SHA.
- Summary artefact: intentionally omitted.
- Files: extensions/force-agent-speech.js (two-arg registerCommand),
  test/force-agent-speech.test.js (mock signature fix).
- Tests: 0 net (mock fixed); force-agent-speech 8 green.
- Behavioural delta: slash commands no longer crash.

## Operator-takeaway

A single extension registering a command with the wrong API shape (a {name} object
instead of (name, def)) took down EVERY slash command. The test mirrored the wrong
shape so it didn't catch it — follow-up: a strict cross-extension load test that
validates registerCommand is called with a string name.
