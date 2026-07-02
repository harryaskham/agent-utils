# Session summary — fix ws.off crash on the fallback WebSocket (bd-5b816a)

## Goal

Harry hit a pi-crashing `TypeError: ws.off is not a function` running the voice
helper (hchat). Root-cause and fix it so the realtime probe/connect/cleanup path
no longer crashes pi on hosts that use the fallback WebSocket.

## Bead(s)

- `bd-5b816a` (P1) — pi crashes: ws.off is not a function; GlobalWebSocketAdapter
  (undici fallback) lacked .off, so recvOnce cleanup threw.

## Before state

- extensions/lib/realtime-ws-fallback.js GlobalWebSocketAdapter shimmed .on/.once
  (via addEventListener) but had NO .off. recvOnce registers with once() and
  cleans up with off("message"/"close"/"error") — so on a Pi where the 'ws'
  package is unresolvable (git-checkout install, bd-777edf) the first realtime
  message/close/error fired cleanup -> ws.off -> uncaughtException -> pi exits.
- Suite 1176.

## After state

- Adapter tracks a { type, cb, installed } listener registry; .off/.removeListener
  removeEventListener the exact installed wrapper (add/removeEventListener are
  identity-based, and _wrap builds a fresh fn per call); once() forgets its entry
  after firing. No behavioural change on the 'ws'-package path.
- test/realtime-ws-fallback.test.js: FakeWS gains removeEventListener; +1 test
  (off removes a once listener before dispatch; a live once still unwraps
  event.data; recvOnce's once+off shape does not throw). Suite 1176 green,
  npm run check clean.

## Diff summary

- Code/content commit: (pending final squash SHA from reintegration receipt).
- Files: extensions/lib/realtime-ws-fallback.js (registry + .off/.removeListener),
  test/realtime-ws-fallback.test.js (+removeEventListener harness, +1 test).

## Operator-takeaway

The hchat crash is fixed. Note: local-vad itself is websocket-free — the realtime
connect Harry saw ("Connecting realtime: gpt-realtime-2") came from a probe/doctor
path, not from `/rt stt local-vad`; that path is now crash-safe too. Reaches Harry
on next `pi update --extensions`.
