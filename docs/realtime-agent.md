# Realtime Agent Pi extension

The realtime extension in [`extensions/realtime-agent.js`](../extensions/realtime-agent.js) lets Pi use OpenAI Realtime models as a normal Pi provider while keeping audio input/output as a side channel. The goal is to preserve the usual Pi agent loop — tools, MCP, skills, approvals, history, compaction, and model switching — while adding live speech I/O for realtime conversations. Full realtime microphone turns are audio-native: the transcript can be displayed in the UI, but the model response is triggered from the committed audio item rather than by injecting transcript text as the user's prompt.

## Install and prerequisites

Install this repository as a Pi package, then reload or restart Pi:

```bash
pi install git:github.com/harryaskham/agent-utils@v1
```

Required API configuration:

```bash
export OPENAI_API_KEY=...
# or
export PI_RT_API_KEY=...
```

The default model is `gpt-realtime-2` and the provider/model id is:

```text
openai-realtime/gpt-realtime-2
```

## Pulse-first audio default

`PI_RT_AUDIO_BACKEND` defaults to `pulse` intentionally. This is true even on macOS: Harry's normal voice setup often routes audio through Pulse with a phone as the sink/source.

Useful Pulse environment variables:

```bash
export PULSE_SERVER=...
export PULSE_SINK=...      # optional; default sink if omitted
export PULSE_SOURCE=...    # optional; default source if omitted
```

At runtime, the unified `/rt` command also accepts env-style key/value arguments for new mic/playback processes:

```text
/rt backend=pulse server=sgu24:4713 source=source.bluetooth sink=vsink_voice
/rt source="source with spaces" backend=pulse
```

Order does not matter. Values may be quoted with shell-like single or double quotes. Empty runtime values unset the corresponding Pulse variable for future spawns. If a mic capture or playback process is already running, stop/cancel it and start again so the new Pulse environment is used.

**Runtime value settings persist across restarts.** When you change a connection/tuning value setting at runtime — `voice`, `speed`, `thresh`, `model`, `baseUrl`, `trans`, or the Azure settings (`azure`, `endpoint`, `deployment`, `api_version`, `protocol`) — the new value is saved to the Pi agent `settings.json` (under `agentUtils.realtime.*`) and restored on the next `/rt` start, so you do not have to re-set it every session. Precedence is env (`PI_RT_*` / `OPENAI_*` / `AZURE_*`) > persisted settings > built-in default, so an explicit env override always wins **for the running session**. Crucially, an env override is *runtime-only*: resolving config from env never writes those env values back into `settings.json` (bd-b45224) — only an explicit `/rt` value change persists. So a hand-edited `settings.json` stays authoritative and is never silently clobbered by an env default; you can drop an env var and the persisted value fills the gap. Audio `backend` and Pulse routing (`server`/`source`/`sink`) are process-environment only and are **not** persisted — set them via env or per-`/rt` k=v each session.

**Durable cascade + STT defaults (bd-b45224).** Alongside `agentUtils.realtime`, two sibling slices let you keep durable defaults in `settings.json` and drop the matching env vars:

- `agentUtils.cascade` — `voice`, `model`, `baseUrl`, `ttsModel`, `provider`, `speakerProfileId`, `lang`, `speed`, `azure`. A `/cascade` arg wins; otherwise this slice supplies the cascade main defaults; otherwise the env/built-in default applies. So you can move `PI_CASCADE_VOICE` (and speaker/lang/azure) into `settings.json`.
- `agentUtils.stt` — `transcriptionModel`, `vadThreshold`, `backend`. Read as a fallback *below* `agentUtils.realtime` for the STT fields, so an operator can keep an explicit stt block. Same runtime contract: env still wins for the run and is never written back.

You can override the backend for local-device testing:

```bash
export PI_RT_AUDIO_BACKEND=coreaudio   # macOS input via AVFoundation, output via ffplay/AudioToolbox paths
export PI_RT_AUDIO_BACKEND=sox         # rec/play
export PI_RT_AUDIO_BACKEND=ffplay      # ffplay output with sox/rec input fallback
export PI_RT_RECORD_CMD='...'          # custom raw pcm16 24k mono stdout
export PI_RT_PLAYBACK_CMD='...'        # custom raw pcm16 24k mono stdin
```

Run `/rt-doctor` inside Pi to see the resolved backend, Pulse variables, commands, API key presence, and troubleshooting hints.

For a live one-shot connectivity test (no mic session), run `/rt probe`: it opens the realtime WebSocket, waits briefly for `session.created`, then closes — classifying the outcome as `connected`, `ga-only` (model needs the GA endpoint), `session-start-1006` (upstream closed before the session established — usually proxy GA-realtime routing), `auth`, or `config`. Handy for verifying a model/proxy/endpoint change without starting a call.

## Quick-start configs

Use these as copy/paste starting points, then run `/rt-doctor` before starting a call to confirm the resolved backend, devices, command availability, and API key status.

### Pulse / phone routing

This is Harry's normal path: Pi captures and plays raw 24 kHz mono PCM through Pulse, often with a phone or remote host as the actual microphone/speaker endpoint.

