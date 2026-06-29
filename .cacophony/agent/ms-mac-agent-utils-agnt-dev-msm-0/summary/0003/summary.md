# Session summary — cascade azure=true: direct Azure Speech REST synthesis

## Goal

Operator request (Harry): let `/cascade` synthesize via DIRECT Azure Speech REST
API calls (not a `tts` subprocess) with `azure=true`, using the azure/speech
defaults and the mstts `ttsembedding` speaker-profile tag for personal/embedding
voices. The key is read from the environment and never hardcoded/committed.

## Bead(s)

- `bd-743e10` — cascade azure=true: direct Azure Speech REST synthesis with mstts ttsembedding
- (related: `bd-8b6f12` /rt direct-azure default, landed earlier this session; `bd-73ca7c` mstts SSML builder)

## Before state

- Failing tests: none (1103 green).
- Cascade always synthesized by spawning the `tts` CLI (`tts --provider azure-speech ...`); no direct Azure Speech REST path.

## After state

- Failing tests: none. Full suite 1112/1112 (+9). `npm run check` green.
- New: `synthesizeAzureSpeechDirect` + `resolveAzureSpeechCreds` + `DEFAULT_AZURE_SPEECH_ENDPOINT`/`_OUTPUT_FORMAT` in realtime-tts-batch.js (POST <endpoint>/cognitiveservices/v1, Ocp-Apim-Subscription-Key header, mstts SSML body, raw-24khz-16bit-mono-pcm).
- New `makeCascadeTtsSynth` dispatcher: azure-speech provider + azure=true -> direct REST; else `tts` subprocess. cascadeRosterFromArgs parses `azure=true` and defaults provider=azure-speech; wired into ensureCascadeController.
- Docs: cascade `azure=true` / `speaker=` / `lang=` + embedding examples in docs/realtime-agent.md; /cascade command description updated.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: extensions/lib/realtime-tts-batch.js, extensions/lib/realtime-cascade-session.js, extensions/realtime-agent.js, docs/realtime-agent.md, test/realtime-tts-batch.test.js, test/realtime-cascade-session.test.js.
- Tests: +9 (3 direct-REST synth/creds, 6 roster + dispatcher). Suite 1112/1112.
- Behavioural delta: `/cascade start azure=true voice=<name> speaker=<profileId> lang=<locale>` synthesizes each turn via a direct Azure Speech REST call with the embedding tag; non-azure providers and azure-speech without azure=true keep the subprocess path.

## Operator-takeaway

`azure=true` is now the cascade analogue of `/rt azure`: real Azure Speech REST
calls straight from the extension (no `tts`/caco subprocess), with the
`mstts:ttsembedding speakerProfileId` tag for personal voices. Credentials come
from AZURE_SPEECH_API_KEY / AZURE_SPEECH_ENDPOINT in the environment and are
never committed. A concrete `voice=` is required (the embedding sentinel is not a
real Azure voice).
