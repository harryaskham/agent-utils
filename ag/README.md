# ag — agent feeds

A Rust CLI for agent speech, shared images, explicitly shared audio, Cursive canvases, pending agent questions and node health across a configured fleet. `ag image` opens a local browser gallery, `ag audio` a local audio player and `ag canvas` a wall of every node's canvases; `ag sync` refreshes images and audio; `ag dash` serves one live local page for all of it. No background daemon or automatic telemetry: `ag dash` listens only while it runs.

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
ag image                             # sync all enabled nodes, open the gallery
ag image pull                        # incremental bulk cache, no browser
ag image --offline                   # view cached images, no network
ag --host ms-mac --host sgu24 image
ag image --no-open --json             # write gallery and return its receipt
ag image pull --checksum              # repair corrupt same-size/mtime cached files
ag image list --limit 50
ag image list --agent my-agent --json
ag --host ms-mac image info 'my-agent/img-<id>.png'
ag --host ms-mac image get 'my-agent/img-<id>.png' -o screenshot.png
ag audio                             # sync all enabled nodes, open the audio player
ag audio pull                        # incremental audio cache, no browser
ag audio list --limit 20
ag audio play 'chirp-agent/aud-<id>.mp3' --sink studio
ag sync                              # every media pathway: images + audio
ag canvas                            # what every node's Cursive canvases show
ag canvas pull                       # list nodes, export only changed canvases
ag canvas list parity                # cached canvases whose id or text matches
ag --host helsinki canvas get plan -o plan.svg
ag sync --audio --offline            # one pathway, cache only
ag hosts
ag choices                           # answer pending agent questions (TUI)
ag choices list                      # print them; --all adds unanswerable ones
ag choices answer --node ms-dev --session ahp-session:/… --request choice-1 --option 2
ag doctor                            # per-node SSH, pi-daemon, bridge, Paratenic, speech, media
ag dash                              # live web view: choices, health, TTS, images, audio, canvases
```

## Fleet choices (`ag choices`)

Every pending agent elicitation — blocking `interactive_choice`, non-blocking `async_choice`, pi-daemon's `ask_user` and RPC dialogs — is read from each node's **AHP hosts** (`SessionState.inputNeeded`): its **pi-daemon** (Durable sessions), its **pi-daemon bridge** (the node's TUI Pis) and, when it runs, **Paratenic**. Each is independent; none needs another, so Paratenic can be disabled or absent. `ag` keeps no choices database and adds no Pi-side server.

`ag choices` is a TUI. The left rail groups questions by node and agent; the right pane is the selected question.

| Key | Action |
| --- | --- |
| `j`/`k`, `↑`/`↓` | Move between questions (rail) or options (question pane) |
| `J`/`K`, PgUp/PgDn | Move between questions from either pane |
| `Tab`/`l`, `Shift-Tab`/`h` | Switch pane (narrow terminals show one pane at a time) |
| `1`–`9`, `Enter` | Answer with that option / the highlighted option |
| `Space` | Toggle a multi-select option |
| `i` | Reply in your own words (when the question allows it) |
| `d` `d` | Decline (press twice) |
| `r` | Refresh now (otherwise every `--interval` seconds, default 60) |
| `q`, `Esc`, `Ctrl-C` | Quit and restore the terminal |

Mouse: click a question; click an option once to highlight, again to answer; the wheel scrolls either pane. Multi-question forms step through every question; Enter on an empty optional text field skips it.

`ag choices list [--all] [--json]` prints the same data. Each entry shows the exact `--node/--session/--request/--revision` for `ag choices answer`, which accepts `--option` (id, label or 1-based index), `--text`, `--answers '{"question-id": …}'` for forms, and `--response decline|cancel`.

Answers use the standard `chat/inputCompleted` action. Before dispatch, `ag` re-reads the authoritative session and refuses:

- **gone** — already answered elsewhere or withdrawn;
- **changed** — the request differs from the listed `--revision`;
- **unavailable** — stale catalogue, read-only chat, or backend/input authority offline (the same rules Culture applies).

Answers are validated locally exactly as Paratenic validates them (required questions, option ids, freeform permission, number/boolean kinds). The result is the host's echo of our exact client id and sequence: **accepted** or **rejected** (with reason). No echo before `paratenic.answer_timeout_seconds` is **indeterminate**: it may still apply, so re-list instead of retrying. Nothing is retried automatically. Exit status is 0 only for accepted.

Tool confirmations, client tool execution and authentication requests are listed with `--all` but must be handled in Culture.

### Endpoints

With no extra configuration, each node uses the Culture host with the same id from `~/.config/culture/config.yaml` (`$XDG_CONFIG_HOME` honored): URL, bearer token file and plaintext policy. Override per node:

```yaml
paratenic:
  enabled: true                                # false: no Paratenic; pi-daemon is unaffected
  # culture_config: ~/.config/culture/config.yaml
  # token_file: ~/.config/paratenic/token     # default when neither node nor Culture names one
  request_timeout_seconds: 15                  # every AHP endpoint (Paratenic, pi-daemon, bridge)
  answer_timeout_seconds: 30
  parallelism: 8                               # session snapshots per node
