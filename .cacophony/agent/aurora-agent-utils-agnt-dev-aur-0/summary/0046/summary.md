# Session summary — local-vad troubleshooting docs (bd-bb3603)

## Goal

Give the operator a troubleshooting reference for first-run mic/Pulse validation
of /rt stt local-vad — the docs had the command + tuning table but no
symptom->fix guidance.

## Bead(s)

- `bd-bb3603` — docs: add a local-vad troubleshooting section for first-run
  validation (task; landed).

## Before / after

- Before: docs/realtime-agent.md Local-VAD section ended at the PI_RT_LOCAL_VAD_*
  table.
- After: a "Troubleshooting (first-run validation)" block mapping symptoms
  (nothing transcribed / commit timing / missed speech or noise / echo) to the
  existing knobs, documenting the first-failure warning + /rt doctor, and noting
  the not-yet-implemented half-duplex caveat (bd-ddc391). npm run check green.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Summary artefact commit: intentionally omitted (no self-reference).
- Files touched: docs/realtime-agent.md (+1 troubleshooting subsection).
- Tests: none (pure docs); docs:check green.
- Behavioural delta: none.

## Operator-takeaway

When validating /rt stt local-vad, the docs now have a quick symptom->knob
troubleshooting table, so a silent mic, bad timing, or echo each map to a clear
next step.
