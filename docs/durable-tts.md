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

### Per-session host environment

A host can give the same module each session's own startup environment. This
matches a TUI Pi started with that session's variables without changing the shared
worker process:

```js
import { withSessionEnvFiles } from "@harryaskham/pi-daemon";
import { createDurableTtsModule } from "${pkg}/extensions/durable/tts-module.js";

const audio = createDurableTtsModule({
  sessionEnv: async ({ cwd }) => cwd
    ? (await withSessionEnvFiles(["{cwd}/../session.env"], { cwd, env: {} })).env
    : {},
});
export const commands = audio.commands;
export function observe(event, info) { return audio.observe(event, info); }
```

The session variables overlay the worker environment for `PI_TTS_*`,
`PI_NARRATE_*`, credentials, playback and settings special forms. For example, the
usual `agentUtils.tts.enabled` form that is false when `CACO_AGENT_ID` is set
keeps managed Cacophony agents quiet, while an agent profile that sets
`PI_TTS_ENABLED=1` starts speaking. `/tts` and `/narrate` still override either
default per session. A rewritten session environment reloads that session's
speech defaults.

`ag tts mute` and `ag tts unmute` work here as everywhere; see
[runtime speech control](speech-runtime-control.md).

## Commands

Commands change only the session they run in. Each replies through the
session's notification, which clients show and the model never sees.

Each session sounds apart, as in TUI Pi: with the Azure provider, a session's
`/tts`, `/narrate` and spoken choices take one voice from the pool
(`agentUtils.tts.voices`, `PI_TTS_VOICES`) and one stereo position
(`agentUtils.tts.panRange`, `PI_TTS_PAN_MIN`/`PI_TTS_PAN_MAX`), both from a
hash of the pi-daemon session id, over the configured default voice. A voice
chosen for the session (`/tts voice=…`, `/tts harry`) wins.

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

Narration works as in interactive Pi when the host offers the profile's models
(pi-daemon 1.12+ passes observers `modelRegistry`).
- **Before a batch:** the line is the agent's own reasoning summary or preamble when it wrote
  one. Otherwise a side completion with the narration model (`model=provider/id`,
  `PI_NARRATE_MODEL`, default `github-copilot/gpt-6-luna`) describes the batch from the tool
  names and arguments.
- **After a batch:** a side completion summarizes the outcome from the results.
- **Supersession:** a newer batch, or the final answer, supersedes narration still running.
- **Off the transcript:** side completions are never part of the conversation.
- **Fallback:** without models, or when a completion fails, the line is the tool names
  ("Running bash and read.", then "Finished …" or "… failed."); `/narrate status` shows the
  last error.

`text=` is refused with an explanation.

## Focus and solo

`/tts focus [on|off|toggle|status]` and `/tts solo […]` work as in TUI Pi, for one session at a
time. Each session has its own routing over the worker's environment:
- **Default output:** `PULSE_SERVER` and `PULSE_SINK` are every session's default.
- **Focus** sends that session's speech to the focus sink (`agentUtils.tts.focus`, default
  `vsink_focus`).
- **Solo** gives the session a Pulse sink of its own, named after the session.

The routing applies to each utterance, so sessions in one worker play to different sinks at the
same time. A session's focus and solo are saved with its settings and come back after a worker
restart. Its solo sink is removed when the worker lets the session go.

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

## The speech feed

Every line the module speaks (`tts`, `narrate` and `choices`) is also appended to
the node's speech feed, `~/.local/state/agent-utils/tts/speech.jsonl`
(`PI_TTS_FEED_PATH`), as interactive Pi does, whether or not it could be played.
`ag tts` and ag dash's TTS panel read it. A record's `session` is the pi-daemon
session id and its `cwd` the session's directory. Its `agent` is
`CACO_AGENT_NAME`, `CACO_SHORT_NAME` or the Cacophony identity, else
`pi-daemon-<directory name>` as for the session's [media shares](durable-media.md),
else `session-<id>`. `PI_INCOGNITO=1` or `PI_TTS_FEED_ENABLED=0` turns it off.

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
