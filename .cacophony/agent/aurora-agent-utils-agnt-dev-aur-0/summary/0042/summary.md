# Session summary — document /rt stt local-vad (bd-92a16a)

## Goal

Complete the bd-9399e7 feature: the new /rt stt local-vad mode + PI_RT_LOCAL_VAD_*
knobs were only in the inline usage string, not in docs/realtime-agent.md (which
documents every other /rt mode + env knob).

## Bead(s)

- `bd-92a16a` — Document /rt stt local-vad mode + PI_RT_LOCAL_VAD_* knobs in
  docs/realtime-agent.md (task; landed).

## Before state

- docs/realtime-agent.md documented /rt stt [vad|ptt|stop] but not local-vad or
  its env knobs.

## After state

- New 'Local-VAD speech-to-text (WebSocket-free)' subsection: how it works
  (local capture + energy VAD + batch stt --stdin), isolation from WebSocket
  modes, the batch model decoupling (mai-transcribe-1.5 / PI_RT_LOCAL_VAD_MODEL),
  a tuning-knob table, and /rt doctor visibility. Command reference updated to
  /rt stt [vad|ptt|local-vad|stop]. All 5 documented env knobs verified present in
  code. npm run check green. Doc-only, public-safe.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Summary artefact commit: intentionally omitted (no self-reference).
- Files touched: docs/realtime-agent.md.
- Tests: +0 (doc-only); npm run check green.
- Behavioural delta: none — documentation only.

## Operator-takeaway

The local-vad feature is now fully documented for users/contributors (modes,
env knobs, model decoupling, diagnostics), closing out the bd-9399e7 feature work
(implementation + 2 self-review fixes + docs). Still pending operator mic/Pulse
validation of the runtime behavior.