```bash
export OPENAI_API_KEY=...
export PI_RT_AUDIO_BACKEND=pulse
export PULSE_SERVER=sgu24:4713        # replace with your Pulse host
export PULSE_SOURCE=source.bluetooth  # microphone/source; omit for Pulse default
export PULSE_SINK=vsink_voice         # speaker/sink; omit for Pulse default
```

Start a full realtime conversation with server VAD:

```text
/rt backend=pulse server=sgu24:4713 source=source.bluetooth sink=vsink_voice summary=true chime=false start=vad
```

Expected behavior: `/rt-doctor` should show `backend=pulse`, non-empty Pulse routing, and available `parec`/`pacat` commands. When `/rt ... start=vad` runs, the `rt-audio`/realtime widget should show a connected session, mic bytes should increase while you speak, and playback should go to the configured Pulse sink.

### Local macOS CoreAudio / AudioToolbox test

Use this when you want to test with the Mac's local microphone and speaker instead of Pulse routing:

```bash
export OPENAI_API_KEY=...
export PI_RT_AUDIO_BACKEND=coreaudio
unset PULSE_SERVER PULSE_SOURCE PULSE_SINK
```

```text
/rt backend=coreaudio start=ptt
```

Expected behavior: `/rt-devices` lists local AVFoundation input devices, `/rt-doctor` reports a local backend and available local capture/playback helpers, and PTT records from the current default input until you commit with Enter/Space/Esc.

### Local sox/ffplay fallback

Use this on machines where `rec`/`play` or `ffmpeg`/`ffplay` are already installed and Pulse is not desired:

```bash
export OPENAI_API_KEY=...
export PI_RT_AUDIO_BACKEND=sox       # capture/play through rec/play
# or: export PI_RT_AUDIO_BACKEND=ffplay  # ffplay output with rec/sox capture fallback
```

```text
/rt backend=sox stt=ptt
```

Expected behavior: STT mode keeps your current text model selected, records from the local default input, and queues the completed transcript back into Pi as a normal follow-up message. If `/rt-doctor` reports a missing `rec`, `play`, `ffmpeg`, or `ffplay` binary, install that backend's toolchain or switch back to `backend=pulse`.

## Recommended workflows

### Full realtime conversation with server VAD

```text
/rt
# explicit equivalent:
/rt start vad
```

This switches to `openai-realtime/gpt-realtime-2`, enables audio output, opens the realtime WebSocket, and starts server-VAD microphone capture. Speak, then pause; the server commits/transcribes the speech, Pi receives it as a user message, and the normal Pi agent loop responds.

Useful controls while running:

```text
/rt-cancel       discard current microphone input
/rt-stop         stop/commit mic input; if no mic is active, close the WebSocket
/rt-off          exit realtime, stop audio/mic, restore the previous Pi model when possible
/rt-status       show compact realtime status
/rt-doctor       show diagnostics and troubleshooting details
```

### Push-to-talk mode

```text
/rt ptt
# explicit equivalent:
/rt start ptt
```

PTT records until you commit. Press `Enter`, `Space`, or `Esc`, or run `/rt-stop`, to commit recorded audio. Press `Ctrl-C` or run `/rt-cancel` to discard.

Use PTT when server VAD is over-eager, under-eager, or when background noise causes accidental turns.

### Connect without listening

```text
/rt nolisten
# explicit equivalent:
/rt start nolisten
```

This switches to the realtime model and pre-warms the WebSocket without opening the microphone. It is useful for typed realtime turns or for checking connection/API setup before starting audio capture.

Start listening later with:

```text
/rt mic vad
/rt mic ptt
# legacy aliases remain:
/rt-listen vad
/rt-listen ptt
```

### Speech-to-text into the current model

```text
/rt stt
/rt stt ptt
# or legacy alias:
/stt
```

STT mode keeps the current Pi model instead of switching to the realtime model. The realtime WebSocket is used only for microphone transcription, and the transcript is sent into Pi as a normal user message.

This is useful when you want voice input but still want another model/provider to answer.

### Local-VAD speech-to-text (WebSocket-free)

```text
/rt stt local-vad
# stop with:
/rt stt stop
```

`local-vad` is an opt-in, WebSocket-free STT mode. Instead of streaming the
microphone to the OpenAI realtime WebSocket, it captures audio locally, runs a
local energy VAD to segment speech, and transcribes each segment with a one-shot
batch `stt --stdin` call. It inserts a provisional partial after a short trailing
silence and sends the whole turn into Pi as a user message after a longer silence.
It is fully isolated from the WebSocket modes (`/rt stt [vad|ptt]`, `/rt start`),
so enabling it never disturbs them.

The batch transcription model is independent of the realtime `trans` model: it
defaults to `mai-transcribe-1.5` and is overridden with `PI_RT_LOCAL_VAD_MODEL`
(a realtime-only model such as `gpt-realtime-whisper` is not valid for the batch
REST `stt` call). `/rt doctor` shows the active local-vad model and thresholds.

