# ag — agent feeds

A small Rust CLI for reading agent speech and durable shared images on one machine or across a configured SSH fleet. No daemon, listening port, TUI, or automatic telemetry.

```sh
ag tts tail                           # all configured nodes, live until Ctrl-C
ag tts tail --no-follow -n 10         # finite recent history per node
ag --host ms-mac --host sgu24 tts tail
ag --local tts list -n 100 --json
ag tts mute                          # all four types, all enabled nodes
ag tts unmute                        # clear all four on all enabled nodes
ag --host ms-mac tts mute --narrate --choices
ag --local tts unmute --read --tts
ag tts status
ag image list --limit 50
ag image list --agent my-agent --json
ag --host ms-mac image info 'my-agent/img-<id>.png'
ag --host ms-mac image get 'my-agent/img-<id>.png' -o screenshot.png
ag hosts
```

Human speech output is ordered by arrival when following (not a globally synchronized clock). Finite speech snapshots/images are sorted by producer timestamps. Every line identifies its source node. Host errors go to stderr in human mode and remain structured in JSON. Healthy nodes continue independently while offline tails retry with bounded backoff. `--json` follow emits JSONL envelopes; it does not mix progress prose into stdout.

## Runtime speech mute

`ag tts mute` / `unmute` control node-wide audio policy, independently of individual sessions' on/off settings. With no type switches they affect **all** of `read`, `tts`, `narrate`, and `choices`; switches select only their union and leave the other types unchanged. With no `--host` they attempt every enabled configured node. Use `--host NAME` (repeatable) or `--local` to narrow the target.

Policy lives at `~/.local/state/agent-utils/tts/mute.json` (XDG state rules apply), independently of the PCM cache. `paths.tts_mute`, `--mute-state PATH`, and producer `PI_TTS_MUTE_PATH` support overrides; producers and `ag` must point to the same node-local file. Missing state means unmuted. The mute persists until explicitly changed, including across agent restarts.

Updated Agent Utils sessions suppress synthesis, stop active playback, and discard queued/in-flight speech of muted types. Per-type epochs prevent muted backlog from replaying after unmute. New speech is allowed immediately when unmuted; disabled session features stay disabled. Text feeds and narration text continue. Unrelated apps, realtime audio, and other clients of a remote Pulse server are not muted.

No daemon or polling writer is added. `ag` uses a private atomic write under a short-lived OS advisory lock; speech holds event-driven directory watches only while in flight. Since macOS can drop a cold-start/atomic-rename notification, a shared 200 ms **active-only metadata stat** reconciles changes; unchanged files are not reopened, and all watchers/timers close when the last utterance settles or aborts. There is no idle polling or queue-lock churn. Invalid/unreadable existing policy fails closed and should be inspected/repaired. New files are owner-only. Managed symlinks are preserved.

