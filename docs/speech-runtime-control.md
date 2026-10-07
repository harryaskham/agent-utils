# Node-wide runtime speech control

## Contract

- Pulse client/stream identities remain distinct: `/read`, `/tts`, `/narrate`, `/choices` (the choice UI command remains `/choice`). Custom command providers receive `PI_TTS_KIND` and `PI_TTS_STREAM_NAME`.
- `ag tts mute` and `ag tts unmute` set all four kinds on every enabled configured node. `--read`, `--tts`, `--narrate`, `--choices` select a union; omitted kinds retain their state. `--host NAME` selects nodes, `--local` selects only this machine.
- `ag tts status` reads current node policy. Missing state means unmuted. Mutations use one shared typed path for CLI, SSH peer and confirmation-gated MCP commands.
- Authoritative state: `$XDG_STATE_HOME/agent-utils/tts/mute.json` (default `~/.local/state/agent-utils/tts/mute.json`). `PI_AGENT_UTILS_STATE_DIR`, `PI_TTS_MUTE_PATH`, and reader/controller `paths.tts_mute` overrides follow the existing artifact-path conventions.
- State version 1 contains `muted` booleans and per-kind `epochs`. Each transition into mute advances that kind's epoch. In-flight synthesis/queued jobs carry their original epoch, so mute→unmute cannot replay stale speech.
- State writes are private, atomic and serialized by an OS advisory lock held only during an explicit mutation, never periodically. Managed file symlinks are preserved. Invalid or unreadable existing state fails closed; absence does not.
- Updated Agent Utils controllers check before synthesis; queued playback checks again at execution. Event-driven watches cancel active synthesis/playback on mute. Linux uses directory watches for rename/ancestor events. macOS watches existing file inodes instead: directory FSEvents teardown can synchronously stall Node's event loop for seconds. A shared 200 ms metadata-stat reconciler exists only while speech is in flight; it covers missing files/dropped events and rebinds when atomic replacement changes the inode (including managed symlink targets). Unchanged content is not reopened. No watcher or polling timer remains after speech completes/aborts. Muted speech is discarded, not paused for later replay.
- Muting is separate from per-session on/off settings and from the physical Pulse sink/server. It does not mute unrelated apps, realtime audio or remote servers' other clients. Text feeds/narration text continue. Custom shell commands must honor their abort signal/process-group termination; their final player can use `PI_TTS_STREAM_NAME` for its Pulse name.
- A successful control receipt acknowledges the durable policy write, not synchronous proof that every agent has finished stopping audio. Nodes with older Agent Utils/`ag` need updating. Remote writes are not automatically retried after an ambiguous SSH failure; read status to reconcile.

## Acceptance inventory

| ID | Evidence |
|---|---|
| NAME-1 | Controller and pacat argv tests for all four names; command-provider environment tests |
| MUTE-1 | Rust state tests: defaults, selective/all transitions, epochs, private atomic writes, symlinks, concurrent mutations, invalid state |
| MUTE-2 | CLI/MCP/SSH integration: local, selected/all nodes, partial failure, confirmation, no implicit config mutation |
| MUTE-3 | JS integration: no synthesis while muted; live interrupt; queued/recovered epoch fencing; immediate unmute for new speech; observer cleanup |
| MUTE-4 | Actual `ag` writer → JS speech-controller fixture in isolated state, without production audio/credentials |

Current validation includes all 30 `ag` Rust tests and the full JS suite with `AG_TEST_BIN` enabled: 1,820 passed, zero failures, one opt-in real-Pi smoke skipped. Ten consecutive control/playback integration runs cover notification/rebind races, symlink targets, repeated inode replacement, command termination, queued epoch fencing and cleanup. On Darwin arm64 / Node 26.8.1, 30 isolated control calls took p50 0.272 ms / p95 0.628 ms with no remaining observers; the old directory-watcher close alone took 125–1905 ms. The optional AHP bridge currently has no applicable generic runtime-policy registration; no unsupported capability is advertised.
