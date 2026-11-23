# Fleet models (`/fleet models`)

`/fleet models` answers "is gpt-6-astra still in use anywhere?" and does "switch every Astra
session over to Fable" in one command. It lists the live sessions on every node with their
model, filters them by a glob, moves the matching ones to another model with `--switch`, and
flags the config defaults that still name the old model.

It works in TUI Pi, in pi-daemon sessions (pi-client, the web view, Culture, AHP clients), in
pi-client itself and from a shell (`pi-fleet`), with the same arguments and report everywhere.

## Use

```text
/fleet models                                    every model in use: sessions per model and host
/fleet models '*astra*'                          the sessions on any Astra model, and config defaults naming one
/fleet models gpt-6-astra --switch github-copilot/claude-fable-5.2 --dry-run
/fleet models gpt-6-astra --switch github-copilot/claude-fable-5.2
/fleet models '*astra*' --host 'ms-dev-*' --since 7d --json
```

| Argument | Meaning | Default |
|---|---|---|
| `PATTERN…` | Globs (`*`, `?`, `[..]`, `[!..]`) or `/regex/`, ignoring case; any of them matches. A pattern without `/` matches the model id (`gpt-6-astra`, `*astra*`); one with `/` matches `provider/model` (`github-copilot/*`, `astra/*`). So `*astra*` finds `gpt-6-astra` and `gpt-6.2-astra` but not the `astra` provider's own models. | every model |
| `--switch provider/model` | Move the matching sessions to this model. A bare id is accepted when exactly one provider of the first host's catalog has it. | — |
| `--thinking LEVEL` | With `--switch`, also set the thinking level. It must be one the target model has. | unchanged |
| `--dry-run` | With `--switch`, check each session and say how it would move; change nothing. | — |
| `--direct` | With `--switch`, move Cacophony agents over `/chord` too, instead of through `caco agent set-model`. | — |
| `--since 30d` | Sessions active within this long (`90m`, `12h`, `7d`, `2w`, or `all`). | `30d` |
| `--host GLOB` | Only these hosts (repeatable, or comma-separated). `NAME-tui` is a host's TUI Pis. | every host |
| `--profile GLOB` | Only sessions of these profiles (`cacophony`, `personal`, `tui` for TUI Pis). | every profile |
| `--archived` | Include archived sessions. | left out |
| `--no-config` | Skip the config-default checks. | checked with a pattern |
| `--json` | The result as JSON. | text |

Without a pattern the report counts sessions per model:

```text
Models in use: 1534 sessions, 21 of 22 hosts read (active within 30d, archived left out)
  github-copilot/claude-opus-5.5   1378 · 15 working · 19 hosts
  github-copilot/gpt-6-astra         60 · 11 hosts
  github-copilot/claude-fable-5.2    48 · 9 working · 7 hosts
  github-copilot/gpt-6.2-sol         45 · 2 working · ms-dev-0, ms-dev-2, ms-dev-6, ms-dev-a

Not read:
  ms-mac-nixos: offline (timed out connecting to ws://ms-mac-nixos…:7463)
```

With a pattern it lists each matching session under its host (`NAME-tui` for TUI Pis), most
recently active first: the model, how long ago it was active, whether it is working, and who it
is. A Cacophony agent shows as `Cacophony PROJECT/AGENT`; other sessions show their title, id,
directory and profile. The id is what `pi-client HOST/ID` opens.

```text
*astra*: 60 sessions on 11 hosts, 21 of 22 hosts read (active within 30d, archived left out)

ms-dev-5 (10)
  github-copilot/gpt-6-astra · 24d · Cacophony cacophony/flow-8346ac965849527417a3
  …
sonance (10)
  github-copilot/gpt-6-astra · 20d · keygrid · chord-cce46e… · ~/.herdr/worktrees/tools/keygrid · personal
  …

Config defaults naming *astra*:
  settings.json: enabledModels[2] = github-copilot/gpt-6.2-astra  (~/.pi/agent/settings.json → ~/collective/standalone/pi/settings.json)
  cacophony config: providers.openai.models[0] = gpt-6-astra
  cacophony config: interactive_defaults.codex.model = gpt-6-astra
```

## Where sessions come from

Hosts are Pi's `settings.json` `client.hosts`, the list pi-client uses, plus this machine.
This machine is reached over loopback (`PI_DAEMON_URL`, else `http://127.0.0.1:7463`, and
`PI_DAEMON_BRIDGE_URL`, else `ws://127.0.0.1:7464`), the same way pi-client reaches it. The bearer
is the host's `tokenFile`, else `PI_DAEMON_TOKEN_FILE`, else `client.tokenFile`. Every host is
read at once:

