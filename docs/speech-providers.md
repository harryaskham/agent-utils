# Native speech providers

Agent Utils supports `provider=azure`, `provider=openai`, `provider=daemon`, and the existing TTS `provider=command` (`local` alias). These are native JavaScript HTTP clients, not `tts --remote`/`stt --remote` subprocess wrappers. Existing Azure TTS and automatic Azure/OpenAI batch-STT defaults remain unchanged; selecting a new provider is explicit.

## Use the Helsinki daemons

```text
/tts provider=daemon daemon_url=helsinki
/read provider=daemon daemon_url=helsinki
/narrate provider=daemon daemon_url=helsinki enabled=true
/stt provider=daemon daemon_url=helsinki
/ptt provider=daemon daemon_url=helsinki
```

`/narrate` shares `/tts`'s speech configuration. Its `model=` still selects the **summary LLM**; use `tts_model=` for the speech model. Choices inherit startup `agentUtils.tts` / `PI_TTS_*` settings. `/stt` and `/ptt` share settings with choice freeform PTT and cascade microphone input.

TTS defaults to `http://helsinki:7633`; STT to `http://helsinki:7634`. Explicit HTTP(S) URLs, proxy path prefixes and bare `host[:port]` are supported. These clients do not parse the CLI's YAML or support its Unix-socket transport. Set the URL in Agent Utils settings or environment when it differs. HTTP sends the bearer token in plaintext: use the trusted Tailnet or HTTPS termination. Redirects and credential-bearing URLs are refused.

Daemon authentication is resolved **on each request**, including status polls:

1. `TTS_DAEMON_TOKEN` / `STT_DAEMON_TOKEN` (nonempty).
2. Compatibility spelling `TTS_DAMEON_TOKEN` / `STT_DAMEON_TOKEN`.
3. `token_file=` / startup `tokenFile`, then `TTS_TOKEN_FILE` / `STT_TOKEN_FILE` through the settings resolver, then `$XDG_CONFIG_HOME/{tts,stt}/daemon-token` (default `~/.config/{tts,stt}/daemon-token`).

Managed symlinks are followed without modifying them. Files are bounded, read afresh, and never generated or copied. Rotating the token file is picked up by running sessions; changing the parent shell's environment does not modify an already-running process. Upstream Azure/OpenAI keys stay on the daemon. Token values never enter request JSON, status, logs, session settings or local PCM player environments.

### Queue and output ownership

`provider=daemon` defaults to **server playback** (`playback=daemon`): one `tts` admission, then correlated `tts.status` polls until playback completes. The daemon owns provider fallback policy, FIFO playback lanes, overlap, output routing and global mute. Agent Utils does not also enqueue/play those bytes locally.

```text
/tts provider=daemon daemon_provider=azure voice=MAI-Voice-2.1-Flash speed=1.5
/tts provider=daemon daemon_provider=openai model=gpt-4o-mini-tts voice=alloy
/tts provider=daemon daemon_sink=my-server-sink
/tts provider=daemon playback=local
```

`daemon_provider=` pins the daemon's upstream provider; omit it to use server policy. `daemon_sink=` targets a sink **on the server**. Ambient client `PULSE_SERVER`, `PULSE_SINK`, `backend`, `device` and session pan are not sent as remote output overrides. The existing daemon protocol has no pan/server fields; server playback uses its own audio routing. `playback=local` requests raw PCM, verifies the job ID/path/byte count, downloads only that job's audio, then uses the normal local interruptible player, pan and machine queue. This mode centralizes synthesis credentials but **not playback queueing**. The daemon cannot stop PCM already downloaded to a local player. Choice speech bypasses its local PCM cache in daemon mode so each new utterance consults server policy. Direct `synthesizeSpeechDirect()` is always a raw-audio API, including for `provider=daemon`.

**Cancellation limitation:** the current Tools TTS protocol has no per-job cancel operation. Turning speech off, superseding a message, local mute or session shutdown aborts the client wait, but cannot retract already-admitted server speech. No session ever sends global `daemon.mute` to simulate local cancellation. Timeout/interrupted-wait errors identify the job and state that it may still play. Use `playback=local` when immediate per-session interruption is essential, or the daemon's explicit global controls when you intend fleet-wide control. A client failure never resubmits speech or falls back locally. The daemon's global mute still suppresses its queued/in-flight output.

Tools follow-ups: **bd-190093** tracks scoped cancellation APIs (TTS jobs and STT batches); **bd-ba35ef** tracks per-request daemon panning and explicit channel metadata. These are filed requirements, not capabilities of the current deployed protocol.

## Direct OpenAI-compatible TTS

```text
/tts provider=openai model=gpt-4o-mini-tts voice=alloy speed=1.2
/read provider=openai voice=coral instructions='Speak calmly.'
/tts provider=openai base_url=http://localhost:4000 style=cheerful styledegree=1.2
```

Uses `OPENAI_API_KEY`, `PI_TTS_BASE_URL` / `OPENAI_BASE_URL` (default `https://api.openai.com/v1`), `OPENAI_TTS_MODEL` (default `gpt-4o-mini-tts`) and `OPENAI_TTS_VOICE` (default `alloy`). The body is plain `audio/speech` JSON with `response_format=pcm`, not SSML. Origins, `/v1`, proxy prefixes and complete `/audio/speech` endpoints are normalized once. Custom compatible model/voice IDs are accepted.