The energy threshold can be tuned **live** (without restarting) via `/rt energy=<0..1>`
(higher = less sensitive), parallel to `/rt thresh=` for server VAD. While listening,
the status widget reacts in real time: `🎤 listening…` the instant speech is detected,
`✍️ transcribing…` while a batch runs, then your transcript firming up as you speak.

Tuning knobs (all optional):

| Env var | Default | Meaning |
| --- | --- | --- |
| `PI_RT_LOCAL_VAD_MODEL` | `mai-transcribe-1.5` | batch `stt` transcription model |
| `PI_RT_LOCAL_VAD_ENERGY_THRESHOLD` | `0.012` | normalized RMS (0..1) at/above which a frame is speech |
| `PI_RT_LOCAL_VAD_INSERT_SILENCE_MS` | `1000` | trailing silence (ms) that inserts a provisional partial |
| `PI_RT_LOCAL_VAD_COMMIT_SILENCE_MS` | `3000` | trailing silence (ms) that finalizes/sends the turn |
| `PI_RT_LOCAL_VAD_MIN_TURN_SPEECH_MS` | `200` | minimum speech (ms) before a turn can insert/commit |

**Troubleshooting (first-run validation):**

- *Nothing is transcribed.* The first transcription failure is surfaced as a
  warning (the common cause is a missing `stt` binary or an unavailable model).
  Run `/rt doctor` to see the active local-vad model, thresholds, and last error,
  and confirm the `stt` binary is on `PATH` and `PI_RT_LOCAL_VAD_MODEL` resolves to
  a batch-capable model (not a realtime-only model like `gpt-realtime-whisper`).
- *Turns commit too early or too late.* Adjust `PI_RT_LOCAL_VAD_COMMIT_SILENCE_MS`
  (trailing silence that finalizes/sends the turn) and
  `PI_RT_LOCAL_VAD_INSERT_SILENCE_MS` (provisional-partial silence).
- *Speech is missed, or ambient noise triggers turns.* Tune the energy threshold
  live with `/rt energy=<0..1>` (lower to catch quieter speech, raise to reject
  noise), or set `PI_RT_LOCAL_VAD_ENERGY_THRESHOLD` / `PI_RT_LOCAL_VAD_MIN_TURN_SPEECH_MS`
  before starting.
- *Stuck on `🎤 listening` and never commits.* It is hearing continuous audio
  above the threshold, so it never sees the silence gap it needs to commit —
  usually the threshold sits below your mic's noise floor. Raise it live with
  `/rt energy=0.05` (or higher); a one-time hint also prompts you. If raising it
  changes nothing, the capture may have died — `/rt stt stop` then `/rt stt local-vad`.
- *The assistant's spoken reply is re-captured as a new turn (echo).* Only happens
  if Pi replies are spoken aloud. With `force-agent-speech`, local-vad shares its
  speaking signal and drops the mic while a reply plays (plus a short release tail),
  so the echo is gated (bd-ddc391). On a slow TTS voice, raise `/rt energy=` if any
  tail still leaks.

### Spoken replies (force-agent-speech)

`force-agent-speech` closes the other half of the hands-free loop: with `/rt stt
local-vad` turning your *speech* into turns, this speaks the assistant's *reply*
aloud as a short precis (markdown/code stripped, truncated) so the conversation is
heard, not just shown.

It is opt-in and best-effort (it never blocks or breaks a turn):

```text
# enable for the session:
export PI_FORCE_AGENT_SPEECH=1          # or true/on/yes
export PI_FORCE_AGENT_SPEECH_MAX_CHARS=240   # optional precis length (default 240)
# or toggle live:
/force-speech on        # off | status | env (follow the env again)
```

The precis is spoken via `caco msg speak` (the TTS daemon). Tool-only turns with no
text are skipped.

> **Half-duplex (bd-ddc391):** force-agent-speech and local-vad share an in-process
> speaking signal, so while a reply is being spoken (its estimated duration plus a
> short release tail) local-vad drops the mic — the assistant's own voice is not
> captured and transcribed as a phantom turn. The window is estimated from the precis
> length (~15 chars/s); on a slow TTS voice you can still raise `/rt energy=` if any
> tail leaks through.

### The `speak` tool (low-latency direct-Azure agent voice)

`force-agent-speech` above speaks replies through `caco msg speak` (the TTS
daemon), which adds a daemon round-trip and uses the daemon voice. For a fast,
per-session voice, the realtime extension also registers a `speak` **tool** the
agent can call directly: it synthesizes via the direct Azure Speech REST path
(no daemon) in the configured cascade voice and plays locally.

- Defaults come from `PI_CASCADE_VOICE` (a concrete Azure voice such as
  `MAI-Voice-2`), `PI_CASCADE_SPEAKER` (mstts ttsembedding speakerProfileId),
  `PI_CASCADE_LANG`, and `PI_CASCADE_SPEED`; the agent can override any per call.
  `PI_CASCADE_SPEAK_VOICE` overrides just the speak-tool voice (it wins over
  `PI_CASCADE_VOICE`) if you want the spoken-reply voice to differ from the
  cascade roster voice.
- A concrete voice is required (the cascade embedding sentinel is not a real
  Azure voice). Azure creds come from `AZURE_SPEECH_API_KEY` /
  `AZURE_SPEECH_ENDPOINT` in the environment.