pi_daemon:
  enabled: true                                # each node's pi-daemon /ahp (Durable sessions)
  bridge: true                                 # each node's bridge /ahp (TUI Pis)
  # settings: ~/.pi/agent/settings.json        # pi-client's client.hosts
hosts:
  - name: ms-dev
    address: ms-dev
    paratenic:
      url: ws://ms-dev.example.ts.net:7788/ahp
      token_file: ~/.config/paratenic/token
      allow_plaintext_non_loopback: true       # ws:// off-loopback, e.g. inside a tailnet
      # culture_host: other-id                 # when the Culture id differs
      # enabled: false                         # skip this node's Paratenic only
    # pi_daemon: { enabled: false, bridge: false }   # skip this node's daemon / bridge
```

`paratenic.pi_daemon: false` (fleet) and `hosts[].paratenic.pi_daemon: false` (one node) still turn
pi-daemon and its bridge off, as before; `paratenic.pi_settings` still names the Pi settings file.

**pi-daemon agents.** Each node's pi-daemon serves AHP, and `ag choices`, `ag dash`,
`ag doctor` and `ag_choices_answer` query it whether or not Paratenic is enabled. `ag` speaks AHP 1.0 and offers 0.8.0 as well,
so it reaches Paratenic and pi-daemons not yet on 1.0:

- **Durable sessions** (`ask_user`): the daemon's `/ahp` (`client.hosts[].url`, port 7463).
- **TUI Pis**: the node bridge's `/ahp` (`client.hosts[].bridge`, port 7464; pi-daemon 1.11).
  A bridge without it (older pi-daemon) is listed as `unsupported`, not as a failure.
- **Where from:** pi-client's host list, `client.hosts[]` in `~/.pi/agent/settings.json`
  (`$PI_CODING_AGENT_DIR`; `pi_daemon.settings` overrides), with `/ahp` added to each URL.
  The bearer is the host's `tokenFile`, else `client.tokenFile`. Without a Pi client entry,
  Culture's `<node>-pi-daemon` and `<node>-pi` hosts are used for the daemon and the bridge.
- **Shown as:** groups under the node, `ms-dev · pi-daemon` and `ms-dev · pi-bridge`, each agent
  marked `daemon` or `tui`. Answer with `--node ms-dev-pi-daemon` or `--node ms-dev-pi-bridge`.
  JSON rows carry `node` and `source` (`paratenic`, `pi-daemon` or `pi-bridge`).
- **Duplicates:** a TUI Pi's question seen through both Paratenic and pi-daemon has one request
  id (agent-utils choice ids are unique across processes); pi-daemon's copy is kept.
- **Off:** `pi_daemon.enabled` / `pi_daemon.bridge`, fleet-wide or on one host.
- Speech and media stay per node: pi-daemon sessions (with Agent Utils' Durable `tts.mjs` and
  `media.mjs`) and the bridge's TUI Pis write the same node speech feed and image/audio
  archives that `ag tts`, `ag image`, `ag audio` and the dash read.

pi-daemon's `ask_user` exists only in profiles that load a module re-exporting
`InputExtension` (pi-daemon's docs/profiles); without it a session cannot ask.

TUI Pis publish `interactive_choice` and `async_choice` questions to pi-daemon's
`pi-durable-adaptor` on Pi's event bus as well as to Paratenic:
`pi-durable:question` `{ id, question, choices?, answer(text), cancel() }` when a question is
pending, and `pi-durable:question-done` `{ id }` when it settles. The first answer from any
surface wins.

`ws://` away from loopback requires `allow_plaintext_non_loopback`, matching Culture. Token files may be managed symlinks; they are read per connection and never logged. `--local` resolves this machine's Culture host by hostname.

Nodes that are down are reported quietly as **offline** (`not listening`, `timed out`, `unknown host`, `unreachable`) and never hide healthy nodes or change the exit status. Real failures — a refused bearer token, a protocol error — are errors (exit 3).

`ag` uses a small pool of stable logical client ids per host (flock-leased under `$XDG_STATE_HOME/ag/paratenic`) so repeated runs do not grow the host's client table; each id's `clientSeq` is persisted monotonically so a reused id never collides with an earlier dispatch.

## Fleet health (`ag doctor`)

One concurrent, bounded, read-only pass per node:

| Check | What it reads |
| --- | --- |
| `ssh` / `local` | `ag` reachability over SSH (or this machine) |
| `pi-daemon` | The daemon's `/ahp` session catalogue (sessions, waiting) and its unauthenticated `/readyz` (version, draining) |
| `pi-bridge` | The bridge's `/ahp` (TUI Pis, waiting) and `/readyz`; a bridge without `/ahp` (pi-daemon < 1.11) is a warning naming the fix |
| `paratenic` | Optional. AHP connect + session catalogue (sessions, live and stale input-needed, backends offline) and the plaintext `/status` probe when available (uptime, providers, lock contention); omitted when disabled or not configured |
| `speech` | Most recent durable speech request and any muted kinds |
| `images` | Last successful gallery sync from the local cache (no network) |
| `audio` | Last successful shared-audio sync from the local cache (no network) |

