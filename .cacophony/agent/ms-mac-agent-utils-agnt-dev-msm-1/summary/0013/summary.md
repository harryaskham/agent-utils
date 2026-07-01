# Session summary — cascade azure embedding voice: fail fast with an actionable notice

## Goal

Harry resolved a caco-choices decision on the cascade voice follow-up: instead of
silently auto-defaulting the Azure `<voice name>` to a base model when a speaker
profile is set, FAIL FAST with a clear notice telling the operator to set a
base-model voice (and how). This fixes the remaining half of the cascade
azure-speech HTTP 400 (the embedding voice-name half; the xml:lang half landed in
bd-80663f).

## Bead(s)

- `bd-5d4784` — cascade: fail fast on non-base-model Azure embedding voice (was
  "auto-default"; re-scoped to Harry's error-out-with-notice directive).

## Before state

- Failing tests: none. But: a cascade with `speaker=<profile>` + a non-base-model
  voice (e.g. MAI-Voice-2) still hit Azure HTTP 400 with a cryptic message, because
  Azure personal/embedding voices require the `<voice name>` to be a base model
  (DragonLatestNeural / PhoenixLatestNeural). xml:lang was already fixed (bd-80663f).

## After state

- Failing tests: none. Full JS suite green (1150 pass).
- New `azureEmbeddingVoiceError()` validator (+ `isAzureEmbeddingBaseModel`,
  `AZURE_EMBEDDING_BASE_MODELS`) in realtime-tts-batch.js, wired into
  `synthesizeToPcm` so it rejects BEFORE spawning tts with an actionable message:
  "set voice=DragonLatestNeural or PhoenixLatestNeural, keep speaker=<id>, here's
  how in /cascade or /rt or settings." Only fires for azure-speech + speaker
  profile + explicit non-base-model voice; sentinel/default voices defer to the
  provider default.

## Diff summary

- Code/content commit: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/lib/realtime-tts-batch.js` (validator + synthesizeToPcm
  guard), `test/realtime-tts-batch.test.js` (+3 tests: base-model detection,
  validator matrix, fail-fast-without-spawning).
- Tests: +3; 1150 pass / 0 fail.
- Behavioural delta: bad embedding voice config now fails fast with guidance
  instead of a cryptic Azure 400.

## Operator-takeaway

Per Harry's explicit choice-resolution: prefer a fail-fast, self-explaining error
over silent auto-substitution when an Azure embedding voice is misconfigured. The
operator gets told exactly what to set (Dragon/Phoenix base model) and how, rather
than either a cryptic 400 or a possibly-wrong auto-picked base model.