Pair it with `/rt stt local-vad` so your speech becomes agent turns and the
loaded Pi agent replies out loud in the configured voice with low latency — the
Pi agent IS the cascade brain (bd-15beec).

### Spoken replies, the fast way (`/rt speak-replies`, bd-095b3d)

`speak-replies` is the low-latency completion of the hands-free loop: it auto-
speaks the **real** Pi agent's replies through the direct-Azure path (no daemon
round-trip, the configured cascade voice), so `/rt stt local-vad` + `speak-replies`
gives you a genuine voiced agent — your speech drives your actual agent (with your
tools, MCP, and session history via `sendUserMessage`), and its reply is spoken
back. Unlike `force-agent-speech` (which speaks a truncated precis via the TTS
daemon), this speaks the full reply via the fast direct-Azure REST path.

```text
/rt speak-replies on        # off | on ; or env-style: /rt speak_replies=on
/rt speak-thinking on       # opt-in: also voice reasoning/thinking summaries (default off)
```

- Off by default. Both are **durable in `settings.json`** (`agentUtils.realtime.speakReplies`
  / `.speakThinking`) and toggleable at runtime, with env > persisted > default
  (`PI_RT_SPEAK_REPLIES` / `PI_RT_SPEAK_THINKING`); env is never written back.
- Voice/speaker/lang/speed come from the same `PI_CASCADE_*` / `speak`-tool creds
  above; speed is applied as an Azure SSML `<prosody rate>` (speed 1.2 → `+20%`).
- Fired on the `agent_end` event; tool-call-only / empty turns are skipped and a
  reply is de-duplicated so it is never spoken twice. Requires audio enabled.

**Architecture:** a single-agent voice loop (`n=1`) is just `stt local-vad` +
`speak-replies` — both hit your real agent. `/cascade` is the multi-participant
group-chat layer (`n>=2`, per-participant voices/models) built over the same
primitives.

### Replay the latest spoken response

```text
/rt-play latest
/rt-play rt-3
```

The extension caches recent response PCM clips in memory. `/rt-play latest` replays the most recent one; `/rt-play rt-N` replays a named clip shown in the `rt-audio` status line.

## Cascade group chat (`/cascade`)

`/cascade` is a multi-agent **voice group chat** (bd-7c6790): you speak once, then
each participant takes one turn — in arbitrary order — and every agent hears you
*and* everyone who already spoke that round, answering in its own synthesized
voice. It is built from the local `stt` + `tts` CLIs directly (no daemon round
trip), so each agent is speech-in, think, speech-out.

The widget shows the round live: a rolling **transcript** (`you: …`, then each
agent), a **mic input-level meter** with a caret at the VAD speech threshold while
listening, and the current speaker. It is **half-duplex** — while an agent speaks
the mic is suppressed and the meter shows `muted (agent speaking)`, so agents do
not capture their own playback. Synthesis is **pipelined**: each turn's TTS is
synthesised concurrently while playback stays ordered, so a multi-agent round runs
roughly twice as fast as strict sequential.

```text
/cascade say hello everyone            # drive one round from typed text (no mic)
/cascade start n=3                     # live mic room: you + 2 auto peers
/cascade start participants=var,cedar  # live mic room: you + named peers var, cedar
/cascade stop                          # stop the mic
/cascade reset                         # clear the conversation history
/cascade status                        # show roster + state
```

Start-time arguments (env-style `key=value`):

| Arg | Meaning |
| --- | --- |
| `n=<N>` | total participant count INCLUDING you-the-main (n=2 → main + 1 peer) |
| `participants=a,b` | named peers beyond main (`var,cedar` or `var[voice=...,model=...]`) |
| `order=fixed\|random\|round-robin` | turn order each round (default `random`) |
| `voice=` / `model=` / `base_url=` | overrides for the main participant |
| `azure=true` | synthesize via the DIRECT Azure Speech REST API (no `tts` subprocess); see below |
| `speaker=<profileId>` | Azure `mstts:ttsembedding` speaker profile id (personal/embedding voice) |
| `lang=<locale>` | `xml:lang` for the SSML (e.g. `en-GB`) |
| `pipeline=false` | disable concurrent-synthesis pipelining (also `PI_CASCADE_PIPELINE=0`); default on |
| `maxhistory=<N>` | sliding-window conversation cap (default 48; also `PI_CASCADE_MAX_HISTORY`) |

Per-participant overrides use a bracket form, e.g.
`participants=var[voice=cedar,model=haiku];cedar[base_url=http://...]`.

Defaults: cascade gives every agent the caco azure/speech embedding voice unless
overridden (so distinguish them by name/content, or pass distinct `voice=`). For
the **peer chat model**, an unpinned peer (no `model=`) now runs through Pi's own
inference engine on the model already loaded in Pi (bd-15beec) — so `n=1` behaves
like talking to the loaded Pi model and never hits the proxy's "no healthy
deployments" 400 for a stale default chat model. A peer that pins its own
`model=` still uses the direct chat-completions path against that model (the
chat-completions default is `gpt-5-mini`, override with `PI_CASCADE_MODEL`; it is
also the fallback for every peer when no Pi model/auth is available). The `say`
verb is the no-microphone way to try a round.