A node that answers neither SSH nor any AHP host collapses to one `offline` line. A node reachable over AHP but not SSH is a warning, as is a configured pi-daemon or bridge that is not answering on a reachable node. Paratenic is optional: when it is not running but pi-daemon serves the node it is shown as `○ … optional`, not a warning. "Sessions waiting" counts the daemon's waiting sessions plus the larger of the bridge's and Paratenic's live ones (a TUI Pi's question can show through both); stale Paratenic sessions whose backend is gone are counted apart. A node that never archived audio or images is synced and empty, not "not pulled yet". Exit 3 only for real errors; offline and warnings exit 0. `--json` and the `ag_doctor` MCP tool return the full report.

## Fleet loops (`ag loops`)

`ag loops` lists the automation running inside each node's pi-daemon sessions: every live `/loop`, `/after`, `/cron` and `/goal` (agent-utils' `loop.mjs` keeps them in each session's `agent-utils.loops` Durable document). It reads each daemon over `/chord` (the same address and token as its `/ahp`): `sessions.list`, then `session.document` for sessions active in the last 8 days (a loop's own ticks keep its session active), at most 128 per node, most recent first. A schedule rarer than that is missed until it next fires. Read-only, concurrent per node; unreachable nodes are listed quietly as offline.

```text
⟳ ms-mac  4 live · 41 sessions read
  cltv-switcher  /Users/harryaskham/collective
    #1   every 3h · next 1h9m  Check prebuild/autobuild health and disk capacity …
⟳ ms-dev-8  3 live · 22 sessions read
  culture-android  /home/harryaskham/.herdr/worktrees/paratenic/culture-improvements
    #9   every 30m · next 7s  Continue and get this working …
    #4   goal · 3/50 nudges  all Culture Android tests pass
```

`--json` and the `ag_loops_list` MCP tool return each node's sessions with their loops (`kind`, `prompt`, `interval_secs`, `cron`/`time_zone`, `next_at_ms`, a goal's `nudges`/`max_nudges`).

## Live dashboard (`ag dash`)

`ag dash` serves one page with **Choices**, **Health**, **Loops**, **TTS**, **Images**, **Audio** and **Canvases** tabs and opens it in the browser (`--no-open` prints the URL; `--json` prints `{url, address}`). It is a live server, not a generated file:

- choices are re-read from each node's pi-daemon, bridge and Paratenic whenever the page is open and the cached view is older than 20 s, after every answer (that node only), and every `dash.refresh_seconds` (default 300);
- health runs every `dash.refresh_seconds` and after each image pull;
- loops (as `ag loops`) are read on the same tick but at most every two minutes, a rough overview; the Loops tab's **Refresh** (or `r` there) reads them now, and its countdowns tick between reads;
- TTS starts **one shared collector per dashboard process**, reusing `ag tts`'s local file readers and remote SSH cursor/reconnect path. It starts with 20 recent lines per selected host and follows continuously, even with no browser open. Each browser reads the shared stream over authenticated SSE—not another set of SSH tails. This is the **speech-request text feed**, not an audio player or proof that a request played;
- the merged media sync (`ag sync`: images and shared audio) runs in the background every `dash.image_refresh_seconds` (default 300) while the dash is running; `--no-images` / `--no-audio` (`dash.audio`) serve that pathway's existing cache only. The Images and Audio tabs embed the same viewers as `ag image` / `ag audio`; `/audio/*` streams with HTTP ranges so clips can seek, and a sync never reloads the player while a clip is playing. See [fleet audio](../docs/ag-audio.md);
- canvases (as `ag canvas pull`) **follow the gateway's change stream** (`/v1/fleet/stream`): a burst of edits anywhere in the fleet (until 3 s pass quietly, at most 15 s) becomes one pull that exports only what changed, so boards update within seconds. `dash.canvas_refresh_seconds` (default 300) remains a backstop; the stream reconnects with backoff, and its state shows in the status line (`live`) and `/api/state` (`canvases.live`). The open viewer is updated in place (filters, scroll and an open board keep their place). `--no-canvases` (`dash.canvases`) serves the existing cache; **Pull now** lists immediately.

Each view has a bookmarkable link: `#choices`, `#health`, `#loops`, `#tts`, `#images`, `#audio`, `#canvases`, and `#choices/<host>/<request id>` for one question (selected once it is listed; clicking or `j`/`k` updates it). Tab switches add browser history, so Back returns to the previous view.

The page answers questions through the same path as the TUI and CLI. Keys: `j`/`k` move, `1`–`9` answer, `i` reply, `d` decline (twice), `r` refresh. Every answer's outcome (including endpoint or connection failures) is kept in `/api/state`'s `receipts` and logged to the service journal as `ag dash: answer <host> <session> <request>: <state>` — never the answer itself.

**Images, Audio and Canvases** each have **Pause auto-refresh**: the framed gallery or player stays still (scroll, filters, an open preview) while newer syncs wait as "newer images/clips waiting" until **Load new …** or **Resume**; it lasts until the page reloads. Their per-node sync status starts collapsed and remembers being opened or closed (browser storage), and their search/node/agent filters survive the dashboard showing a newer sync.

