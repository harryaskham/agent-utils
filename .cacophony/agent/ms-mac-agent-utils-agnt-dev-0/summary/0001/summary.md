# Session summary — Set operator realtime defaults for /rt and /stt

## Goal

Operator (Harry) requested that the realtime shortcuts default to: audio
backend `pulse`, Pulse server `sgu24:4713`, and VAD listening on start — for
both the `/rt` and `/stt` commands.

## Bead(s)

- None (direct operator instruction; no tracked bead).

## Before state

- `setEnvDefault("PI_RT_AUDIO_BACKEND", "pulse")` already set backend=pulse.
- Bare `/rt` already defaulted to `start` -> listenMode `vad`.
- Bare `/stt` (and `/rt stt`) already defaulted to `sttOnly` + listenMode `vad`.
- No PULSE_SERVER default — the network server had to be set manually each
  session via `/rt server=...` or the PULSE_SERVER env var.

## After state

- Added `setEnvDefault("PULSE_SERVER", "sgu24:4713")` so the pulse backend uses
  the operator's server by default. Non-clobbering: an explicit PULSE_SERVER
  env or runtime `/rt server=...` override still wins.
- Backend=pulse and VAD-on-start confirmed as the existing defaults for both
  `/rt` and `/stt` (no behavioural change needed there).
- Updated REALTIME_USAGE to document the operator defaults and use sgu24:4713
  in the env-style example.

## Diff summary

- Files: extensions/realtime-agent.js (PULSE_SERVER default + usage doc),
  test/realtime-agent.test.js (+1 test for the non-clobbering PULSE_SERVER
  default).
- Tests: 477 -> 478, 0 failing.
- Behavioural delta: `/rt` and `/stt` now connect to Pulse at sgu24:4713 by
  default with backend=pulse and VAD listening on start, unless overridden.

## Operator-takeaway

`/rt` and `/stt` now come up with your preferred audio path out of the box:
pulse backend, server sgu24:4713, VAD on start. Override per-session with
`/rt server=<host:port>` or PULSE_SERVER when you want a different sink.
