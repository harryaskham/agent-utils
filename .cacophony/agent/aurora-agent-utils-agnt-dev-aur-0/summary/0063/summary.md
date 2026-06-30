# Session summary — /rt-doctor WebSocket impl indicator (bd-828f2d)

## Goal
Follow-up to bd-777edf: the global-WebSocket fallback engages silently. Surface which
WebSocket implementation loaded ('ws' package vs Node built-in fallback) in /rt-doctor so
an operator can confirm at a glance which path a connection used — especially valuable
because the fallback couldn't be live-tested on Termux.

## Change
- realtime-ws-fallback.js: add set/getRealtimeWebSocketImplKind (module flag).
- realtime-agent.js getRealtimeWebSocketConstructor: record "ws" on import success,
  "global-fallback" when it falls back to the adapter.
- realtime-status.js diagnosticLines: new `webSocket: <impl>` line (reads the getter; the
  status module already imports only leaf modules, so no circular import).
- +1 round-trip test; verified diagnosticLines emits the line. Full suite 1147 green.

## Operator-takeaway
`/rt-doctor` now shows e.g. `webSocket: global-fallback (Node built-in WebSocket)` or
`ws (package)`, so on a Pi without the 'ws' package you can confirm the bd-777edf fallback
engaged.