```yaml
dash:
  bind: 127.0.0.1:7795        # --bind overrides; wildcard binds are allowed
  access: auto                # --access auto|open|token (see Access below)
  # public_origin: http://helsinki.miku-owl.ts.net:7795  # --public-origin
  # token_file: ~/.local/state/ag/dash/token            # --token-file (token access only)
  refresh_seconds: 300        # --refresh
  image_refresh_seconds: 300  # --image-refresh; images and audio share this cadence
  audio: true                 # --no-audio disables audio pulls
  tts: true                  # --no-tts disables collection
  tts_lines: 20              # --tts-lines; 0–1000 per host on startup
  canvases: true             # --no-canvases serves the cached canvases only
  canvas_refresh_seconds: 300  # --canvas-refresh; one listing per node, changed exports only
```

Access: `dash.access` / `--access` chooses the token policy. **`auto`** (the default) needs **no token** when the listener is a loopback or Tailscale address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`): only this machine or the tailnet can reach it, and the network is the boundary. On a wildcard or LAN bind `auto` requires a token. `open` never asks for one (a wildcard bind then prints a warning); `token` always does. Whatever the mode, a bound address pins the `Host` header to its address, this machine's names (`helsinki`, `helsinki.<tailnet>.ts.net`) and the public origin, so DNS rebinding cannot reach it, and answers and refreshes still need the custom header and a same-origin `Origin`. An old `?token=` link to an open dashboard just redirects to `/`.

With a token, the printed URL carries a random per-run token that is exchanged once for an `HttpOnly; SameSite=Strict` cookie. `--token-file` / `dash.token_file` instead reads a persistent token, privately creating one if absent; existing managed symlinks are supported, while dangling links and group/world-readable files fail closed. In this mode stdout contains only the bare public URL and token-file path, **never the token**. Append `?token=<file contents>` for the first visit; the browser is redirected to the clean URL. `--public-origin` / `dash.public_origin` accepts a public HTTP(S) origin independently of the bind IP, advertises that URL and permits its hostname in the Host check. HTTPS public origins also mark the cookie Secure. In token mode every route requires it. Answers and refreshes also require a custom request header and a same-origin `Origin`, so other sites cannot submit forms. The gallery route serves only the generated index and verified archive files inside the cache (no traversal or symlink escape); images are served `nosniff` with a sandboxing CSP. Ctrl-C or service SIGTERM shuts down the HTTP listener. The Home Manager service supervises the entire process group, including image-pull/SSH children.

### Streaming speech (ag 0.5)

The **TTS** tab filters by node, speech kind and text/agent. Metadata sits above the message, matching the terminal feed. Scrolling up or **Pause** freezes the rendered history while collection continues; **Live · N new** returns to the tail. Tab switches preserve filters and scroll state. Hidden/background tabs disconnect their EventSource and resume from the last event ID on return. No audio is played, and no microphone or speech-provider settings are changed.

- `GET /api/tts` returns a bounded version-1 snapshot, node connection states, collector/subscriber counts, retained bytes and eviction counts.
- `GET /api/tts/events` sends `snapshot` and `feed` events with process-epoch-qualified IDs. `Last-Event-ID` (or `?after=<event-id>` on a new EventSource) resumes within retained history. `snapshot.reason` reports `initial`, `expired`, `restarted` or `invalid` when a complete replacement is necessary; no gap is silently presented as continuous history.
- The dashboard's access mode (cookie in token mode) and Host checks protect both endpoints. Cross-origin SSE is refused; keep-alives run every 15 seconds, reconnect retry is 2 seconds, responses are `no-store` / `X-Accel-Buffering: no`. A reverse proxy must pass streaming bodies without buffering. Tokens never enter SSE URLs.
- The in-memory journal keeps at most **500 events / 2 MiB of encoded entries** (whichever fills first), plus bounded node state; text is capped at **16 KiB per entry**, visibly marked when shortened. The original feed remains on its node; the dashboard writes no second transcript. The frontend retains at most 500 entries, batches renders at 100 ms, and keeps paused content stable. There are at most 32 simultaneous SSE connections; surplus requests receive 503 with retry guidance.
- Offline nodes remain quiet in the node summary; authentication/protocol errors stay visible in its expandable details. Slow readers never block the collector; falling outside retained history produces an explicit reset. Ctrl-C/SIGTERM cancels and reaps owned tails, closes streams, and bounds HTTP draining to four seconds even when a browser has stopped reading.

The TTS collector follows the same top-level `--local` / `--host` selection as the rest of dash. `--tts-lines 0` starts with new appends only. The finite CLI/MCP read remains `ag tts list` / `ag_tts_list`; SSE is a dashboard transport, not a new feed authority.

### Home Manager service

Both the root flake and `./ag` export `homeManagerModules.ag-dash` (also `default`). The module adds an opt-in Linux user service; it does not rewrite the existing ag/Culture configs, start Paratenic, open firewall ports, or install Tailscale Serve/Funnel routes.

```nix
{
  imports = [ inputs.agent-utils.homeManagerModules.ag-dash ];
  services.ag-dash = {
    enable = true;
    # package = pkgs.ag;                       # configured pkgs.ag, or the flake package
    bindAddress = "100.83.90.42";              # configurable IP; IPv6/wildcards supported
    port = 7795;
    publicOrigin = "http://helsinki.miku-owl.ts.net:7795";
    # access = "auto";                         # tailnet IP: no token; "token" to require one
    # configFile = "${config.xdg.configHome}/ag/config.yaml";
    # refreshSeconds = 300;
    # imageRefreshSeconds = 300;
    # tts = true;                             # same job; no extra service
    # ttsLines = 20;                           # startup history per host
    # images = true;
    # audio = true;                            # --no-audio when false
    # audioCacheDirectory = null;
    # canvases = true;                         # --no-canvases when false
    # canvasRefreshSeconds = 300;
    # canvasCacheDirectory = null;
    # environment.SSH_AUTH_SOCK = "/run/user/1000/ssh-agent";
  };
}
```

The service uses an immutable executable, runs without opening a browser, starts under `default.target`, and retries after five seconds if the configured IP is not yet available. User lingering must already be enabled to run while logged out. State defaults to `$XDG_STATE_HOME/ag`. With `access = "token"` (or `auto` on a non-tailnet address) the token is `$XDG_STATE_HOME/ag/dash/token`; `stateDirectory`, `tokenFile`, and `cacheDirectory` are configurable. Tokens stay outside the Nix store and journal. Do not put secret contents in `environment`.

After the operator activates Home Manager:

```sh
systemctl --user status ag-dash
journalctl --user -u ag-dash -n 30
# A tailnet bind needs no token: open http://helsinki.miku-owl.ts.net:7795/
# (with access = "token": cat ~/.local/state/ag/dash/token, then /?token=<token>)
```

The scoped service and runtime checks are `nix build .#checks.<system>.ag-dash-module` and `cargo test --test dash_service`; they cover defaults, disabled mode, IPv6/wildcard/custom listeners, argument quoting, persistent tokens and managed symlinks, named Host admission, and SIGTERM cleanup. Enabling the service is declarative: builds and pin updates do not start it; apply it with your usual Home Manager/system switch.

