# Session summary — /rt probe: one-shot realtime connect-probe doctor

## Goal

Turn the passive realtime doctor hints into an ACTIVE connectivity self-test, so
gpt-realtime-2 + proxy/endpoint changes can be verified without starting a mic
session. My own greenlit improvement plan from the idle-plan batch.

## Bead(s)

- `bd-c3ac07` — /rt doctor: live connect-probe classifying GA/1006/auth.
- Builds on landed: GA-error hint f765be5, 1006-before-session.created bd-d0124f.

## Before state

- Failing tests: none. The doctor surfaced only PASSIVE hints from prior errors;
  no way to actively test connectivity short of a full /rt start (mic session).

## After state

- Failing tests: none. realtime-agent 65/65; full suite green; npm run check green.
- New non-destructive `probeConnect()` + `/rt probe` (and `action=probe`): opens
  the realtime WS, waits for session.created, closes — classifying connected /
  ga-only / session-start-1006 / auth / config / server-error / timeout, reusing
  the GA + 1006 + auth classifiers. Uses a local ws, never touches the live
  session. +1 test (4 outcomes), doc note in docs/realtime-agent.md.

## Diff summary

- Code/content commit: pending final squash SHA from the reintegration receipt.
- Files: extensions/realtime-agent.js (probeConnect + controls.probe + /rt probe
  verb + action dispatch), docs/realtime-agent.md (probe note), test/realtime-agent.test.js (+1).
- Tests: +1. Behavioural delta: active connectivity probe; no change to connect path.

## Operator-takeaway

`/rt probe` gives a fast, key-aware, mic-free yes/no on realtime connectivity
with a precise failure class — directly useful to confirm whether the
gpt-realtime-2 azure default + proxy GA fix actually connect. Lands direct (PR
mode still pending daemon restart).
