# Agent audio in pi-daemon sessions

`extensions/durable/tts.mjs` is a pi-daemon extension module that gives Durable
sessions the same agent audio as interactive Pi:

- `/tts` speaks the session's final assistant messages.
- `/narrate` speaks short lines about the session's tool work.
- Choice audio speaks the question and options when the agent calls pi-daemon's
  `ask_user` tool.

Audio plays on the host where the session runs, driven by the session's agent
events. It does not depend on any client being attached. `/read` (reading the
editor aloud) belongs to the client and is not part of this module.

## Installing

The flake exports the module with everything it loads:

```sh
nix build github:harryaskham/agent-utils#durable-extensions
ls result/tts.mjs
```

List `${pkg}/tts.mjs` under a pi-daemon profile's `extensions:`:

```nix
services.pi-daemon.profiles.work = {
  cwdRoots = [ "~/work" ];
  extensions = [ "${inputs.agent-utils.packages.${system}.durable-extensions}/tts.mjs" ];
  envFiles = [ "~/.config/pi/daemon/speech.env" ];  # credentials stay out of the store
};
```

On Linux the package records an absolute `pacat` from nixpkgs' PulseAudio, so the
worker's `PATH` does not need Pulse tools. Elsewhere, or for `backend=sox` or
`backend=ffplay`, the playback program must be on the worker's `PATH`.

The module is plain JavaScript over Agent Utils' shared speech libraries
(`extensions/lib/durable-agent-audio.js` and the `/tts` core in
`extensions/lib/tts-narration.js`). It needs only Node built-ins and never
imports a Pi TUI API.

## Configuration

Everything an operator sets lives in the worker's environment and Pi's
`settings.json`, the same as interactive Pi:

| Setting | Purpose |
| --- | --- |
| `PI_TTS_PROVIDER`, `PI_TTS_VOICE`, `PI_TTS_SPEED`, `PI_TTS_STYLE`, … | Provider, voice and prosody; see [speech providers](speech-providers.md). |
| `AZURE_SPEECH_API_KEY`, `AZURE_SPEECH_ENDPOINT`, `AZURE_SPEECH_AUTH` | Azure credentials (key or Entra). |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | OpenAI speech. |
| `TTS_DAEMON_URL`, `TTS_TOKEN_FILE`, `PI_TTS_PLAYBACK` | Tools speech daemon, including daemon-owned playback. |
| `PULSE_SERVER`, `PULSE_SINK`, `PI_TTS_BACKEND` | Where local playback goes. |
| `PI_TTS_ENABLED`, `PI_NARRATE_ENABLED` | Whether new sessions start with `/tts` or `/narrate` on (default off). |
| `PI_NARRATE_PHASES` | `before` (default), `after` or `both`. |
| `PI_CHOICE_SPEECH_ENABLED` | Speak `ask_user` questions (default on). |
| `PI_DURABLE_AUDIO_REPLAY_GRACE_MS` | Skip assistant messages older than this before the module loaded (default 60000; negative disables). |
| `agentUtils.tts`, `agentUtils.narrate`, `agentUtils.choice` in `settings.json` | Startup defaults, read once and never written. |

`ag tts mute` and `ag tts unmute` work here as everywhere; see
[runtime speech control](speech-runtime-control.md).

## Commands

Commands change only the session they run in. Each replies through the
session's notification, which clients show and the model never sees.

```text
/tts                    # on
/tts off                # off, and stop this session's /tts speech
/tts status             # settings, credentials, output and any recent error
/tts voice=en-GB-SoniaNeural speed=1.5 prefix='Build agent: '
/tts choices=off        # stop speaking ask_user questions
/tts harry              # the default voice with Harry's embedding

/narrate                # on, speaking before each tool batch
/narrate both           # before and after (also: before, after)
/narrate phases=after speed=2 style=cheerful styledegree=1.4
/narrate reasoning_summaries=off
/narrate off
/narrate status
```

`/tts` accepts the same speech `key=value` settings as interactive Pi. Literal
API keys are used but never stored; `api_key=$OPENAI_API_KEY` stores the
reference.

Narration differs from interactive Pi in one way: a Durable module has no model
registry, so it does not ask a model to summarize tool work. The line before a
batch is the agent's own reasoning summary or preamble when it wrote one, and
otherwise the tool names ("Running bash and read."). The line after a batch is
"Finished …" or "… failed.". Tool arguments and results are never read aloud.
`model=`, `text=`, `/tts focus` and `/tts solo` are refused with an explanation.

## Events

| Event | Speech |
| --- | --- |
| `message_end` with assistant text | `/tts`, unless `/narrate` is on and the message also calls tools. |
| `message_end` with tool calls | `/narrate` before-line for the batch. |
| `tool_execution_start` of `ask_user` | The question and its numbered options, on the `/choices` stream. |
| `tool_execution_start` of a tool with no batch | `/narrate` before-line for that tool alone. |
| `tool_execution_end` completing a batch | `/narrate` after-line. |

Both pi-daemon's event shape (`message_end.entry.model`) and the coding agent's
(`message_end.message`) are understood.

## Replays and state

Each session keeps two keys in its module state:

- `settings`: the `/tts` and `/narrate` toggles and speech values.
- `spoken`: the last 256 speech keys (entry ids, tool-call ids).

A speech key is written before the speech starts, so an event delivered again,
for example after a worker restart, is never spoken twice. When the host does
not yet provide per-session state, the module keeps both in memory for the life
of the worker and `/tts status` says so; assistant messages from before the
module loaded are then skipped by timestamp.

## When speech cannot play

`/tts on`, `/narrate on` and both `status` commands check the host. When
credentials are missing or the playback program cannot be found, the reply says
so once and events are skipped quietly. A failure while speaking is written to
the worker's log once per session and kind, and the next `/tts status` or
`/narrate status` shows it as `last-error`.