### Direct Azure Speech voices + embeddings (`azure=true`)

`azure=true` makes cascade synthesize each turn with a **direct Azure Speech REST
call** (`POST <AZURE_SPEECH_ENDPOINT>/cognitiveservices/v1`) instead of shelling
out to the `tts` CLI. It sends an mstts SSML body and reads credentials from the
environment — `AZURE_SPEECH_API_KEY` and `AZURE_SPEECH_ENDPOINT` (endpoint
defaults to the eastus speech URL). The key is never typed in chat or hardcoded.

A concrete Azure `voice=` is required (the cascade embedding sentinel is not a
real Azure voice). To use a personal/embedding voice, pass the base voice name
plus the `speaker=` profile id, which becomes an `<mstts:ttsembedding
speakerProfileId=...>` wrapper around the text:

```text
# one embedding voice, British English, a touch faster
/cascade start n=1 azure=true voice=MAI-Voice-2 speaker=0daec43c-... lang=en-GB speed=1.2

# a two-voice room, both direct-Azure (give each a distinct voice)
/cascade start n=2 azure=true participants="Ava[voice=en-US-AvaMultilingualNeural];Andrew[voice=en-US-AndrewMultilingualNeural]"
```

`speaker=` / `lang=` / `speed=` map to the SSML `<mstts:ttsembedding>`,
`xml:lang`, and `<prosody rate>` respectively; omit `speaker=` for a plain named
Azure voice. `azure=true` defaults every agent that did not set its own
`provider=` to `azure-speech`.

