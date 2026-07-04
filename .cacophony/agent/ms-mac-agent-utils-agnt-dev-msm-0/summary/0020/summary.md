# Session summary — ws-surface contract test (bd-72c993)

## Goal

Guard against the bd-5b816a class of "fallback WS adapter lacks method X" crashes by
adding a contract test that drives the fallback adapter through the exact call surface
the realtime code uses.

## Bead(s)

- `bd-72c993` — reflect draft (from bd-5b816a) promoted + done. P3, testing/DX.

## Before state

- The fallback adapter had a `.off/.removeListener` test, but no consolidated "surface
  contract" enumerating every method realtime-agent.js calls, nor an end-to-end drive
  of the exact recvOnce register+cleanup lifecycle. The missing .off (bd-5b816a) had
  slipped through to a live pi crash.

## After state

- test/realtime-ws-fallback.test.js: REQUIRED_WS_SURFACE = [on, once, off,
  removeListener, send, close] + a test asserting the fallback adapter provides each,
  and a test driving recvOnce's shape (once message/close/error -> off all three, no
  throw, all removed) + on() persistence. Test-only; suite green.

## Diff summary

- Test-only commit (pending final squash SHA).
- File: test/realtime-ws-fallback.test.js.

## Operator-takeaway

Any method the realtime code calls on the ws is now guaranteed present on the fallback
adapter by a cheap contract test — closes the bd-777edf/bd-5b816a lineage of git-checkout-only
fallback crashes. Cleared one of my reflect drafts while the board was empty; board otherwise
clear, connect still GA-rejects (bd-0b40ce held).
