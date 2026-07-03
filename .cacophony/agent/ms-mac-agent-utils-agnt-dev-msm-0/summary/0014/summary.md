# Session summary — hide untrusted-transcript label by default (bd-678c58)

## Goal

While testing hchat, Harry found the "[untrusted audio transcript] ..." preamble
prepended to every spoken turn is noise in a personal voice loop. Hide it by
default while keeping the safety wrapper available as an opt-in.

## Bead(s)

- `bd-678c58` (P2) — hide the untrusted-audio preamble by default in local-vad/STT.

## Before state

- labelUntrustedTranscript() was opt-OUT: the untrusted preamble was added to
  every model-facing transcript (WSS-stt ~L1503 + local-vad ~L2635 sendUserMessage
  sites) unless PI_RT_STT_UNTRUSTED_LABEL=0/false.
- Suite 1188.

## After state

- Flipped to opt-IN: default returns the raw transcript (no wrapper);
  PI_RT_STT_UNTRUSTED_LABEL=1 or PI_RT_UNTRUSTED_TRANSCRIPT_LABEL=1 restores it.
  Both send sites already route through the helper, so behaviour changes with no
  call-site edits. 3 tests flipped to lock the new default + opt-in; docs note
  added. Suite 1188 green, npm run check clean.

## Diff summary

- Code/content commit: (pending final squash SHA from reintegration receipt).
- Files: extensions/realtime-agent.js (labelUntrustedTranscript opt-in),
  test/realtime-agent.test.js (3 assertions flipped + unit test rewritten),
  docs/realtime-agent.md.

## Operator-takeaway

hchat spoken turns no longer carry the untrusted-audio wrapper by default. Note:
the other hchat report (1s partials becoming turns) was NOT a code bug — current
main already does 1s=preview-widget / 3s=commit-send with a passing test
(realtime-local-vad.test.js:74); that was very likely a stale build, pending
Harry's confirm after pi update --extensions. Reaches Harry on next update.
