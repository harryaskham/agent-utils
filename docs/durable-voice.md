# Voice input in pi-daemon sessions

[`extensions/durable/voice.mjs`](../extensions/durable/voice.mjs) gives pi-daemon sessions voice
input run by the daemon (bd-6ffaf9).

The daemon records the microphone, finds speech and transcribes it. It then submits each turn as
your message, by default as a steer: a busy agent gets it at its next step, not after its whole
turn (`send=`, below). It uses the same VAD, providers and settings as TUI `/stt`. The TUI's own
`/stt`, `/ptt`, `/rt` and `/cascade` stay local: they record the machine the TUI or pi-client runs
on and write into its editor. In pi-client, which loads `realtime-agent.js` as a client
extension, `/stt` and `/ptt` are those local ones, and `/call` is the daemon's.

List it in a pi-daemon profile's `extensions:` beside `tts.mjs`. A session's speech from
`tts.mjs` mutes its microphone while it plays.

## Commands

| Command | What it does |
| --- | --- |
| `/call [vad\|ptt] [key=value …]` | Start a voice call, or change the live one. With settings and no verb, a live call takes them; with none live, one starts, as TUI `/stt key=value` does. |
| `/call ALIAS [key=value …]` | Start a call with an alias's settings (below), for this call only. On a live call, switch it to them. |
| `/call aliases` | The aliases from settings.json. |
| `/call talk` | Push-to-talk: open the microphone (starting a call if none is live), then send what was said. Any client can press it. |
| `/call send`, `/call cancel` | End a push-to-talk turn, sending it or dropping it. |
| `/call mute`, `/call unmute` | Drop the microphone's audio while the call stays up. |
| `/call hangup` (`end`, `stop`, `off`) | Hang up. Speech already heard is still sent. |
| `/call status` | The call, its device and server, provider, model, turns sent and VAD settings. |
| `/call devices` | The microphones (Pulse sources) the session's server has, the chosen one marked. `device=` completes from them. |
| `/stt [ALIAS] [on\|ptt\|off\|cancel\|status\|key=value]` | Dictation, the same as a call but it never hangs up on silence. |
| `/ptt [ALIAS] [on\|talk\|send\|cancel\|off\|status\|key=value]` | Push-to-talk dictation. |

The agent gets one tool, `end_call`. It hangs up the session's voice input when the conversation
is over, or when what it hears is not meant for it.

## Settings

Settings belong to each session. They are saved in the session's document and come back after a
restart:
- **Microphone:** `device=` (or `source=`, the Pulse source) and `server=` (the Pulse server).
- **STT, as TUI `/stt`:** `provider=`, `model=`, `language=`, `endpoint=`, `daemon_url=`,
  `energy=`, `insert=`, `commit=`, `min_speech=`, `timeout=` and the Azure auth keys.
- **Delivery:** `send=steer|followup|interrupt` (`deliver=` is the older name). How a finished
  turn reaches an agent that is still working:
  - `steer` (the default): at the agent's next step, between tool calls.
  - `followup`: only after the agent's whole turn, however long.
  - `interrupt`: stop the agent's turn, then send. The session's background work goes on.

  settings.json `agentUtils.voice.send` (or `PI_VOICE_SEND`) sets the default for every session.
- **Call:** `mode=vad|ptt` (what `/call` starts in) and `hangup_after=5m|off`: how long a call
  stays up with no speech from either side. Your speech and the agent's (from `tts.mjs`) both
  count, and a reply that is still playing keeps it up.

An empty value (`server=`) removes a session's own setting. A value is checked before it is kept.
A `device=` the session's Pulse server does not have is refused, with the names it has; when the
server cannot be asked (`pactl` fails), the name is kept as given. The Nix package records
`pactl` beside `pacat`.

## Aliases: settings for one call

Aliases in settings.json `agentUtils.voice.aliases` name a whole voice setup. The older
`agentUtils.call.aliases` still works; `voice.aliases` wins on a name in both.

```json
"voice": {
  "send": "steer",
  "aliases": {
    "bt": "source=source.bluetooth sink=vsink_agent_call pan=0",
    "phone": "source=source.phone sink=vsink_agent_call pan=0"
  }
}
```

`/call bt` starts a call with them, and `/stt bt` and `/ptt bt` dictation; the TUI's and
pi-client's local `/stt bt` and `/ptt bt` use the same aliases. An alias's settings last only
while it runs. After a hang-up (by you, by `end_call`, or on silence) or `/stt off`, the session
is as it was: its own `/call` settings and its own `/tts` settings, nothing to reset by hand.
Settings typed after the alias go over it (`/call bt pan=0.3`). An alias may also set `mode=`,
`send=`, `hangup_after=`, `model=` and any other `/call` setting. An alias cannot be named after a
voice word, such as `status`.

Three settings are for the agent's speech during the call. `tts.mjs` reads them for the session
while the call is live:
- `sink=`: the Pulse sink the agent's replies, narration and spoken choices play on. It takes
  precedence over `/tts focus` and `/tts solo` for the call.
- `pan=`: -1 (left) to 1 (right). Use `0` (centre) when you are talking to one agent.
- `tts=on|off`: speak the agent's replies during the call even if `/tts` is off. It is on by
  default once `sink=` or `pan=` is given, as `/tts sink=` turns `/tts` on.

`sink=` and `pan=` can also be typed on a plain `/call`, `/stt` or `/ptt`, or on a live one to
change them. They always last for that run only. During a call, `/tts sink=` changes the session's own sink for after the call and says so; `/call sink=NAME` moves the call's speech. Other settings typed without an alias are kept for the session, as
before. `/call status` and `/tts status` show the call's own settings while it lasts.

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

**The meter.** While the focused session has a live call, `voice-client.js` samples the call's
microphone itself, from the Pulse source and server in the call's document. It opens a listener of
its own, named `/meter:<session>`, beside the daemon's: nothing streams from the daemon, and the
call's own recording is not touched. The chip then shows the level as the local `/stt` does. A
server this machine cannot reach shows no meter (and is not retried for 30 seconds), nor does a
call on the daemon's unnamed default server, which may be the daemon's own machine. Turn it off
with settings.json `agentUtils.voice.clientMeter: false` or `PI_VOICE_CLIENT_METER=0`.

**Ctrl-Space** in pi-client controls the daemon's call while the focused session has a live one:
with no local voice mode on, `realtime-agent.js` offers the press first, `voice-client.js` takes
it and sends `/ptt talk`, which toggles that call's push-to-talk. With no live call, and in TUI
Pi, Ctrl-Space is the local push-to-talk, which records this machine's microphone into the
editor.

## Names in the mixer

Every stream says whose it is, so a Pulse mixer (pavucontrol, `pactl list source-outputs`) shows
who listens and who speaks. Each name is a kind and the session's name, or a short session id
when it has none:
- **Listening:** `/call:harbour`, `/stt:harbour`, `/ptt:harbour` (the daemon's microphone),
  `/meter:harbour` (pi-client's meter), and `/stt:…` or `/ptt:…` for the local `/stt` and `/ptt`.
- **Speaking:** `/tts:harbour`, `/narrate:harbour`, `/choices:harbour`.

pi-daemon sessions read their name from the catalog (`/name`, or the session's catalog name);
TUI Pi from its session name.
