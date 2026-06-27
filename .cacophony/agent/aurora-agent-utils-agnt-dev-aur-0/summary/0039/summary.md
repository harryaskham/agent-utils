# Session summary — /rt stt local-vad live wiring (bd-9399e7, final)

## Goal

Complete the operator-signed-off local-vad feature: the live /rt stt local-vad
mode, on top of the two previously-landed tested building blocks. Operator
approved proceeding (choice-019f0624 + choice-019f065b).

## Bead(s)

- `bd-9399e7` — realtime: wire live /rt stt local-vad mode (feature; wiring
  complete, pending operator mic/Pulse validation).

## Before state

- Parts 1+2 landed: LocalVadController + config (8 tests) and transcribePcmBuffer
  + buildSttBatchArgs (4 tests). No live mode wired.

## After state

- extensions/realtime-agent.js: self-contained, opt-in local-vad runtime
  (startLocalVad/stopLocalVad/localVadStatusLine), ISOLATED from the WebSocket
  session: local capture -> LocalVadController (transcribe=transcribePcmBuffer,
  insertPartial=realtime-status widget, sendTurn=pi.sendUserMessage). Command
  surface: /rt stt local-vad; /rt stt stop + /rt stop also stop it; /rt doctor
  reports it; REALTIME_USAGE updated. PI_RT_LOCAL_VAD_* knobs. Existing modes
  untouched. Full suite 879 green (usage-string test updated). npm run check green.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Summary artefact commit: intentionally omitted (no self-reference).
- Files touched: extensions/realtime-agent.js (+local-vad wiring + imports),
  test/realtime-agent.test.js (usage-string assertion updated).
- Tests: +0 net new (the +12 lib tests landed in parts 1+2); 1 assertion updated.
- Behavioural delta: net-new opt-in /rt stt local-vad mode; zero change to
  existing realtime/STT modes.

## Operator-takeaway

The full feature is wired and the whole suite is green, but the live
capture->stt->insert/send path is NOT verifiable without a mic/Pulse + the stt
binary on real audio — it needs Harry's end-to-end validation, as the bead always
specified. The verifiable engineering (segmentation orchestration + batch
transcribe) is unit-tested; the ctx glue follows existing realtime patterns and is
isolated/opt-in so it cannot affect the working WebSocket modes. If validation
surfaces issues, they will be localized to the new mode.