`lang`, `style`, `styledegree`, `role`, `pitch`, `volume` and `instructions` compose into prompt instructions; they are not exact DSP guarantees. Speed is 0.25–4, pitch −50–50, volume 0–100, degree 0.01–2. `tts-1`/`tts-1-hd` reject instruction controls. Azure embeddings/SSML fail explicitly rather than being silently dropped. Changing providers with `/tts` or `/read` resets the old provider's model, voice, embedding, endpoint and credentials; set desired overrides in the same command. Non-Azure providers do not get the automatic Azure session-voice assignment. Deliberate persisted/explicit voice overrides remain your responsibility.

## STT and realtime boundaries

```text
/stt provider=openai model=gpt-4o-mini-transcribe language=en
/ptt provider=daemon language=en
/rt stt=vad provider=daemon daemon_url=helsinki
/rt stt=ptt provider=daemon
/cascade start provider=daemon daemon_url=helsinki
```

Batch STT wraps complete captured PCM turns in WAV and calls `stt.transcribe` or OpenAI multipart `audio/transcriptions`. Provider selection, model, language and prompt are shared by local VAD, PTT, choice freeform, quickfile and cascade input. Daemon requests omit unconfigured model/language/prompt so server defaults apply. Direct OpenAI defaults to `gpt-4o-mini-transcribe`; `provider=auto` retains the existing MAI/Azure-first selection. Direct Azure MAI does not accept `prompt`.

Explicit `/rt stt=vad|ptt provider=daemon` uses native `stt.stream.open/append/events/close/abort`. Appends are serialized and bounded; sequenced events deduplicate and completed items are delivered in commit order. PTT commits close the current daemon stream; the next audio opens a new stream, without replay. Shutdown/cancel abort only the owned session. The capture rate is explicitly negotiated as 24 kHz; a daemon returning another rate is rejected instead of corrupting audio. `streaming_model=` / `agentUtils.stt.streamingModel` / `PI_STT_STREAMING_MODEL` selects the streaming model independently of the batch model. `/rt trans=` also selects the next daemon stream's model. VAD threshold, silence and prefix controls are included at open. Daemon stream settings are immutable: restart with `/rt stt=vad|ptt` after changing them; no audio is replayed to emulate a live update. Server VAD auto mode is subject to the selected upstream model's capabilities; models without turn detection may only finalize on commit/stop.

The **full multimodal Realtime conversation** (`/rt start`, model-generated audio) remains its separate Azure/OpenAI protocol, not a TTS-daemon request. `provider=daemon` is not advertised as a full Realtime model. `/rt speak_replies=on` and cascade's standalone TTS do use the shared TTS providers. Legacy `force-speech` also honors an explicitly selected shared provider; without one it retains its Cacophony route. Cascade keeps chat `base_url` separate from `tts_endpoint` / `daemon_url`; remote TTS admission is deferred to its ordered playback phase.

## Startup configuration

```json
{
  "agentUtils": {
    "tts": {
      "provider": "daemon",
      "daemonUrl": "http://helsinki:7633",
      "playback": "daemon"
    },
    "stt": {
      "provider": "daemon",
      "daemonUrl": "http://helsinki:7634",
      "language": "en"
    }
  }
}
```

No key belongs in this JSON. Restarted sessions restore their own runtime overrides above startup settings. A fresh session uses startup configuration again; nothing automatically starts microphone capture on reload.

TTS environment: `PI_TTS_PROVIDER`, `PI_TTS_MODEL`, `PI_TTS_VOICE`, `PI_TTS_LANG`, `PI_TTS_SPEED`, existing style/embedding variables, `PI_TTS_INSTRUCTIONS`, `PI_TTS_DAEMON_URL` (then `TTS_DAEMON_URL`), `PI_TTS_DAEMON_PROVIDER`, `PI_TTS_DAEMON_SINK`, `PI_TTS_PLAYBACK`, `PI_TTS_TIMEOUT_MS`.

STT environment: `PI_STT_PROVIDER`, `PI_STT_MODEL` (below legacy `PI_RT_LOCAL_VAD_MODEL`), `PI_STT_ENDPOINT`, `PI_STT_DAEMON_URL` (then `STT_DAEMON_URL`), `PI_STT_DAEMON_PROVIDER`, `PI_STT_LANGUAGE` (then `STT_LANGUAGE`), `PI_STT_PROMPT`, `PI_STT_STREAMING_MODEL`; existing local-VAD timeout/tuning variables continue to work.

Defaults: 30 s direct speech/batch STT, 120 s daemon TTS including queued playback. `timeout_ms=` overrides TTS (1–600000 ms). Response/audio sizes are bounded; timeout covers response consumption, not just headers. HTTP errors omit response bodies to avoid echoing private speech or credentials. See [acceptance](speech-providers-acceptance.json) and `test/speech-providers.test.js` for isolated protocol fixtures.
