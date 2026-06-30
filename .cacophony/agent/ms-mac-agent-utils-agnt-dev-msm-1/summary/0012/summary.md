# Session summary — cascade azure-speech HTTP 400 fix (missing xml:lang)

## Goal

Harry hit live `azure-speech HTTP 400` errors in a `/cascade` session (azure=true,
voice=MAI-Voice-2, no lang=). Diagnose and fix the root cause so cascade azure
turns synthesize without requiring an explicit lang=.

## Bead(s)

- `bd-80663f` — cascade azure-speech HTTP 400: buildAzureSpeechSsml omits required xml:lang on <speak>.

## Before state

- Failing tests: none, but live runtime bug: buildAzureSpeechSsml (realtime-tts-batch.js)
  set xml:lang only when lang was provided, so a cascade turn without lang= produced
  `<speak>` with NO xml:lang. Azure Speech REQUIRES xml:lang on `<speak>` (verified
  against Microsoft SSML docs) and returns HTTP 400 without it. Every lang-less
  azure cascade turn 400'd.

## After state

- Failing tests: none. Full JS suite green (1103 pass).
- buildAzureSpeechSsml now defaults `<speak>` xml:lang to en-US when lang is absent;
  `<voice>` xml:lang stays optional (only when lang explicit) so custom/personal
  voices like MAI-Voice-2 aren't forced to a locale. The lang-less path now emits
  valid SSML that Azure accepts.

## Diff summary

- Code/content commit: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/lib/realtime-tts-batch.js` (split langAttr into
  speakLangAttr defaulting en-US + optional voiceLangAttr), `test/realtime-tts-batch.test.js`
  (assert no-lang `<speak>` gets xml:lang='en-US' and `<voice>` stays locale-free).
- Tests: +2 assertions; 1103 pass / 0 fail.
- Behavioural delta: cascade azure turns without lang= now synthesize instead of 400ing.

## Operator-takeaway

The cascade `azure-speech HTTP 400` Harry saw was a strict-SSML-validation bug:
Azure mandates xml:lang on `<speak>`, and the builder omitted it when no lang was
passed. Defaulting to en-US fixes the common (lang-less) path. The separate `tts
HTTP 500` in the same session is upstream/server-side (proxy/TTS infra, likely the
resource contention from aurora's GHC build), not this code.
