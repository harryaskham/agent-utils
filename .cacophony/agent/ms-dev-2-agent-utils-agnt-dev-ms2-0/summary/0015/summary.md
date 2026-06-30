# Session summary — cascade azure personal-voice HTTP 400 fix

## Goal
Unblock Harry's live cascade: /cascade azure=true with his MAI-Voice-2 personal voice was failing with azure-speech HTTP 400. Diagnose the bad request and fix it.

## Bead(s)
- `bd-dbfaa7` — Cascade azure=true personal voice → HTTP 400: SSML used the nickname as the <voice name> instead of an Azure base model

## Before state
- /cascade azure=true voice=MAI-Voice-2 speaker=<id> → azure-speech HTTP 400 (live, Harry).
- buildAzureSpeechSsml emitted `<voice name='MAI-Voice-2'>` (the personal-voice nickname) with `<mstts:ttsembedding speakerProfileId=...>`. Azure personal voice requires <voice name> to be a base model (DragonLatestNeural/PhoenixLatestNeural) — nickname → 400 (confirmed vs Azure docs).
- Two tests actually encoded the bug (asserted the nickname as the voice name with a speakerProfileId set).

## After state
- Full suite 1134 tests, 1129 pass, 0 fail, 5 skipped. realtime-tts-batch + realtime-cascade-session 45/45. docs:check valid.
- Personal-voice SSML now emits a base-model `<voice name>` with the speakerProfileId inside.

## Diff summary
- extensions/lib/realtime-tts-batch.js: add resolveAzureVoiceName + DEFAULT_AZURE_PERSONAL_VOICE_BASE_MODEL (DragonLatestNeural); when speakerProfileId is set, <voice name> resolves to a base model (honor an explicit …Neural voice, else azureBaseVoice/default), never the nickname; threaded azureBaseVoice through buildAzureSpeechSsml/buildTtsBatchArgs/synthesizeToPcm/synthesizeAzureSpeechDirect. No speakerProfileId → voice verbatim (standard voices unchanged).
- test/realtime-tts-batch.test.js + test/realtime-cascade-session.test.js: corrected the two bug-encoding assertions; added resolveAzureVoiceName coverage. Tests +1 net / 3 assertions flipped. Test-only behavioural change is SSML voice-name resolution for personal voices.
- Landed SHA from reintegration receipt.

## Operator-takeaway
Harry: the cascade personal-voice 400 was our SSML sending the nickname as the Azure voice name. Fixed to a base model (DragonLatestNeural by default, overridable via azureBaseVoice). Speech is disabled on ms-dev-2 so this is unit-verified only — needs a live /cascade azure=true confirm on a speech-enabled node. If the daemon audio proxy uses a different base model for embedding voices, align the default for consistency (msm-0's lane).
