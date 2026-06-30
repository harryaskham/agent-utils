# Session summary — cascade local-vad never auto-commits (bd-7b43b2)

## Goal
Fix the cascade local-vad bug Harry reported: the human turn transcribes but never
auto-commits on natural silence (only `/cascade say` forces it). Owned msm-0 / cascade
harness msm-2, unclaimed 1d+; I traced it to a mechanism in my own local-vad code that
is unit-testable without a mic, so I claimed and fixed it.

## Root cause
LocalVadController._ingest (realtime-local-vad.js) drops EVERY frame while the
half-duplex isSuppressed() gate is true. In cascade the suppression window (a peer-TTS
audioDurationMs window, or a stale assistant-speaking mark) can open during the human's
TRAILING SILENCE. With the silence frames dropped, the VadSegmenter never accumulates
commitSilenceMs, so the open turn is STRANDED and never emits a commit -> sendTurn ->
handleHumanUtterance. The sendTurn wiring was already correct (msm-0 confirmed); the
defect was upstream in frame ingestion.

## Fix
In the suppressed branch, if a human turn is already mid-flight (turnSpeechMs > 0), feed
the segmenter synthetic SILENCE for the dropped chunk's duration so its silence clock
keeps advancing and the turn reaches commitSilenceMs and commits. Zeroed frames carry no
echo, so the assistant's own audio is still never transcribed. Robust regardless of WHY
suppression is active (peer TTS or stale mark). Also benefits /rt stt local-vad.

## Tests
- Regression test reproduces the bug (verified: FAILS with the fix reverted, passes with
  it): speech while unsuppressed -> suppression opens during trailing silence -> 4s of
  suppressed silence -> turn commits once.
- Guard test: suppressed-from-start with no open turn stays silent (echo never starts a
  turn). Existing isSuppressed test still green. Full suite 1137 pass / 0 fail.

## Operator-takeaway
Cascade (and /rt stt) local-vad now auto-commits the human turn on silence even if the
assistant's half-duplex window overlaps the pause — no more "only /cascade say works".
NOTE for msm-2: please mic-validate the end-to-end cascade loop; this fixes the local-vad
stranding mechanism, but if a stale assistant-speaking mark is ALSO mis-triggering, a
__resetAssistantSpeaking() at startCascadeMic start is a cheap extra hardening.
