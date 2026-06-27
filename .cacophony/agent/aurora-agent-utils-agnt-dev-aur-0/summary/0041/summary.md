# Session summary — local-vad batch stt model decoupling (bd-84bbf7)

## Goal

Second issue from continued critical self-review of the bd-9399e7 local-vad wiring
before operator mic validation: the batch REST stt call was using the realtime
WebSocket transcription model.

## Bead(s)

- `bd-84bbf7` — local-vad: use a batch stt model (PI_RT_LOCAL_VAD_MODEL/
  mai-transcribe-1.5), not the realtime WebSocket model (bug; landed).

## Before state

- startLocalVad passed config.transcriptionModel (realtime model; default
  whisper-1, usage suggests gpt-realtime-whisper) to the batch `stt --stdin
  --transcription-model` call. A realtime model would fail a batch REST call;
  only the coincidental whisper-1 default is REST-compatible.

## After state

- extensions/lib/realtime-stt-batch.js: resolveBatchSttModel(env) ->
  PI_RT_LOCAL_VAD_MODEL or DEFAULT_STT_BATCH_MODEL (mai-transcribe-1.5), decoupled
  from the realtime model. startLocalVad uses it; the resolved model is shown in
  the local-vad status/doctor line. +1 test (override/blank/default). Suite 882
  green; npm run check green.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Summary artefact commit: intentionally omitted (no self-reference).
- Files touched: extensions/lib/realtime-stt-batch.js (resolveBatchSttModel),
  extensions/realtime-agent.js (use it + status line + import), 
  test/realtime-stt-batch.test.js (+1 test).
- Tests: +1 / -0 / flipped 0.
- Behavioural delta: local-vad now transcribes with a batch model regardless of
  the realtime WebSocket model setting.

## Operator-takeaway

Second real bug caught by self-review before mic validation: local-vad would have
tried to batch-transcribe with a realtime-only model if PI_RT_TRANSCRIPTION_MODEL
was set to one (as the /rt usage suggests). Now it uses mai-transcribe-1.5 by
default, overridable via PI_RT_LOCAL_VAD_MODEL, shown in /rt doctor.