A successful receipt acknowledges the **policy write**, not synchronous audio-quiescence proof from every agent. A failed remote write can be unconfirmed (the reply may have been lost after application); `ag tts status` reconciles it. Mutations are not automatically retried. Targets need `ag` 0.2+ and updated Agent Utils; older running extensions cannot enforce the file. See [the control contract](https://github.com/harryaskham/agent-utils/blob/main/docs/speech-runtime-control.md).

## Durable producer data

Agent Utils writes to:

- `$XDG_STATE_HOME/agent-utils/tts/speech.jsonl` (default `~/.local/state/agent-utils/tts/speech.jsonl`).
- `$XDG_STATE_HOME/agent-utils/images/<agent-name>/img-<share-id>.<ext>`, with `<image>.json` provenance sidecars.

`PI_AGENT_UTILS_STATE_DIR` overrides the common producer root. `PI_TTS_FEED_PATH` and `PI_SHARED_IMAGES_DIR` override individual producer destinations. Configure matching `paths` in `ag` if the sources are customized; artifact reads never rewrite another node's producer configuration, and mute commands change only the runtime policy file.

The speech feed records requests, not playback success. New-format entries include identity, timestamp, host, cwd, kind and full text; legacy entries remain readable. On first write to a missing durable feed, the old queue-adjacent `speech.jsonl` is atomically copied once, without deleting the original. Reload old Pi sessions so they stop appending to the old cache location. Late writes by still-old processes are not silently merged. Archives and feeds are intentionally retained indefinitely; queue cleanup, session teardown and preview clearing do not delete them. Protect/back up this private project data accordingly.

Producers can opt out with `PI_TTS_FEED_ENABLED=0` and `PI_SHARED_IMAGES_ENABLED=0`. `PI_INCOGNITO=1` always suppresses both, bypasses the shared speech queue and disables automatic Cacophony/AHP publishing. It does not delete old archives or sandbox explicitly configured model/audio/profile endpoints.

Images are copied for tool-result image blocks (including MCP images and image reads), explicit Kitty gallery additions/captures/samples, and assistant/custom image messages and local Markdown image references. Original bytes are preserved; PNG/JPEG/GIF/WebP and other declared image formats retain their extensions. Sidecars record SHA-256, MIME type, size, agent/session/host/cwd, originating tool/event/path/label and optional dimensions. Safe directory names retain the original name in metadata. Replay of the same event/image is idempotent. Files are private (`0600`) and atomically published; metadata is the commit marker.

Private user uploads, arbitrary image URLs and background UI-only live-preview frames are not implicitly copied. Use an explicit capture/sample to preserve a live frame. No network fetch is performed to scrape images from prose. Logging/copy errors warn without breaking the original speech/share. Archiving begins when the updated extension is loaded; it does not retroactively scrape old sessions.

## Configuration

`~/.config/ag/config.yaml`, with `--config` > `$AG_CONFIG` > `$XDG_CONFIG_HOME/ag/config.yaml` > the home default. Symlinked Collective-managed YAML is supported and edits preserve the symlink target.

```yaml
version: 1
paths:
  # Omit to use XDG_STATE_HOME and producer environment defaults on each node.
  tts_feed: ~/.local/state/agent-utils/tts/speech.jsonl
  image_dir: ~/.local/state/agent-utils/images
  tts_mute: ~/.local/state/agent-utils/tts/mute.json
hosts:
  - name: local
    local: true
  - name: ms-mac
    address: ms-mac
    username: harryaskham
    port: 22
  - name: sgu24
    address: sgu24
    username: nix-on-droid
    port: 8022
    # Optional per-node paths and installed executable:
    # command: /absolute/path/to/ag
    # paths:
    #   tts_feed: ~/different/speech.jsonl
connect_timeout_seconds: 10
command_timeout_seconds: 20
reconnect_seconds: 3
poll_ms: 500
```

Without a config, only the local machine is selected. With one, all enabled nodes are selected unless `--host NAME` is supplied. `--local` bypasses SSH/fleet selection. `--tts-feed` / `--image-dir` override selected reader paths. `~/` resolves on the **target** machine, never on the collector. A remote node must have `ag` installed (or set its absolute `command`). SSH initializes the **remote account's login shell** (`$SHELL -lc`) before resolving that executable; the collector's PATH is never copied onto another node. Login-profile output is diverted to bounded SSH stderr so JSON and binary stdout stay clean. PATH configured only in interactive shell files should be moved to the login environment, or use an absolute `command`.

Running `cltv-run ag` or `nix run .#ag` on the collector does **not** install `ag` on remote nodes. If it is still unavailable after login initialization, apply each node's updated Collective configuration (operator-run switch) or point `hosts[].command` at an already installed executable. The transport reports this explicitly and never runs a remote build/install or system switch on your behalf.

SSH uses existing keys/agent/config, configured usernames and ports, batch mode, strict host-key verification, connection deadlines and keepalives. No passwords, keys, remote shell snippets, credential copying, or new services are configured by `ag`.

```sh
ag config path
ag config status
ag config show
ag config init
ag config validate
ag config schema
ag config export
ag config import reviewed.yaml --force
ag completions zsh
```

## MCP and JSON

`ag mcp stdio` exposes `ag_hosts_list`, `ag_tts_list`, `ag_tts_status`, `ag_image_list`, `ag_image_info`, plus `ag_tts_mute` / `ag_tts_unmute` (require `confirmed=true` after operator approval) and house `config_status`, `config_validate`, `config_schema`, and confirmation-gated `config_init` tools. `ag tools` lists schemas; `ag call TOOL '{...}'` invokes the exact same typed handler. Unending tails and binary downloads are CLI-only. Read operations never mutate archives. Remote peers use a private typed `ag node ...` protocol that ignores fleet config, preventing recursion. Speech-control writes use the same policy implementation as the local CLI and MCP.

Exit codes: `0` success/normal Ctrl-C or closed pipe; `1` command/config/I/O failure; `2` clap usage error; `3` finite fleet result with one or more failed nodes (healthy data is still returned). Configured paths/errors are local private diagnostic data. Human output escapes terminal control characters. Limits: 128 nodes, 1000 records per node/request, 8 MiB per speech line, 64 MiB image/response, 64 KiB image sidecar and a 200000-file image scan. Incomplete appended lines are held until newline; malformed/oversized records are reported, not interpreted as commands. Images are checksum-verified before download; downloads refuse traversal, symlink escapes and overwrite of existing destinations.

Live feeds retain byte cursors in memory across reconnects, detect inode replacement and observed truncation, and resume without replaying already delivered records. Stopping and restarting `ag` intentionally starts a new last-N view. Ctrl-C cancels and reaps local SSH children; remote peers stop on stdin EOF. Reads poll at the configured interval but do not touch queue locks or rewrite feeds. A stalled node cannot block other tail producers.

## Build and delivery

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo fmt --check
nix build .#ag --no-link            # from ag/
nix build .#ag --no-link            # from repository root
nix run .#ag -- --help
```

Root `agent-utils` packages/bundle include `bin/ag`; the root overlay exposes `pkgs.ag`. Collective owns permanent installation. After its input pin is updated, `cltv-run ag -- --help` tests the configured package before the next operator-run switch. Do not install a competing Cargo/profile binary. This Nix-only lane deliberately has no self-updater that could overwrite immutable store files, and no feedback submission of private transcripts/images. `mcp-cli-core` and `configurable-cli` provide the shared typed contracts.

`acceptance.json` maps contracts to tests. The process-boundary suite uses isolated state and a fake SSH executable to run real peer processes, test disconnection/cursor recovery, and prove child cleanup; it never connects to the operator's fleet. The current optional AHP bridge exposes input providers only, not attachment/resource registration; this package does not advertise unsupported AHP capabilities.
