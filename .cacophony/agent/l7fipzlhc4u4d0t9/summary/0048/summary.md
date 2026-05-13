# Session summary — realtime VAD mic watchdog

## Goal

Keep full realtime calls listening reliably by restarting VAD/continuous microphone capture when the recorder process exits unexpectedly while the realtime session is still connected.

## Bead(s)

- `bd-bd92a7` — Keep realtime VAD mic alive across recorder exits

## Before state

- Failing tests: none in repository; live `/rt` showed `connected`, `mic:off`, `state.micMode:"vad"`, and no active recorder after a call segment, requiring manual restart.
- Relevant metrics: full suite was 110/110 before this patch.
- Context: recorder process exit only nulled `this.mic` and updated status; it left stale mic mode and did not restart capture even though `desiredListenMode` still requested VAD.

## After state

- Failing tests: none observed.
- Relevant metrics: after rebase, `npm test -- test/realtime-agent.test.js` passed 38/38 and `npm run docs:check` passed.
- Context: VAD/continuous modes now have a mic restart watchdog. Unexpected recorder exit clears stale mic state, updates turn detection, schedules a bounded backoff restart, and reports restart attempts in diagnostics/snapshot. Explicit `/rt-off`, `/rt-cancel`, and intentional stop paths clear the restart timer.

## Diff summary

- Commits: `2bec696`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`, `docs/realtime-agent.md`
- Tests: +1 targeted realtime test that forces the recorder command to exit and asserts stale mic state clears plus a restart is scheduled.
- Behavioural delta: full `/rt start vad` calls should recover from transient `parec`/source exits instead of silently dropping the microphone while the socket stays connected.

## Operator-takeaway

The call can now self-heal when the recorder process dies: status should no longer sit at `mic:off` with a stale VAD mode during an intended ongoing realtime call.