Human speech output is ordered by arrival when following (not a globally synchronized clock). Finite speech snapshots/images are sorted by producer timestamps. Each speech entry has a metadata header, a message body on the next logical line, and one blank line between entries:

```text
2026-10-07T08:09:09.894Z [ms-dev-2] [narrate] android-improvements
I started a recurring check for the Android release’s Play internal promotion status.

2026-10-07T08:09:16.270Z [ms-dev-2] [tts] android-improvements
I’ll check the release tags and latest Android workflow run.
```

`tts tail`, `tts tail --no-follow`, and `tts list` share this layout. Timestamps are dim, hosts cyan, speech types color-coded, and agent names bold, using your terminal palette; bodies use the normal foreground. Paragraph breaks (LF/CRLF) fold into spaces so each body stays on one logical line; long entries wrap naturally without truncation. Other terminal controls remain escaped. Text is otherwise preserved, including any prefixes already in the recorded message.

Color is automatic on stdout terminals, disabled on pipes or with nonempty `NO_COLOR` or `TERM=dumb`. `--color always` forces it (e.g. `ag tts tail --color always | less -R`); `--color never` disables it. These explicit choices override the environment. JSON, MCP, and peer records retain their original text and never include presentation styling.

Host errors go to stderr in human mode and remain structured in JSON. Healthy nodes continue independently while offline tails retry with bounded backoff. `--json` follow emits JSONL envelopes; it does not mix progress prose into stdout.

## Fleet-wide image gallery

**`ag image` without a subcommand opens the viewer.** It uses incremental rsync-over-SSH to pull every selected archive into `~/.cache/ag/images` (`XDG_CACHE_HOME` honored), validates registered image/sidecar pairs and SHA-256 checksums, then opens a private local `index.html`. It scans all registrations, not the recent `image list` limit of 100/1000. The viewer pages thumbnails so every item remains reachable without putting the whole fleet in the DOM.

Filter by node or agent, search labels/IDs, and click a thumbnail for a full-size preview. Arrow keys browse; +/− and Fit control zoom; dragging pans zoomed images; Escape closes the preview. Dark/light colors and narrow layouts are included. Browser-unsupported formats or decode failures have visible placeholders and original metadata, rather than disappearing from the catalog. Standard PNG/JPEG/GIF/WebP/SVG previews work; HEIC/TIFF support depends on the browser.

`ag image pull` performs the same sync/index operation without launching a browser. `--offline` uses only the cache; `--json` never launches a browser. `--cache-dir PATH` overrides local storage. `--host NAME` is repeatable, `--local` selects this machine, and no host flag selects all enabled configured nodes. A changed selection regenerates the gallery for that selection; other cached files remain intact.

Remote machines need **rsync**, not a newer `ag`, for the gallery/pull path. SSH uses the same configured executable, username, port, strict host-key verification and remote login environment as other `ag` operations. Configured image paths and per-node producer environment defaults resolve on the remote node. No remote install, service, archive mutation or deletion is performed. Raw get/info/list commands still require a remote `ag`.

The first pull transfers archive contents, so allow enough local disk space. Later pulls transfer only changed data; `--checksum` asks rsync to repair content mismatches even when size/mtime match. Transfers skip symlinks, devices/special files, deep descendants and files over 64 MiB. Only verified registered image/sidecar pairs enter the gallery. Invalid records and node errors are reported per host (CLI exit 3), while healthy/cached images remain usable. The cache is **additive**, retaining earlier registrations even if the source later removes them. Node sync times/states distinguish a collected snapshot from live fleet state. No background refresh or automatic eviction runs.

