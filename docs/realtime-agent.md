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

You can override the backend for local-device testing:

```bash
export PI_RT_AUDIO_BACKEND=coreaudio   # macOS input via AVFoundation, output via ffplay/AudioToolbox paths
export PI_RT_AUDIO_BACKEND=sox         # rec/play
export PI_RT_AUDIO_BACKEND=ffplay      # ffplay output with sox/rec input fallback
export PI_RT_RECORD_CMD='...'          # custom raw pcm16 24k mono stdout
export PI_RT_PLAYBACK_CMD='...'        # custom raw pcm16 24k mono stdin
```

Run `/rt-doctor` inside Pi to see the resolved backend, Pulse variables, commands, API key presence, and troubleshooting hints.

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

### Replay the latest spoken response

```text
/rt-play latest
/rt-play rt-3
```

The extension caches recent response PCM clips in memory. `/rt-play latest` replays the most recent one; `/rt-play rt-N` replays a named clip shown in the `rt-audio` status line.

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

Unified `/rt` controls:

```text
/rt start [vad|ptt|nolisten]   start realtime conversation mode
/rt stop                       stop realtime and restore the previous model
/rt mic [vad|ptt|off]          start or cancel microphone capture
/rt listen [vad|ptt|continuous]
                              start microphone capture using listen API modes
/rt audio [on|off|toggle]      control audio output
/rt stt [vad|ptt|stop]         speech-to-text into the current model, or stop STT mode
/rt widget [show|hide]         show or hide the realtime widget
/rt status [compact|full]      compact or full status
/rt doctor                     diagnostics
/rt voice <voice>              set realtime output voice
/rt backend <backend>          set audio backend for new mic/playback commands
/rt reasoning <effort>         set reasoning effort: off|minimal|low|medium|high
/rt summary [true|false]       use compact summary context instead of full history (default false)
/rt backend=pulse source=...    env-style key/value form; supports server/source/sink/start/mic/stt/audio/widget/status/voice/reasoning/summary
/rt help                       show the unified command usage
```

`/rt voice`, `/rt backend`, `/rt reasoning`, and `/rt summary` without an argument print the current value plus supported options. Invalid values are reported as warnings and leave the previous setting unchanged. Voice names are normalized case-insensitively before validation, so `/rt voice Verse` selects `verse`. Typos in mode-bearing commands such as `/rt start <mode>`, `/rt mic <mode>`, `/rt listen <mode>`, `/rt stt <mode>`, `/rt audio <mode>`, `/rt widget <mode>`, and `/rt status <mode>` are also rejected instead of falling through to a default action. `/rt listen continuous` is accepted as a listen-mode alias for VAD, matching `pi.realtime.listen(ctx, "continuous")`. Unexpected extra arguments, such as `/rt start ptt typo`, are rejected before changing realtime state. Common voices include `marin`, `cedar`, `verse`, `alloy`, and `shimmer`; common backends include `pulse`, `audiotoolbox`, `coreaudio`, `sox`, `ffplay`, `ffmpeg`, and `auto`.

Env-style `/rt` arguments normalize into the same shape used by the agent tool surface. Examples:

```text
/rt backend=pulse server=sgu24:4713 source=source.bluetooth summary=true start=vad
/rt stt=ptt source="source.bluetooth"
/rt summary=false
/rt action=stop
```

Legacy aliases still work (`/rt`, `/rt ptt`, `/rt nolisten`, `/rt stt`, `/stt`, `/rt-stt`, `/rt-listen`, `/rt-stop`, `/rt-cancel`, `/rt-status`, `/rt-hide-status`, `/rt-off`, `/rt-reasoning`). STT aliases pass their arguments through the unified `/rt stt` path, so `/stt stop` and `/rt-stt stop` are equivalent to `/rt stt stop`. No-argument aliases such as `/rt-on`, `/rt-off`, `/rt-doctor`, and `/rt-hide-status` reject unexpected arguments instead of silently ignoring them.

### Summary context mode

`/rt summary=true` switches realtime history replay into compact-summary mode. The first realtime turn after enabling it sends the latest Pi compaction or branch summary from model context plus the current turn, rather than replaying the full conversation history. If no saved Pi summary is present, the extension falls back to a bounded role-by-role summary of recent messages. The default is `summary=false`, which preserves the previous full-history replay behavior.

Compaction itself still runs through Pi's selected text model. If manual or auto-compaction starts while a realtime model/session is active, the extension pauses realtime, restores the previous text model where possible, unregisters the realtime API handler, and cancels that compaction attempt. Retry `/compact` after the model has been restored; auto-compaction will retry on a later text-model turn. This avoids summarization requests being sent to `gpt-realtime-2` while a realtime response is active.

When full-history mode is active, realtime estimates the outgoing system prompt, tools, and message history before opening the WebSocket. If the estimate exceeds the realtime model context window (128k tokens for `gpt-realtime-2`), the turn is aborted with an error telling the user to enable `summary=true`; this avoids silently overflowing the realtime provider context.

## Pi control API

The extension also exposes a unified control object at `pi.realtime` and emits it on `pi.events` as `realtime:controls` for future UI/extensions that should not reach into realtime session internals directly.

## Agent tool workflow

When the extension is loaded in a Pi runtime that supports dynamic tools, it registers `realtime_agent_control`. Agents can use this instead of asking the operator to type `/rt` commands. The tool accepts the same normalized fields as the env-style command parser:

- lifecycle: `action`, `start`, `stt`, `mic`, `listen`, `status`
- audio/config: `audio`, `backend`, `pulseServer`, `pulseSource`, `pulseSink`, `voice`, `reasoning`, `summary`, `widget`

Examples:

```json
{ "backend": "pulse", "pulseServer": "sgu24:4713", "pulseSource": "source.bluetooth", "summary": true, "start": "vad" }
{ "stt": "ptt", "pulseSource": "source.bluetooth" }
{ "action": "status", "status": "full" }
{ "action": "stop" }
```

Tool output includes the same diagnostics/status lines as `/rt-status` and a structured snapshot with the resolved Pulse routing. API keys are not included in the structured output. Status includes `input:audio` after a full realtime microphone turn and `input:transcript` after STT-only injection so operators can distinguish `/rt start ...` from `/rt stt ...` behavior. For full realtime turns, the transcript is shown as UI status/notification only; it is not queued as a message, is stripped from model context, and is not forwarded as a second text input.

## Autoreconnect

Realtime/STT sessions enable bounded automatic reconnect by default. If the WebSocket closes unexpectedly while realtime is active, the extension retries with exponential backoff and preserves the intended mode, audio/backend/voice/reasoning settings, Pulse routing, and previous-model restore target. Explicit `/rt-off`, `/rt stop`, or the tool equivalent disables reconnect. When a response contains a spoken preamble before a tool call, the extension flushes buffered audio before emitting the tool call so the preamble is heard before the tool result rather than after it.

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
/rt widget show  show the realtime widget again
/rt stop         clear realtime widget and footer statuses
```

## Tuning server VAD

Server VAD is used for `/rt` and `/rt-listen vad`.

```bash
export PI_RT_VAD_THRESHOLD=0.7          # default sensitivity threshold
export PI_RT_VAD_SILENCE_MS=1100        # silence before server commits speech
export PI_RT_VAD_PREFIX_PADDING_MS=300  # audio kept before detected speech
```

Raise the threshold if background noise triggers false starts. Lower it if quiet speech is missed. Increase silence duration if turns are cut off too quickly.

`/rt-doctor` shows the resolved values so you can confirm what Pi is using.

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
