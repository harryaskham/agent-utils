# Session summary — Consolidate bounded external calls; close the TTS-batch timeout gaps (bd-29a134)

## Goal

Follow-up from the bd-6cf0d6 subprocess/HTTP timeout audit. msm-0 landed bd-6cf0d6
scoped to web-search's fetch, but the audit I ran surfaced two remaining untimed
external awaits in the cascade-TTS batch path that can hang the "speaking" state
forever (the bd-adde03 hang shape). This session closes those gaps and, per the
original draft's suggestion, consolidates the timeout/kill/error-surface pattern
into one shared library so it is not re-implemented per call site.

## Bead(s)

- `bd-29a134` — [realtime-tts] bound synthesizeToPcm subprocess and synthesizeAzureSpeechDirect HTTP with timeouts (I filed it from the bd-6cf0d6 audit)
- context: `bd-6cf0d6` (msm-0's web-search timeout fix, fc233b7), `bd-adde03` (the original STT hang + timeout precedent)

## Before state

- Failing tests: none (baseline green).
- `extensions/lib/realtime-tts-batch.js` on main had two untimed awaits:
  - `synthesizeToPcm` spawned the `tts` subprocess with only close/error handlers, NO timeout — a stalled child never settles the Promise.
  - `synthesizeAzureSpeechDirect` did a plain `await doFetch(...)` with no AbortController/signal.
- The timeout pattern was duplicated: STT batch (`transcribePcmBuffer`) had its own inline spawn+timeout+SIGTERM/SIGKILL; msm-0's `combineTimeoutSignal` lived in `web-search-http.js`.
- Two `spawnSync` probes (realtime-status `commandAvailable`, realtime-agent ffmpeg device list) had no `timeout` option.

## After state

- Failing tests: none. Full suite: 1236 tests, 1231 pass, 0 fail, 5 pre-existing skips. `npm run check` clean.
- New `extensions/lib/bounded-exec.js` is the ONE home for bounded external calls:
  - `runBoundedSubprocess({ command, args, spawnImpl, stdio, timeoutMs, label, killGraceMs, onSpawn, setTimer, clearTimer })` — spawn + stdout/stderr Buffer collection + hard timeout (SIGTERM then unref'd SIGKILL grace) + finish-once. Injectable timers for deterministic tests (msm-0's suggestion).
  - `combineTimeoutSignal` / `resolveRequestTimeoutMs` / `DEFAULT_REQUEST_TIMEOUT_MS` (moved from web-search-http.js).
- `synthesizeToPcm` and `transcribePcmBuffer` both use `runBoundedSubprocess`; `synthesizeAzureSpeechDirect` uses `combineTimeoutSignal`. TTS timeout is env-overridable via `PI_RT_TTS_TIMEOUT_MS` (default 30s, 0 = off).
- `web-search-http.js` is a thin re-export shim, so `web-search.js` + `test/web-search.test.js` are untouched.
- Both `spawnSync` probes now pass a `timeout` (2s / 5s); a timed-out probe returns non-zero/empty rather than blocking.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched:
  - NEW `extensions/lib/bounded-exec.js` — shared runBoundedSubprocess + combineTimeoutSignal/resolveRequestTimeoutMs.
  - `extensions/web-search-http.js` — now re-exports from ./lib/bounded-exec.js (thin shim).
  - `extensions/lib/realtime-stt-batch.js` — transcribePcmBuffer migrated to runBoundedSubprocess (behavior-preserving; -~40 lines).
  - `extensions/lib/realtime-tts-batch.js` — resolveBatchTtsTimeoutMs + PI_RT_TTS_TIMEOUT_MS; synthesizeToPcm bounded via runBoundedSubprocess; synthesizeAzureSpeechDirect bounded via combineTimeoutSignal (+ signal passthrough).
  - `extensions/lib/realtime-status.js`, `extensions/realtime-agent.js` — spawnSync timeouts.
  - NEW `test/bounded-exec.test.js` (runBoundedSubprocess: resolve/non-zero/spawn-throw/error-event/onSpawn-throw/timeout+SIGKILL via fake timers/no-timer).
  - `test/realtime-tts-batch.test.js` — synthesizeToPcm timeout+kill, timeout-disabled, synthesizeAzureSpeechDirect HTTP timeout, incoming-cancel-vs-timeout.
- Tests: +13 (9 bounded-exec, 4 tts); STT/web-search tests unchanged and green.
- Behavioural delta: TTS subprocess + HTTP awaits are now bounded; STT behavior identical; one shared timeout implementation across web-search/STT/TTS.

## Operator-takeaway

msm-0's bd-6cf0d6 close note ("no await can hang") was slightly overclaimed — the
cascade-TTS batch paths were still exposed. This closes them AND does the
consolidation the original draft asked for: there is now one `bounded-exec.js`
that both the subprocess and HTTP timeout patterns live in, so the next external
call has an obvious, tested home and the gap is less likely to reappear. Good
cross-node coordination with msm-0 (they invited the shared-lib generalization
and the injectable-timer seam).
