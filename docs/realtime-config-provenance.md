# Realtime / cascade / STT config provenance

<!-- GENERATED from extensions/lib/realtime-config-provenance.js — do not edit by hand.
     Regenerate: node -e "import('./extensions/lib/realtime-config-provenance.js').then(m=>process.stdout.write(m.renderProvenanceMarkdown()))" > docs/realtime-config-provenance.md
     test/realtime-config-provenance.test.js binds this table to realtime-config.js + realtime-settings.js so it cannot drift. -->

Answers "where does each realtime config value come from, and is it written back to `settings.json`?" without tracing across `makeInitialConfig` (realtime-config.js), the `/rt` setters (realtime-agent.js / realtime-settings.js), and the env helpers.

**Precedence for every field: `env > persisted (settings.json) > default`.** A non-empty env value always wins; persisted (`agentUtils.<slice>`) only fills the gap; env is NEVER written back (durable-settings contract, bd-b45224). To make a value durable, set it via the `/rt` setter (persists to `agentUtils.realtime.<field>`) rather than an env var — and remove the env override so the persisted value is visible.

## Realtime fields (makeInitialConfig)

| Field | Env vars (first set wins) | Persisted | Default | Notes |
|---|---|---|---|---|
| baseUrl | PI_RT_BASE_URL, OPENAI_BASE_URL | agentUtils.realtime | https://api.openai.com |  |
| model | PI_RT_MODEL, OPENAI_REALTIME_MODEL | agentUtils.realtime | (normalizeRealtimeModelId default) |  |
| betaHeader | PI_RT_BETA_HEADER | no | false | GA models reject OpenAI-Beta:realtime=v1; set =1 only for legacy/self-hosted beta endpoints (bd-0b40ce) |
| directAzure | PI_RT_PROVIDER, PI_RT_DIRECT_AZURE | agentUtils.realtime | true | resolveDirectAzureDefault: PI_RT_PROVIDER=azure forces Azure (openai/proxy forces the proxy path), else PI_RT_DIRECT_AZURE, else persisted, else true (bd-8b6f12) |
| azureEndpoint | PI_RT_AZURE_ENDPOINT, AZURE_CANADACENTRAL_ENDPOINT, AZURE_OPENAI_ENDPOINT | agentUtils.realtime | https://harryaskham-sandbox-ais-ccan.cognitiveservices.azure.com |  |
| azureDeployment | PI_RT_AZURE_DEPLOYMENT, AZURE_CANADACENTRAL_DEPLOYMENT | agentUtils.realtime | (falls back to resolved model) |  |
| azureApiVersion | PI_RT_AZURE_API_VERSION, AZURE_OPENAI_API_VERSION | agentUtils.realtime | none | GA realtime omits api-version; "none" = omitted (bd-cb74b5) |
| azureProtocol | PI_RT_AZURE_PROTOCOL | agentUtils.realtime | v1 |  |
| transcriptionModel | PI_RT_TRANSCRIPTION_MODEL, OPENAI_REALTIME_TRANSCRIPTION_MODEL | agentUtils.realtime (+agentUtils.stt fallback) | (normalizeTranscriptionModel default) |  |
| voice | (none) | agentUtils.realtime | (resolveRealtimeVoice default) | no env key; persisted.voice or default only |
| speed | PI_RT_SPEED, OPENAI_REALTIME_SPEED | agentUtils.realtime | 1 |  |
| vadThreshold | PI_RT_VAD_THRESHOLD | agentUtils.realtime (+agentUtils.stt fallback) | 0.7 |  |
| bufferMs | PI_RT_BUFFER_MS, TTS_REALTIME_BUFFER_MS | no | 180 |  |
| playbackChunkMs | PI_RT_PLAYBACK_CHUNK_MS | no | 80 |  |
| reasoningEffort | PI_RT_REASONING_EFFORT | no | off |  |
| sendReasoning | PI_RT_SEND_REASONING | no | false |  |
| audioEnabled | PI_RT_DISABLE_AUDIO | no | true | inverted: audioEnabled = !PI_RT_DISABLE_AUDIO |
| debug | PI_RT_DEBUG | no | false |  |
| recordCommand | PI_RT_RECORD_CMD | no | (unset) |  |
| playbackCommand | PI_RT_PLAYBACK_CMD | no | (unset) |  |
| reconnectMaxAttempts | PI_RT_RECONNECT_MAX_ATTEMPTS | no | 5 |  |
| reconnectBaseDelayMs | PI_RT_RECONNECT_BASE_DELAY_MS | no | 1000 |  |
| summaryContext | PI_RT_SUMMARY | no | false |  |
| chimeEnabled | PI_RT_CHIME | no | true |  |
| speakReplies | PI_RT_SPEAK_REPLIES | agentUtils.realtime | false |  |
| speakThinking | PI_RT_SPEAK_THINKING | agentUtils.realtime | false |  |

## Server VAD turn-detection (buildServerVadTurnDetection)

Sent on `session.update`; env-only, call-site options override.

| Field | Env vars | Default | Notes |
|---|---|---|---|
| threshold | PI_RT_VAD_THRESHOLD | 0.7 |  |
| prefix_padding_ms | PI_RT_VAD_PREFIX_PADDING_MS | 300 |  |
| silence_duration_ms | PI_RT_VAD_SILENCE_MS | 1100 |  |

## Persisted settings.json slices (agentUtils.<slice>)

- `agentUtils.realtime`: baseUrl, model, voice, transcriptionModel, speed, vadThreshold, directAzure, azureEndpoint, azureDeployment, azureApiVersion, azureProtocol, speakReplies, speakThinking
- `agentUtils.stt` (fallback below realtime for transcriptionModel/vadThreshold): transcriptionModel, vadThreshold, backend
- `agentUtils.cascade` (feeds cascadeRosterFromArgs in realtime-cascade-session.js; env/default provenance lives there): voice, model, baseUrl, ttsModel, provider, speakerProfileId, lang, speed, azure
