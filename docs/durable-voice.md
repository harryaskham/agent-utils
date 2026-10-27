# Voice input in pi-daemon sessions

[`extensions/durable/voice.mjs`](../extensions/durable/voice.mjs) gives pi-daemon sessions voice
input run by the daemon (bd-6ffaf9).

The daemon records the microphone, finds speech and transcribes it. It then submits each turn as
your message: queued as a follow-up while the agent works, or as a steer with `deliver=steer`.
It uses the same VAD, providers and settings as TUI `/stt`. The TUI's own `/stt`, `/ptt`, `/rt`
and `/cascade` are unchanged. In pi-client, which loads `realtime-agent.js` as a client
extension, `/stt` and `/ptt` stay the local ones, and `/call` is the daemon's.

List it in a pi-daemon profile's `extensions:` beside `tts.mjs`. A session's speech from
`tts.mjs` mutes its microphone while it plays.

## Commands

| Command | What it does |
| --- | --- |
| `/call [vad\|ptt] [key=value …]` | Start a voice call, or change the live one. With settings and no verb, a live call takes them; with none live, one starts, as TUI `/stt key=value` does. |
| `/call talk` | Push-to-talk: open the microphone (starting a call if none is live), then send what was said. Any client can press it. |
| `/call send`, `/call cancel` | End a push-to-talk turn, sending it or dropping it. |
| `/call mute`, `/call unmute` | Drop the microphone's audio while the call stays up. |
| `/call hangup` (`end`, `stop`, `off`) | Hang up. Speech already heard is still sent. |
| `/call status` | The call, its device and server, provider, model, turns sent and VAD settings. |
| `/stt [on\|ptt\|off\|cancel\|status\|key=value]` | Dictation, the same as a call but it never hangs up on silence. |
| `/ptt [on\|talk\|send\|cancel\|off\|status\|key=value]` | Push-to-talk dictation. |

The agent gets one tool, `end_call`. It hangs up the session's voice input when the conversation
is over, or when what it hears is not meant for it.

## Settings

Settings belong to each session. They are saved in the session's document and come back after a
restart:
- **Microphone:** `device=` (or `source=`, the Pulse source) and `server=` (the Pulse server).
- **STT, as TUI `/stt`:** `provider=`, `model=`, `language=`, `endpoint=`, `daemon_url=`,
  `energy=`, `insert=`, `commit=`, `min_speech=`, `timeout=` and the Azure auth keys.
- **Call:** `mode=vad|ptt` (what `/call` starts in), `deliver=followup|steer`, and
  `hangup_after=5m|off` (silence before a call hangs up).

An empty value (`server=`) removes a session's own setting. A value is checked before it is kept.

Defaults come in order:
1. settings.json `agentUtils.stt`, including the Azure auth it shares with `tts`;
2. then the worker's environment (`PI_STT_*`, `PI_RT_LOCAL_VAD_*`, `PULSE_SOURCE`, `PULSE_SERVER`);
3. then the session's values.

A session's values are an overlay passed to its own processes; `process.env` never changes.

Each session records with its own process:
- **Nix package (Linux):** the package's `pacat --record` with `--device` and `--server`.
- **`PI_RT_RECORD_CMD`, or the TUI's default recorder:** run with the session's environment.

Any number of sessions can hold calls at once, on the same or different microphones.

## State and clients

A session's settings and call are one Durable session document, `agent-utils.voice`:
- the call's kind and mode;
- its phase: listening, on-air, transcribing, armed or muted;
- turns sent, the words heard so far, any error;
- and the last call's outcome.

Each turn is submitted with the request id `voice:<task>:<n>`, so a turn retried after a restart
is not sent twice. The call is a Durable background task, which resumes at startup.

[`extensions/durable/voice-client.js`](../extensions/durable/voice-client.js) is the client part
for pi-client: list it in `client.extensions`. It follows the focused session's document and shows:
- the TUI's speech chip (`🎙 CALL`, `STT` or `PTT` and its phase), which the editor chips draw;
- a status line, such as `☎ call · vad · on-air · mic @ tcp:mac:4713 · 2 sent · “what is being said”`.

Every client of a session shows the same call. With no call live, the chip is left to the local
`/stt` and `/ptt`.