The generated page embeds only local metadata and image paths; it loads no CDN assets, analytics, network scripts or remote image URLs, and makes no network requests itself. Its content-security policy and text-only DOM construction prevent archive metadata from becoming active HTML. It is a private local artifact, not a published website. Root cache symlinks are supported; owned child directories may not be symlinks. UI index size is bounded to 64 MiB with an explicit error, never silent truncation. A per-cache advisory lock prevents overlapping writers. `gallery-acceptance.json` records the contract and tests.

## Fleet audio (`ag audio`, `ag sync`)

`ag audio` mirrors `ag image` for clips agents deliberately shared with the Pi `audio_share` tool or operators added with `/audio-add` ([audio reel](../docs/audio-reel.md)); TTS/narration/read/choices speech is never part of it. It rsyncs each node's audio archive into `~/.cache/ag/audio` (`gallery.audio_cache_dir`, `--cache-dir`), validates sidecars, SHA-256 and `audio/*` types, and writes a private CSP-locked player (filters, search, keyboard, auto-advance, unsupported-format fallbacks). `list`, `info`, `get` and `play` work like their image counterparts; `ag audio play` prefers a verified cached copy, otherwise fetches from one `--host`, and plays through Pulse (default, honouring `PULSE_SERVER`/`PULSE_SINK` or `PI_AUDIO_*`), sox or ffplay with `--backend/--server/--sink/--volume/--start`. It needs `ffmpeg` on PATH and is CLI-only.

`ag sync` pulls every media pathway at once under one `gallery.parallelism` budget; `--images`/`--audio` narrow it. A pathway that fails (for example a cache locked by another pull) is reported without hiding the other; exit 3 marks partial results. Details, configuration and visual evidence: [docs/ag-audio.md](../docs/ag-audio.md).

## Fleet canvases (`ag canvas`)

`ag canvas` shows what every node's [Cursive](https://github.com/harryaskham/tools/tree/main/cli/cursive) boards show. **A Cursive daemon that knows the fleet does the work over HTTP** (the gateway, `canvases.gateway`; by default this machine's own daemon on `127.0.0.1:7685`, which Helsinki runs):

1. `GET /v1/info` and one `GET /v1/fleet/canvases` per pull: every fleet node's canvases with their revisions, including nodes `ag` is not configured for (the gateway knows Collective's fleet). When that listing may be truncated (200 rows), each node is paged instead.
2. `GET /v1/hosts/NODE/canvases/ID/export?format=svg` **only for canvases whose revision changed** (or whose render is missing or failed, or the theme changed; `--force` re-exports all).
3. the renders, a manifest per node and one private viewer in `~/.cache/ag/canvases`.

The node's own Cursive renders, so `ag` never interprets canvas objects and every board looks as Cursive draws it. `/export` is Cursive **0.7.0**; a daemon from 0.6 answers through its `cursive_export` tool, which carries SVG up to 3 MiB.

**SSH is the fallback, not the transport.** A configured node (`hosts[]`) that the gateway cannot reach, or whose old daemon cannot carry an export, is tried with this machine's `cursive --remote` over SSH (`canvases.ssh_fallback`, default on). Nodes known only from the fleet never use SSH; a sleeping one (a phone) is reported quietly as `offline`. When the gateway itself is unreachable, or `canvases.gateway: ""`, every configured node goes over SSH as before (a node whose Cursive predates SVG export renders PNG; SVG is re-probed after six hours). An unreachable configured node keeps its cached renders and is reported as `unavailable` (CLI exit 3). A failed export keeps the previous render, shown with the revision it drew, and is retried on the next pull. The receipt and the viewer say how each node was reached (`daemon`, `ssh`, `local`, `cache`).

The viewer is a wall of boards at their true aspect, newest first: node and id, `r<revision> · objects · age`, and the text drawn on the board. A thin accent edge marks boards changed in the last pull, a warning edge stale renders. Search covers node, id, Cursive's cached OCR preview and the text on each canvas (from the SVG). Click a board for a full-viewport viewer: wheel zooms around the pointer, drag pans, `0` fits, `1` is actual size, ←/→ browse, **Live ↗** opens the board in the gateway's live, editable Cursive web view (`#/NODE/ID`), and the footer shows the command to open it in a terminal. The page is private and static, like the gallery: strict CSP, escaped embedded manifest, text-only DOM, no network.

```sh
ag canvas                      # pull changed canvases, open the viewer
ag canvas pull --json          # the receipt: gateway, per-node state and transport
ag canvas --offline            # rebuild the viewer from the cache
ag canvas list 'culture parity' -n 20
ag --host helsinki canvas get yoneda-goal-yoneda-core -o board.svg
ag --host pocket4 canvas get hipfire -o hipfire.svg   # a fleet-only node, by fleet name
```

