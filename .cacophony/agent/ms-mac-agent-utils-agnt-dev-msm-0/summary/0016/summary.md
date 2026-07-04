# Session summary — name pulse audio streams per pi session (bd-c201e6, bd-4e1182)

## Goal

Harry wants each pi session's PulseAudio streams individually controllable on the
pulse server host. Give realtime and cascade/TTS streams distinct, session-scoped
--stream-name values so they can be muted/routed selectively.

## Bead(s)

- `bd-c201e6` — set pacat/parec stream name `pi-rt-<session>` for realtime mode.
- `bd-4e1182` — set pacat stream name `pi-tts-<session>` for cascade/TTS mode.

## Before state

- defaultRecordCommand/defaultPlaybackCommand emit bare `parec`/`pacat` commands
  with no stream name, so all pi sessions' pulse streams are indistinguishable.
- Suite 1188.

## After state

- New pure applyPulseStreamName(command, streamName) in realtime-audio.js: appends
  `--stream-name=<sanitized>` to pacat/parec commands only; no-op for
  ffplay/sox/ffmpeg, already-named commands, or empty names.
- A per-session id (piAudioSessionId) is captured from the Pi session/branch id at
  session_start, with a stable process-id fallback.
- Call sites wrapped by mode: realtime session record/playback + local-vad record
  -> pi-rt-<id>; cascade record/playback + speak/speak-replies TTS output ->
  pi-tts-<id>. Command builders unchanged (their tests untouched). +1 test.
  Suite 1189 green, npm run check clean.

## Diff summary

- Code/content commit: (pending final squash SHA from reintegration receipt).
- Files: extensions/lib/realtime-audio.js (applyPulseStreamName),
  extensions/realtime-agent.js (session-id capture + 8 wrapped call sites),
  test/realtime-audio.test.js (+1 test).

## Operator-takeaway

Realtime vs spoken-output pulse streams are now named pi-rt-<id> / pi-tts-<id> and
individually addressable on the pulse host. First 2 of Harry's 8-bead ptt/vad/hchat
batch; the hchat-ptt executable + PTT interaction beads are next. Reaches Harry on
next pi update --extensions.