> Latency note: synthesis is pipelined (concurrent TTS, ordered playback), which
> roughly halves a multi-agent round; you can A/B it with `/cascade start
> pipeline=false`. The remaining per-turn cost is the `tts` cold-spawn — a warm
> resident tts path is tracked as a follow-up (bd-67b916). The fully audio-native
> realtime version where agents hear each other as *audio* over parallel `/rt`
> websockets is bd-07bb7f (blocked on the proxy's GA-realtime routing, bd-0b40ce).

## Status and diagnostics

Compact status:

```text
/rt-status
```

Full diagnostics:

```text
/rt-status full
/rt-doctor
```

Diagnostics include:

- provider mode and API key presence
- selected model and restore target
- resolved record/playback commands
- Pulse server/source/sink values
- command availability for `parec`, `pacat`, `ffmpeg`, `ffplay`, and `rec`
- current phase, mic bytes, mute window, and pending transcript count
- VAD threshold/silence/prefix settings
- last playback error/exit details
- actionable hints for common setup issues

### Troubleshooting: `gpt-realtime-2` rejected as "only available on the GA API"

If a realtime connect through a LiteLLM-style proxy fails with
`Model "gpt-realtime-2-..." is only available on the GA API` (`invalid_model`),
the proxy is routing the realtime WebSocket through the **beta** realtime
interface for a model that is **GA-only**. This is a proxy-side routing issue,
not a client bug: it reproduces identically with and without the legacy
`OpenAI-Beta: realtime=v1` header (this extension already drops that header by
default; set `PI_RT_BETA_HEADER=1` only to restore it).

Workaround until the proxy routes GA-realtime correctly: connect directly to the
Azure realtime deployment instead of the proxy (the direct-Azure path, e.g.
`/rt azure=true start=vad` against a `gpt-realtime-2` deployment). Direct-Azure
uses the GA realtime interface and connects cleanly.

Unified `/rt` controls:

```text
/rt start [vad|ptt|nolisten]   start realtime conversation mode
/rt stop                       stop realtime and restore the previous model
/rt mic [vad|ptt|off]          start or cancel microphone capture
/rt listen [vad|ptt|continuous]
                              start microphone capture using listen API modes
/rt audio [on|off|toggle]      control audio output
/rt stt [vad|ptt|local-vad|stop]  speech-to-text into the current model (local-vad = WebSocket-free local capture + batch stt), or stop STT mode
/rt widget [show|hide]         show or hide the realtime widget
/rt status [compact|full]      compact or full status
/rt doctor                     diagnostics
/rt probe                      one-shot connect probe (opens the WS, waits for session.created, then closes) classifying connected/ga-only/session-start-1006/auth/config — no mic session
/rt voice <voice>              set realtime output voice
/rt trans <model>              set realtime input transcription model
/rt speed <0.25..1.5>          set spoken response speed (default 1.0)
/rt backend <backend>          set audio backend for new mic/playback commands
/rt reasoning <effort>         set reasoning effort: off|minimal|low|medium|high
/rt summary [true|false]       use compact summary context instead of full history (default false)
/rt chime [true|false]         enable/disable VAD state chimes (default true)
/rt backend=pulse source=...    env-style key/value form; supports base_url/server/source/sink/start/mic/stt/audio/widget/status/voice/trans/speed/reasoning/summary/chime/fork, plus the direct-Azure connection keys azure/model/endpoint/deployment/api_version/protocol (e.g. `/rt azure=true start=vad` connects direct-Azure to the preset gpt-realtime-2 GA deployment; api_version=none uses the GA path)
/rt help                       show the unified command usage
```

`/rt voice`, `/rt trans`, `/rt speed`, `/rt backend`, `/rt reasoning`, `/rt summary`, and `/rt chime` without an argument print the current value plus supported options. Invalid values are reported as warnings and leave the previous setting unchanged. Voice names are normalized case-insensitively before validation, so `/rt voice Verse` selects `verse`. Transcription model names are passed through after normalizing the historical `whisper` alias to the default realtime transcription model. Speed must be between `0.25` and `1.5`; the extension retries without speed if the realtime server rejects the parameter. Typos in mode-bearing commands such as `/rt start <mode>`, `/rt mic <mode>`, `/rt listen <mode>`, `/rt stt <mode>`, `/rt audio <mode>`, `/rt widget <mode>`, and `/rt status <mode>` are also rejected instead of falling through to a default action. `/rt listen continuous` is accepted as a listen-mode alias for VAD, matching `pi.realtime.listen(ctx, "continuous")`. Unexpected extra arguments, such as `/rt start ptt typo`, are rejected before changing realtime state. Common voices include `marin`, `cedar`, `verse`, `alloy`, and `shimmer`; common backends include `pulse`, `audiotoolbox`, `coreaudio`, `sox`, `ffplay`, `ffmpeg`, and `auto`.

Env-style `/rt` arguments normalize into the same shape used by the agent tool surface. Examples:

```text
/rt backend=pulse server=sgu24:4713 source=source.bluetooth summary=true start=vad
/rt fork=true backend=pulse server=sgu24:4713 source=source.bluetooth summary=true chime=false start=vad
/rt trans=gpt-whisper-realtime speed=1.15 start=vad
/rt stt=ptt trans=gpt-realtime-whisper source="source.bluetooth"
/rt summary=false
/rt action=stop
```

Legacy aliases still work (`/rt`, `/rt ptt`, `/rt nolisten`, `/rt stt`, `/stt`, `/rt-stt`, `/rt-listen`, `/rt-stop`, `/rt-cancel`, `/rt-status`, `/rt-hide-status`, `/rt-off`, `/rt-reasoning`). STT aliases pass their arguments through the unified `/rt stt` path, so `/stt stop` and `/rt-stt stop` are equivalent to `/rt stt stop`. No-argument aliases such as `/rt-on`, `/rt-off`, `/rt-doctor`, and `/rt-hide-status` reject unexpected arguments instead of silently ignoring them.

### Summary context mode

`/rt summary=true` switches realtime history replay into compact-summary mode. The first realtime turn after enabling it puts the latest Pi compaction or branch summary into realtime session instructions plus the current turn, rather than replaying the full conversation history as user messages. If no saved Pi summary is present, the extension falls back to a bounded role-by-role summary of recent messages. Summary text is capped and marked as background context so it is not spoken aloud or answered directly. The default is `summary=false`, which preserves the previous full-history replay behavior.

`/rt fork=true ...` forks from the current tree/session leaf before applying the remaining realtime parameters in the replacement session. It composes with other env-style options such as `summary=true`, Pulse routing, and `start=vad`, and uses `position: "at"` so the current tree position is cloned rather than continuing in-place.

Compaction while realtime is active uses a local/simple extension compacter instead of the selected realtime model. Manual `/compact` and auto-compaction therefore keep realtime mode active, do not restore the previous text model, and do not send summarization traffic to `gpt-realtime-2`. The simple checkpoint preserves the previous summary, file lists, role counts, and bounded excerpts from the summarized span; Pi still keeps recent entries from `firstKeptEntryId` onward exactly as normal. If server VAD commits microphone audio during the short compaction window, the audio turn is deferred and automatically queued after Pi appends the compaction entry.

When full-history mode is active, realtime estimates the outgoing system prompt, tools, and message history before opening the WebSocket. If the estimate exceeds the realtime model context window (128k tokens for `gpt-realtime-2`), the turn is aborted with an error telling the user to enable `summary=true`; this avoids silently overflowing the realtime provider context.

## Pi control API

The extension also exposes a unified control object at `pi.realtime` and emits it on `pi.events` as `realtime:controls` for future UI/extensions that should not reach into realtime session internals directly.

## Agent tool workflow

When the extension is loaded in a Pi runtime that supports dynamic tools, it registers `realtime_agent_control`. Agents can use this instead of asking the operator to type `/rt` commands. The tool accepts the same normalized fields as the env-style command parser:

- lifecycle: `action`, `start`, `stt`, `mic`, `listen`, `status`
- audio/config: `audio`, `backend`, `pulseServer`, `pulseSource`, `pulseSink`, `voice`, `trans`, `speed`, `reasoning`, `summary`, `chime`, `fork`, `widget`

Examples:

```json
{ "backend": "pulse", "pulseServer": "sgu24:4713", "pulseSource": "source.bluetooth", "summary": true, "chime": false, "start": "vad" }
{ "stt": "ptt", "pulseSource": "source.bluetooth", "trans": "gpt-realtime-whisper" }
{ "start": "vad", "trans": "gpt-whisper-realtime", "speed": 1.15 }
{ "action": "status", "status": "full" }
{ "action": "stop" }
```

Tool output includes the same diagnostics/status lines as `/rt-status` and a structured snapshot with the resolved Pulse routing. API keys are not included in the structured output. Status includes `input:audio` after a full realtime microphone turn and `input:transcript` after STT-only injection so operators can distinguish `/rt start ...` from `/rt stt ...` behavior. Partial input transcription deltas are shown as pending `rt-transcript` UI status while speech is still in progress. Completed transcripts are shown as UI status/notification; full realtime never queues them as messages or forwards them as text input, while STT-only queues the completed transcript as a follow-up user message so it works even when the agent is busy.

## Autoreconnect

Realtime/STT sessions enable bounded automatic reconnect by default. If the WebSocket closes unexpectedly while realtime is active, the extension retries with exponential backoff and preserves the intended mode, audio/backend/voice/reasoning settings, Pulse routing, and previous-model restore target. Explicit `/rt-off`, `/rt stop`, or the tool equivalent disables reconnect. For VAD/continuous calls, the extension also watches the recorder process: if microphone capture exits unexpectedly while the realtime session is still connected, it clears stale mic state and restarts capture with bounded backoff. When a response contains a spoken preamble before a tool call, the extension flushes buffered audio before emitting the tool call so the preamble is heard before the tool result rather than after it.

Tuning knobs:

```bash
export PI_RT_RECONNECT_MAX_ATTEMPTS=5
export PI_RT_RECONNECT_BASE_DELAY_MS=1000
```

`/rt-status full` and `/rt-doctor` report the last disconnect reason, retry count, and next retry delay.

Useful methods include:

- `snapshot()` — current model, audio/STT flags, voice, backend, reasoning effort, previous model, last input mode, lifecycle state, and health fields. The nested `state` object includes `connection`, boolean `connected`/`connecting` flags, `phase`, `micMode`, `widgetVisible`, `lastInputMode`, and the derived user-facing `mode`; the nested `health` object includes last response/playback errors, last playback exit/start metadata, mic byte count, pending transcript count, and remaining mic mute time.
- `usage()` / `help()` — canonical `/rt` usage text for UI/help surfaces.
- `options()` / `supportedOptions()` — supported `voices`, `audioBackends`, `reasoningEfforts`, `startModes`, `micModes`, `sttModes`, `audioModes`, `widgetModes`, `statusModes`, and direct `listenModes` for building UI affordances.
- `diagnostics()` and `statusLines()` — the same content used by `/rt-doctor` and `/rt-status`.
- `showStatus(ctx)`, `hideStatus(ctx)`, `clearUi(ctx)` — widget/footer lifecycle controls.
- `setAudio(enabled, ctx)`, `toggleAudio(ctx)`, `setSttOnly(enabled, ctx)`, `setVoice(voice, ctx)`, `setAudioBackend(backend, ctx)`, and `setReasoningEffort(effort, ctx)` — guarded state changes.
- `listen(ctx, mode)`, `stopMic(ctx, { commit })`, `cancelMic(ctx)`, and `disable(ctx)` — microphone/session lifecycle helpers. Direct `listen()` calls validate `mode` against `vad`, `ptt`, and `continuous`.

Widget controls:

```text
/rt widget hide  hide the realtime widget until explicitly shown again
/rt widget show  show the realtime status/control panel again
/rt stop         clear realtime widget and footer statuses
```

The realtime panel includes compact connection/mic/audio state, transcription model, voice, summary/chime status, VAD threshold and silence, Pulse routing, and quick command hints such as `/rt thresh=0.85` and `/rt audio toggle`.

## Tuning server VAD

Server VAD is used for `/rt` and `/rt-listen vad`.

```bash
export PI_RT_VAD_THRESHOLD=0.7          # default sensitivity threshold
export PI_RT_VAD_SILENCE_MS=1100        # silence before server commits speech
export PI_RT_VAD_PREFIX_PADDING_MS=300  # audio kept before detected speech
```

Raise the threshold if background noise triggers false starts. Lower it if quiet speech is missed. Increase silence duration if turns are cut off too quickly. Threshold can also be adjusted at runtime with `/rt thresh <0..1>` or env-style `/rt thresh=0.85`; the change is applied to new/current server VAD configuration without restarting Pi.

Practical presets:

| Scenario | Suggested config | When to use it |
| --- | --- | --- |
| Quiet room / close mic | `threshold=0.55 silence=800 prefix=250` | Faster turn-taking when speech is clear and false starts are rare. |
| Default / mixed room | `threshold=0.7 silence=1100 prefix=300` | Balanced default for normal desk/phone routing. |
| Noisy room / speakers leaking into mic | `threshold=0.85 silence=1400 prefix=400 chime=false` | Avoids background noise and playback leakage causing accidental commits; expect slower turn-end detection. |
| Very soft speaker | `threshold=0.45 silence=1300 prefix=500` | Helps quiet speech get detected while keeping a longer silence window to avoid cutting the user off. |
| Unreliable VAD | `start=ptt` or `stt=ptt` | Use push-to-talk when server VAD is repeatedly over-eager, under-eager, or the room is too noisy. |

Examples:

```text
/rt backend=pulse start=vad thresh=0.55 silence=800 prefix=250
/rt backend=pulse start=vad thresh=0.85 silence=1400 prefix=400 chime=false
/rt backend=pulse start=ptt
/rt stt=ptt trans=gpt-realtime-whisper
```

Troubleshooting quick checks:

- If Pi commits before you finish a sentence, increase `silence` first; if background noise starts turns while nobody speaks, increase `threshold`.
- If quiet speech never starts a turn, lower `threshold` and confirm `/rt-doctor` shows mic bytes increasing while you speak.
- If playback from speakers triggers new mic turns, prefer headphones/Pulse echo control, raise `threshold`, set a longer `silence`, or use `ptt`.
- If a turn appears stuck in transcription, run `/rt-cancel` to discard pending audio, then check `/rt-status full` or `/rt-doctor` for `micBytes`, `pendingTranscript`, and the resolved VAD values.

`/rt-doctor` shows the resolved values so you can confirm what Pi is using.

## Local realtime extension development

For fast realtime-plugin iteration, link a local `agent-utils` checkout into Pi's auto-discovered extension directory:

```text
/rt-dev link /path/to/agent-utils
/rt-dev reload /path/to/agent-utils
/rt-dev status
/rt-dev unlink
```

When no path is provided, `/rt-dev link` uses the current Pi working directory. The command creates a small local package under `~/.pi/agent/extensions/agent-utils-realtime-dev` (or `$PI_CODING_AGENT_DIR/extensions/...`) whose `pi.extensions` entry points at the checkout's `extensions/realtime-agent.js`. After linking, run `/rt-dev reload`, `/reload-tools`, or Pi's `/reload` to load the local source. `/rt-dev reload [checkout]` optionally links the checkout, disables any active realtime session, and calls Pi's extension reload without restarting the full Pi process. This avoids waiting for `pi update --extensions` from GitHub for every small edit. Use `/rt-dev unlink` followed by `/rt-dev reload`, `/reload-tools`, or `/reload` to return to the installed package source.

## Device listing

For macOS local-device experiments:

```text
/rt-devices
```

This lists AVFoundation input devices and AudioToolbox output hints. For the normal Pulse/phone path, prefer checking Pulse routing (`PULSE_SERVER`, `PULSE_SOURCE`, `PULSE_SINK`) and `/rt-doctor`.

## Azure/direct mode

The extension also supports direct Azure realtime endpoints:

```bash
export PI_RT_DIRECT_AZURE=1
export PI_RT_AZURE_ENDPOINT=...
export PI_RT_AZURE_API_KEY=...
export PI_RT_AZURE_DEPLOYMENT=gpt-realtime-2
export PI_RT_AZURE_API_VERSION=2025-04-01-preview
export PI_RT_AZURE_PROTOCOL=v1
```

`PI_RT_AZURE_API_VERSION` defaults to `2025-04-01-preview`. Set it to **`none`**
(or empty / `ga`) to omit `api-version` from the realtime URL entirely — required
when the endpoint is a GA-only proxy (e.g. a LiteLLM front for a GA realtime model
like `gpt-realtime-2`) that rejects the dated api-version with *"Model ... is only
available on the GA API"*. Then reconnect realtime.

Reasoning effort is only sent through the proxy when explicitly enabled, or in direct-Azure modes that support it:

```bash
export PI_RT_REASONING_EFFORT=low
export PI_RT_SEND_REASONING=1
```

## Troubleshooting quick reference

- Run `/rt-doctor` first. It is designed to be safe without a live conversation.
- If API connection fails, check `OPENAI_API_KEY` / `PI_RT_API_KEY`, or Azure equivalents.
- If Pulse audio fails, check `PULSE_SERVER`, `PULSE_SOURCE`, `PULSE_SINK`, and whether `parec`/`pacat` are available.
- If local macOS audio fails, try `/rt-devices`, `PI_RT_INPUT_DEVICE`, `PI_RT_OUTPUT_DEVICE`, or custom record/playback commands.
- If VAD misses speech, lower `PI_RT_VAD_THRESHOLD` or increase mic gain.
- If VAD commits too often, raise `PI_RT_VAD_THRESHOLD` or increase `PI_RT_VAD_SILENCE_MS`.
- If transcription hangs, use `/rt-cancel` to discard or `/rt-listen ptt` for manual control.
- If the widget is in the way, use `/rt-hide-status`; `/rt-status` shows it again.

## Smoke test checklist

1. `/rt-doctor` — confirm API key, backend, commands, and Pulse routing.
2. `/rt nolisten` — verify the realtime WebSocket connects without opening the mic.
3. Type `hello` — confirm a text realtime response.
4. `/rt-listen ptt`, speak, then press Enter — confirm transcription appears as a user message.
5. `/rt` — confirm full VAD conversation.
6. Ask for a tool use, e.g. list files — confirm Pi tool calls still work.
7. `/rt-play latest` — confirm replay works after an audio response.
8. `/rt-off` — confirm previous model and UI are restored/cleared.