```yaml
canvases:
  enabled: true
  gateway: http://127.0.0.1:7685   # a Cursive >= 0.6 daemon with the fleet; "" for SSH only
  # web_url: http://helsinki.miku-owl.ts.net:7685   # browser base for Live links
  ssh_fallback: true        # configured nodes the gateway cannot serve
  program: cursive          # this machine's cursive, for SSH
  format: svg               # svg (PNG fallback on old nodes over SSH) or png
  # theme: nord             # nord, charcoal, paper, terminal; unset: each node's theme
  include_notes: false      # also handwriting notes
  # cache_dir: ~/.cache/ag/canvases
  timeout_seconds: 60       # one request or cursive call
  parallelism: 4            # concurrent exports
  max_per_host: 200
hosts:
  - name: ms-mac
    address: ms-mac
    username: harryaskham
    cursive:
      # remote: mac         # SSH: a Cursive remote.hosts alias (other program/data dir)
      # enabled: false      # skip this node's canvases
```

`web_url` defaults to the gateway; for a loopback gateway the viewer served by `ag dash` uses its own host name on the gateway's port, so links work from other tailnet machines. The daemon has no authentication: keep it (and `gateway`) on loopback and the tailnet, as Cursive's Home Manager module does. HTTP calls are plain HTTP/1.0, bounded (4 MiB listing, 80 MiB render) with a deadline. For SSH, the default destination is `[username@]address`, or `ssh://[username@]address:port` off port 22. `canvas-acceptance.json` maps the contract to tests.

## Runtime speech mute

`ag tts mute` / `unmute` control node-wide audio policy, independently of individual sessions' on/off settings. With no type switches they affect **all** of `read`, `tts`, `narrate`, and `choices`; switches select only their union and leave the other types unchanged. With no `--host` they attempt every enabled configured node. Use `--host NAME` (repeatable) or `--local` to narrow the target.

Policy lives at `~/.local/state/agent-utils/tts/mute.json` (XDG state rules apply), independently of the PCM cache. `paths.tts_mute`, `--mute-state PATH`, and producer `PI_TTS_MUTE_PATH` support overrides; producers and `ag` must point to the same node-local file. Missing state means unmuted. The mute persists until explicitly changed, including across agent restarts.

Updated Agent Utils sessions suppress synthesis, stop active playback, and discard queued/in-flight speech of muted types. Per-type epochs prevent muted backlog from replaying after unmute. New speech is allowed immediately when unmuted; disabled session features stay disabled. Text feeds and narration text continue. Unrelated apps, realtime audio, and other clients of a remote Pulse server are not muted.

No daemon or polling writer is added. `ag` uses a private atomic write under a short-lived OS advisory lock; speech holds event-driven watches only while in flight (file-inode watches on macOS to avoid blocking directory-FSEvents teardown; directory watches elsewhere). A shared 200 ms **active-only metadata stat** covers missing files and dropped notifications, rebinding after atomic inode replacement; unchanged files are not reopened, and all watchers/timers close when the last utterance settles or aborts. There is no idle polling or queue-lock churn. Invalid/unreadable existing policy fails closed and should be inspected/repaired. New files are owner-only. Managed symlinks are preserved.