- **pi-daemon sessions:** the daemon's `/chord` `sessions.list` with `withModel`, 100 at a
  time, newest activity first, until a page leaves the `--since` window. The model is the
  session's root conversation's, the one its next turn uses. Forks and side chats keep their own.
- **TUI Pis:** the bridge's `/chord` `sessions.list` (the host's `bridge` URL, pi-daemon 1.11+,
  with `pi-durable-adaptor` loaded in each TUI Pi).
- **Profiles:** each daemon's `profiles.list`, for the config check.

A host that does not answer is listed under "Not read" (`offline` or `error`) and never hides the
others. A bridge that is not configured is skipped quietly.

## Switching

`--switch` moves every listed session. First it reads the session's own model list
(`session.models`: per profile on a daemon, per TUI Pi), and a target that is not in it fails for
that session. A typo or a model one node lacks never reaches a session. Then:

- **Cacophony agents** (the pi-daemon session named by its agent id, in
  `~/.cacophony/agents/PROJECT/AGENT/checkout`; any other session in that directory is not the agent) go
  through `caco agent set-model --id AGENT --model provider/model`. That command switches the live
  runtime and records the model in Cacophony's agent record, so a restart keeps it. When
  Cacophony cannot reach the runtime (`model_runtime_not_resident` for a finished agent,
  `model_runtime_unsupported`, `agent_not_found`, and similar), the session is switched over
  `/chord`, and the report says the record still names the old model. Any other refusal fails
  that session with Cacophony's reason. An example is `agent_model_control_forbidden`, which an
  agent's own `caco` gets for other agents unless it holds `agent_model_control`. `--direct`
  switches the runtime over `/chord` instead.
- **Every other session** gets `/chord` `conversation.configure` with the model (and
  `--thinking`). The session's next turn uses it; a working session finishes its current turn on
  the old model.

A session already on the target (and thinking level) is left alone. Afterwards the affected hosts are read again, and the report ends with what is still on the
pattern (`Read again: no session in the window is on *astra* now.`). Run `--dry-run` first to see
each session's route. `pi-fleet` exits 3 when a session failed.

## Config defaults

With a pattern, references that still name a matching model are flagged, never edited:

- **This machine's `settings.json`** (Pi's agent directory): strings under keys naming a model
  (`defaultModel` with `defaultProvider`, `enabledModels`, `agentUtils.narrate.model`,
  `tendril.describeModel`, `compaction.summaryModel`, …) and the keys of `modelOverrides`. The
  `client` section is left out. When the file is a link, its target is shown; Collective's is
  `standalone/pi/settings.json`.
- **Each host's pi-daemon profile defaults** (`profiles.list`), grouped by profile and model with
  the hosts that have them. They come from Collective's Nix (`services.pi-daemon.profiles`).
- **Cacophony's derived config** (`caco config show --json`, when `caco` is installed): every
  `model` with its `provider` (projects' `agent_defaults`, persistent agents, `llm.*`,
  `interactive_defaults`) and the providers' model lists. The source is `cacophony-config`; see
  the pi-daemon-model-rollout skill's `caco-model-refs.sh` for the files.

## Install

- **TUI Pi:** part of the Agent Utils Pi package (`extensions/fleet.js`).
- **pi-client:** list `extensions/fleet.js` in `client.extensions` (from the package, or
  `durable-extensions/extensions/fleet.js`). It then runs on the client's machine, for any
  attached session. Without it, pi-client passes `/fleet` to the session's host, which runs it
  when its profile has the module.
- **pi-daemon:** list `fleet.mjs` of `packages.<system>.durable-extensions` in a profile's
  `extensions:`. It runs on the session's host, with that host's `settings.json`, bearer and
  `caco` (`CACO_BIN`). A long report is split across the command's notices (pi-daemon keeps 32 of
  16 KiB each). A report longer than that says what did not fit; use `--host`/`--since`, or
  `pi-fleet … --json`.
- **Shell:** `pi-fleet models …` (`packages.<system>.pi-fleet`, also in the root bundle), or
  `node scripts/pi-fleet.mjs models …` from a checkout. An agent asked "is X still in use" or
  "move every X session to Y" can run it directly.

## Limits

- Only pi-daemon sessions and TUI Pis with the adaptor are seen. Claude Code, Codex and other
  AHP agents that only Paratenic hosts are not.
- The model is the root conversation's. A fork or side chat that runs on another model is not
  listed or moved.
- Only this machine's `settings.json` is read; other nodes normally share Collective's copy.
