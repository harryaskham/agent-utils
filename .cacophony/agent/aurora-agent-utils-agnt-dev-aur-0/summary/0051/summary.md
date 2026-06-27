# Session summary — test /rt energy= live-applied behavior (bd-a3ce77)

## Goal

Cover the last untested branch of the /rt energy= knob: applying the threshold
change LIVE to a running local-vad session.

## Bead(s)

- `bd-a3ce77` — local-vad: test /rt energy= live-applied-to-running-session
  behavior (task; landed).

## Change

Behavioral wiring test via the capture/transcribe seam: 0.03-RMS speech commits at
the 0.012 default; after /rt energy=0.5 the same speech no longer commits (now
sub-threshold), proving applyLocalVadEnergy updated the running segmenter live.
+1 test; full suite 1016 green; check green.

## Diff summary

- Code/content commit: pending final squash SHA.
- Summary artefact: intentionally omitted.
- Files: test/realtime-agent.test.js (+1).
- Behavioural delta: none (test-only).

## Operator-takeaway

The /rt energy= knob is now covered end-to-end including the live-apply path.
