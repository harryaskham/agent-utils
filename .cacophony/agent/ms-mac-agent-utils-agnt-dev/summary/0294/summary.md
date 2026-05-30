# Session summary — Unit tests for realtime-status diagnostics formatters

## Goal

Continue per-slice test-health coverage of the realtime-agent extraction:
agnt-dev-2's slice 15 added lib/realtime-status.js (4 status/diagnostics
formatters). Add coverage (operator directive: health, no new features).

## Bead(s)

- `bd-5b3718` — [health] Add unit tests for realtime-status diagnostics formatters
- (complements agnt-dev-2's `bd-e1914a` slice 15, main 5381329)

## Before state

- lib/realtime-status.js (realtimeNextStepHint, micCaptureSummary,
  realtimeContextDiagnostics, realtimeContextDiagnosticLine) had ZERO direct
  tests.
- JS tests: 431.

## After state

- Added test/realtime-status.test.js (node:test, 7 tests): next-step hint state
  machine (mic ptt/buffer, connected/connecting, sttOnly, idle); mic capture
  summary (inactive / waiting-at-0-bytes / active); context diagnostics defaults
  (128k window, 16,384 reserve, thresholdPct), realtime-model window override +
  settingsManager reserve/keep, non-realtime model ignored, token estimates when
  messages present; the diagnostic line in both estimate:n/a and populated
  (full/summary + keep segment) variants. Expected strings built via
  toLocaleString to stay locale-safe.
- JS tests: 438 (all green).

## Diff summary

- Code/content commits: pending final squash SHA from reintegration receipt.
- Files touched: test/realtime-status.test.js (new). No product code changed.
- Tests: +7; behaviour-preserving characterization.
- Behavioural delta: none; coverage only.

## Operator-takeaway

The realtime status panel's context-window diagnostics are now pinned —
including the compaction threshold math (window minus reserve), the default-vs-
model-provided window selection (non-realtime models are correctly ignored), and
the estimate:n/a fallback when no messages are available. These percentages and
thresholds drive operator-visible compaction decisions, so locking their format
guards against silent drift.

## Embedded artefacts

- none
