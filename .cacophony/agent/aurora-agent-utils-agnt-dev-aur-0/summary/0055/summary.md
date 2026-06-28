# Session summary — local-vad half-duplex guard (bd-ddc391)

## Goal

Close the voice loop's last gap: stop local-vad transcribing the assistant's own
spoken reply (from force-agent-speech) as a phantom echo turn.

## Bead(s)

- `bd-ddc391` — local-vad: half-duplex guard (gate VAD input while assistant
  speaking + release tail) (feature; promoted from draft and landed).

## Change

force-agent-speech (bd-9c9877) now provides an in-process speaking signal, resolving
the long-open "which signal" question. New extensions/lib/half-duplex-state.js:
force-agent-speech calls markAssistantSpeaking(estimateSpeechMs(precis)) (+350ms
tail); LocalVadController gains isSuppressed() which drops mic frames + clears the
re-frame buffer while isAssistantSpeaking() is true; startLocalVad wires it. So the
spoken reply window gates the mic, no echo turn. Lighter than AEC.

## Verification

- +5 tests: estimate/window/extend/junk-tolerance for the state lib, and a controller
  test proving frames are dropped while suppressed and a real turn is captured once it
  lifts. Docs updated (echo now gated). Suite 1040 green (incl. under the host
  PI_RT_LOCAL_VAD_ENERGY_THRESHOLD=0.25); check green.

## Diff summary

- Code/content commit: pending final squash SHA.
- Summary artefact: intentionally omitted.
- Files: half-duplex-state.js (new), force-agent-speech.js (mark speaking),
  realtime-local-vad.js (isSuppressed gate), realtime-agent.js (wiring),
  half-duplex-state.test.js (new), realtime-local-vad.test.js (+1), docs.
- Behavioural delta: with force-agent-speech on, local-vad drops the mic while a
  reply is spoken.

## Operator-takeaway

The hands-free loop is now echo-safe: /rt stt local-vad in, force-agent-speech reply
out, mic gated during the reply. credit: signal design ms-mac msm-1.