A successful receipt acknowledges the **policy write**, not synchronous audio-quiescence proof from every agent. A failed remote write can be unconfirmed (the reply may have been lost after application); `ag tts status` reconciles it. Mutations are not automatically retried. Targets need `ag` 0.2+ and updated Agent Utils; older running extensions cannot enforce the file. See [the control contract](https://github.com/harryaskham/agent-utils/blob/main/docs/speech-runtime-control.md).

## Durable producer data

Agent Utils writes to:

- `$XDG_STATE_HOME/agent-utils/tts/speech.jsonl` (default `~/.local/state/agent-utils/tts/speech.jsonl`).
- `$XDG_STATE_HOME/agent-utils/images/<agent-name>/img-<share-id>.<ext>`, with `<image>.json` provenance sidecars.
- `$XDG_STATE_HOME/agent-utils/audio/<agent-name>/aud-<share-id>.<ext>`, with `<clip>.json` sidecars adding optional `title`, `description`, `durationMs`, `sampleRate` and `channels`. Only explicit `audio_share` / `/audio-add` shares are archived.

`PI_AGENT_UTILS_STATE_DIR` overrides the common producer root. `PI_TTS_FEED_PATH`, `PI_SHARED_IMAGES_DIR` and `PI_SHARED_AUDIO_DIR` override individual producer destinations. Configure matching `paths` in `ag` if the sources are customized; artifact reads never rewrite another node's producer configuration, and mute commands change only the runtime policy file.

The speech feed records requests, not playback success. New-format entries include identity, timestamp, host, cwd, kind and full text; legacy entries remain readable. On first write to a missing durable feed, the old queue-adjacent `speech.jsonl` is atomically copied once, without deleting the original. Reload old Pi sessions so they stop appending to the old cache location. Late writes by still-old processes are not silently merged. Archives and feeds are intentionally retained indefinitely; queue cleanup, session teardown and preview clearing do not delete them. Protect/back up this private project data accordingly.

Producers can opt out with `PI_TTS_FEED_ENABLED=0`, `PI_SHARED_IMAGES_ENABLED=0` and `PI_SHARED_AUDIO_ENABLED=0`. `PI_INCOGNITO=1` always suppresses all three, bypasses the shared speech queue and disables automatic Cacophony/AHP publishing. It does not delete old archives or sandbox explicitly configured model/audio/profile endpoints.

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
  audio_dir: ~/.local/state/agent-utils/audio
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
gallery:
  # cache_dir: ~/.cache/ag/images
  # audio_cache_dir: ~/.cache/ag/audio
  rsync_command: rsync
  parallelism: 4
  sync_timeout_seconds: 300
connect_timeout_seconds: 10
command_timeout_seconds: 20
reconnect_seconds: 3
poll_ms: 500
```

Without a config, only the local machine is selected. With one, all enabled nodes are selected unless `--host NAME` is supplied. `--local` bypasses SSH/fleet selection. `--tts-feed` / `--image-dir` / `--audio-dir` override selected reader paths. `~/` resolves on the **target** machine, never on the collector. A remote node must have `ag` installed (or set its absolute `command`). SSH initializes the **remote account's login shell** (`$SHELL -lc`) before resolving that executable; the collector's PATH is never copied onto another node. Login-profile output is diverted to bounded SSH stderr so JSON and binary stdout stay clean. PATH configured only in interactive shell files should be moved to the login environment, or use an absolute `command`.

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

`ag_image_pull` provides the same gallery/cache operation over MCP/`ag call`, requires `confirmed=true`, and never opens a browser. Its `offline` option reindexes the local cache without network. It returns gallery path, counts and per-node status/warnings rather than dumping all images into model context.

`ag_audio_pull` and `ag_sync` (all pathways, `kinds` narrows) work the same way and also require `confirmed=true`; neither plays or returns audio bytes.

`ag_canvas_pull` (requires `confirmed=true`; `offline`, `force`) runs the canvas pull and returns per-node state, counts and the viewer path; `ag_canvas_list` reads the cache only (`query` matches ids and canvas text) and returns each canvas's revision, render path, OCR preview and bounded text.

`ag mcp stdio` exposes `ag_hosts_list`, `ag_tts_list`, `ag_tts_status`, `ag_image_list`, `ag_image_info`, `ag_audio_list`, `ag_audio_info`, `ag_choices_list`, `ag_loops_list`, `ag_doctor`, plus `ag_tts_mute` / `ag_tts_unmute` / `ag_choices_answer` (require `confirmed=true` after operator approval) and house `config_status`, `config_validate`, `config_schema`, and confirmation-gated `config_init` tools. `ag tools` lists schemas; `ag call TOOL '{...}'` invokes the exact same typed handler. Unending tails and binary downloads are CLI-only. Read operations never mutate archives. Remote peers use a private typed `ag node ...` protocol that ignores fleet config, preventing recursion. Speech-control writes use the same policy implementation as the local CLI and MCP.

Exit codes: `0` success/normal Ctrl-C or closed pipe; `1` command/config/I/O failure; `2` clap usage error; `3` finite fleet result with one or more failed nodes (healthy data is still returned), or an answer that was not accepted. Offline nodes in `choices`/`doctor` are reported but do not set 3. Configured paths/errors are local private diagnostic data. Human output escapes terminal control characters. Limits: 128 nodes, 1000 records per node/request, 8 MiB per speech line, 64 MiB image/response, 256 MiB audio clip, 64 KiB sidecar and a 200000-file archive scan. Incomplete appended lines are held until newline; malformed/oversized records are reported, not interpreted as commands. Images are checksum-verified before download; downloads refuse traversal, symlink escapes and overwrite of existing destinations.

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

`acceptance.json`, `fleet-acceptance.json`, `tts-dash-acceptance.json`, `audio-acceptance.json` and `canvas-acceptance.json` map contracts to tests. `cargo test --test canvas` runs the canvas pull against a fake `cursive` speaking the real CLI contract. `node ../scripts/ag-dash-audio-qa.mjs` (ffmpeg + Playwright; optional `PLAYWRIGHT_CHROMIUM`, `AG_AUDIO_QA_OUT`) validates the Audio tab in real Chromium with synthetic clips, including ranged seeking and playback surviving a background sync. `cargo test --test dash_tts` exercises real HTTP/SSE, multi-browser fan-out, replay/reset, rotation, slow consumers, auth, limits and shutdown with isolated real peer processes. `node ../scripts/ag-dash-tts-qa.mjs` (from `ag/`, Playwright installed; optional `AG_TEST_BIN`, `PLAYWRIGHT_MODULE`, `AG_TTS_QA_OUT`) validates actual Chromium rendering, filters, pause, tab/offline reconnect, plain-text safety, keyboard/narrow layouts and event-to-visible latency. It never visits live fleet data. `tests/fleet.rs` runs the real binary against an in-process fake Paratenic AHP host (`tests/support/fake_ahp.rs`) for listing, answering, rejection/staleness fences, offline nodes, the dash's auth/CSRF/gallery rules and a real pseudo-terminal TUI session. `cargo run --example fake_paratenic -- 2` starts demo hosts for visual QA. The process-boundary suite uses isolated state and a fake SSH executable to run real peer processes, test disconnection/cursor recovery, and prove child cleanup; it never connects to the operator's fleet. The current optional AHP bridge exposes input providers only, not attachment/resource registration; this package does not advertise unsupported AHP capabilities.
