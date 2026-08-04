# Slick

Slick is a fast, read-only-by-default Slack terminal client built with Rust,
Ratatui, and
[kittui](https://github.com/harryaskham/kittui)'s `ratakittui` graphical
chrome. It uses the same compact projection as the native `slack_*` Pi tools:
message text and provenance stay visible, repeated Web API metadata disappears,
and Slack Canvas HTML becomes bounded, rich Markdown.

## Run

```bash
nix run ./slick -- daemon       # sole rate-limit-aware Slack cache collector
nix run ./slick -- --client     # cache-only TUI; follows local atomic writes
nix run ./slick -- --client --daemon-url http://slick-host:7612  # authenticated SSE
nix run ./slick                 # legacy combined TUI + Slack worker
nix run ./slick -- --demo       # deterministic offline UI
nix run ./slick -- --demo --no-graphics
nix run ./slick -- --sync-once  # bounded live refresh into the cache
nix run ./slick -- --fetch-file F123  # cache one Canvas as Markdown
nix run ./slick -- --snapshot --page files  # deterministic file/Markdown render
nix run ./slick -- --snapshot --page dms --open  # opened conversation/thread layout
```

Slick reads the existing `~/.slack-mcp-tokens.json` credentials used by the
native Pi Slack tools. It never writes credentials to its cache. If Slack auth
expires, refresh it with `/slack-refresh` in Pi and press `Ctrl-R` in Slick.

## UI

Slick mirrors Slack's navigation shape:

- **Activity** combines mentions, unread DMs, and recent DM activity, grouping contiguous runs from one conversation under a single header.
- **Feed** streams one line per arriving item, newest first. Lines are deduplicated by identity: an edited or re-delivered item updates its existing line (marked `~`) instead of appending a second one. Persisted history is seeded in full on the first frame — it does not visibly repopulate on every launch. Only genuinely new refresh bursts are paced. `Enter` or a click opens the underlying conversation, thread or file.
- **Favorites** is a dedicated view over everything Slack has starred.
- **Direct messages** and **Channels** are complete, separately paginated API inventories normalized by name, favorite, recency, and unread state. Clicking either section opens a searchable, bounded overview before opening a conversation.
- The sidebar's channel list is ordered by **channels you have posted in recently** (`search.messages from:me`, seven-day window), backfilled through `conversations.info` so non-member channels still resolve to names.
- Slick mirrors Slack favorites via `stars.list`. Slack's arbitrary custom sidebar-section layout is not exposed by the supported Web API, so Slick presents Favorites/Active DMs/Channels over the complete inventory rather than pretending to reproduce private UI-only section metadata.
- Conversations read oldest → newest and open pinned to the newest message, like a chat client.
- Messages carrying replies can be opened as **threads** (`conversations.replies`); threads stack and `q` pops one level at a time.
- Permalinks render as an `open ↗` OSC 8 hyperlink rather than raw URLs, and URLs inside Markdown bodies become clickable in place.
- Slack proxies emoji through `slack-imgs.com`, which previously rendered one symbol three times (glyph, alt text and a doubly percent-encoded URL). Slick classifies images and drops the URL entirely. Unknown sources default to attachment, since an over-large image is obvious while a shrunken attachment is lost.
- With Kitty graphics available, images are fetched once into `$SLICK_CACHE_DIR/images` and drawn in place, as **two distinct treatments**:
  - **Emoji are punctuation.** They reserve exactly the two cells a unicode glyph occupies and are placed at `z=1` with `C=1`, so the cursor never advances and the surrounding sentence reads exactly as it would with a glyph in that position.
  - **Attachments are content.** They take an aspect-scaled block of their own, deliberately breaking flow rather than shrinking to fit a line.
  Without graphics, the same text renders with the placeholder and marker only, so nothing is lost.
- Opening a conversation lazy-loads its compact content.
- **Files** presents recent files in the middle pane and renders selected Slack
  Canvas content as rich Markdown on the right.
- Cached content appears immediately at startup while network work stays on a
  dedicated worker thread. Keyboard/mouse processing and painting never wait on
  Slack or disk I/O.

### Keys

| Key | Action |
|---|---|
| `1`…`6`, `h`/`l`, arrows | Switch Activity / Feed / Favorites / DMs / Channels / Files |
| `j`/`k`, arrows | Move selection, move between messages, or scroll the focused pane |
| `gg`, `G`, `0` | Top, bottom, home |
| `Enter` | Open/lazy-load a conversation or file; on a reply-bearing message, open its thread |
| `q` | Pop the thread stack, then fullscreen, then a hidden sidebar, then the conversation |
| `\` | Toggle sidebar visibility (any view) |
| `s` | Toggle a local favourite for the selected conversation |
| `T` | Cycle theme (slick, nord, slate) |
| `f` | Fullscreen the Markdown pane (messages, threads, Canvas) |
| `Tab` / `Shift-Tab` | Cycle sidebar/content/detail focus; always restores a hidden sidebar |
| `Ctrl-R` | Refresh the visible view plus the DM/channel list |
| `Ctrl-U` / `Ctrl-D`, `PageUp` / `PageDown`, `Space` | Page rich content |
| `/` | Filter cached names and files locally |
| `?` | Help |
| `Ctrl-C` | Quit |

Mouse clicks select navigation, conversations, notifications, files, and
reply-bearing messages (opening their thread). The wheel scrolls the focused
rich-content pane. Passive mouse motion never triggers a repaint, and bursts of
divider-drag samples are coalesced to the newest pointer coordinate before the
next graphical frame.

## Configuration

Slick reads `~/.config/slick/config.yaml` (override with `$SLICK_CONFIG` or
`--config`). Every key is optional; an absent file uses defaults.

```yaml
theme: nord            # slick (default) | nord | slate
graphics: true         # false behaves like --no-graphics
start-page: activity   # activity | feed | favorites | dms | channels | files
sidebar-width: 32      # cells
detail-percent: 64     # share of the content area given to the Markdown pane
refresh-interval-secs: 60  # legacy combined-mode cadence; ignored by --client
daemon-bind: 127.0.0.1:7612
daemon-url: null          # set on remote --client hosts, e.g. http://slick-host:7612
daemon-token-file: null   # default: ~/.config/slick/daemon-token
daemon-min-refresh-secs: 2
alerts: off            # off (default) | bell | notify (OSC 777 + bell)
mark-read-in-slack: false  # true also clears the unread badge in Slack itself
favorites:             # local favourites overlay, unioned with Slack stars
  - C0BELKU8YP6
```

### Alerts

A newly arrived mention or unread DM can announce itself, so Slick does not
have to be the focused window to be useful. `off` (the default) stays silent;
`bell` emits the terminal bell; `notify` adds an OSC 777 desktop notification
(Ghostty/kitty) with the bell as a fallback.

Only genuinely new items announce. Slick reuses the Feed's identity dedupe, so
an edited or re-delivered message updates its line without re-alerting, and a
whole refresh burst coalesces into a single announcement. The cached backlog
replayed at startup never alerts.

### Favourites
`is_favorite` comes from Slack `stars.list`. Slack's own sidebar *Favorites*
section lives in the `channel_sections` user pref, and
`users.channelSections.list` answers `team_is_restricted` on locked-down
workspaces, so that membership is not readable through the supported API.

Slick therefore shows **Slack stars ∪ local favourites**. Pressing `s` toggles a
local favourite and writes it to the config file; Slack's own stars are never
mutated.

## Read state

Slick keeps a **local read marker** per conversation (`read-markers` in the
config file): opening a conversation records the newest message you have seen,
and any unread/mention badge covered by that marker is cleared in Slick's own
view.

Markers only ever move forward, so re-opening an older view cannot resurrect
read conversations, and a message arriving after the marker badges the
conversation again. Comparison is numeric rather than lexical, so timestamps
remain correctly ordered.

By default this is purely local: Slack still shows the conversation unread in
its own clients. Set `mark-read-in-slack: true` to additionally send
`conversations.mark`, which clears the badge everywhere and makes Slick usable
as a primary client. That is **opt-in because it is a Slack mutation** — see
below.

## Daemon/client cache architecture

For reliable all-day use, run exactly one `slick daemon` per Slack identity and
open every TUI with `slick --client`. The daemon is the **only Slack API
consumer**. It maintains independent coverage records for identity, inventory,
activity, files, self-activity, and each eligible conversation; at each cycle it
selects the largest overdue gap rather than blindly refreshing whichever view is
focused. Missing coverage wins first, but absolute age ensures a quiet
conversation eventually beats repeatedly refreshed hot pages.

Every attempt and result is written atomically with truthful per-domain state:
`refreshing`, `healthy`, `partial`, `backoff`, or `error`. A health-only write can
make the JSON file 30 seconds old without making activity complete, so the TUI's
header uses the **visible domain's last complete refresh**, never the file mtime.
A partial mention search remains a partial gap; it cannot advance activity's
success timestamp. Search page cursors and their fixed window start are durable,
so large workspaces advance a page at a time across daemon cycles instead of
restarting at page one after every rate limit. The cache retains up to 5,000
activity/feed entries and 1,000 files. On Slack throttling the daemon publishes
the method and countdown immediately, obeys `Retry-After`, adds bounded jitter,
then applies a bounded global/domain backoff before trying the largest remaining
gap.

A local `--client` watches atomic cache replacements and never constructs
`SlackService`. Give it `--daemon-url` (or `daemon-url` in config) to fetch an
initial snapshot and consume `GET /events` as Server-Sent Events. It reconnects
with bounded exponential backoff and writes remote snapshots through the same
atomic cache, so it can render the last good state while disconnected. `Ctrl-R`
in client mode only reports that the client is waiting for daemon data; it never
falls through to Slack.

The daemon creates a random bearer token at
`~/.config/slick/daemon-token` (or `daemon-token-file` / `--token-file`) with
mode 0600. `/snapshot`, `/health`, and `/events` all require
`Authorization: Bearer …`; unsafe existing token permissions are refused. Copy
that token to remote clients through your secret manager and point their token
file at the copy. Plain HTTP does not encrypt the bearer: keep non-loopback binds
on a private/VPN network or behind a TLS tunnel/reverse proxy. Never commit the
token.

The first legacy live startup refreshes identity, separately paginates every accessible DM/group-DM and public/private channel, applies favorites, then loads mentions/DM activity, recent files, and a bounded set of active or unread DMs.
It requests no more than seven days when history is available. Responses are
cached at `$SLICK_CACHE_DIR/state.json` or the platform cache directory.

`Ctrl-R` does **not** redownload everything. It refreshes the DM/channel sidebar,
then only the visible target:

- Activity → mentions and DM activity
- DMs/Channels → selected conversation since its last refresh
- Files → recent-file search since the last refresh date

Slick also refreshes **automatically in the background** every
`refresh-interval-secs` (default 60; set `0` for manual-only). Each cycle runs
the same bounded, incremental visible-target refresh as `Ctrl-R` — never a
re-bootstrap — and is skipped whenever a Slack call is already in flight, so a
slow response can never queue up stale work. The interval is clamped to a floor
of 15s. The status line always shows the active data domain's complete-refresh age, so a recent unrelated cache write cannot hide hours of missing Feed activity.

Slack throttles aggressively (`search.*` especially). Slick honours `Retry-After`
on HTTP 429 and on `ok:false`/`ratelimited`, backing off exponentially with
jitter up to a cap, and reports throttling in the status line rather than
failing the refresh.

`slick --client` is structurally read-only against Slack: it has no Slack
service and cannot send, edit, react, join, mark read, or mutate presence. The
legacy combined client is read-only **by default**.

The single exception is opt-in and off by default: with
`mark-read-in-slack: true`, reading a conversation in Slick also sends
`conversations.mark` for it. That is the only Slack write Slick can perform. It
runs on the worker thread like every other Slack call, and is never dispatched
unless you enable it.

## Nix service modules

The Slick subflake exports `nixosModules.slick`, `darwinModules.slick`, and
`nixOnDroidModules.slick`; the agent-utils root flake re-exports the same names.
They run one persistent collector as a systemd user service, launchd user agent,
or Nix-on-Droid supervisord program respectively.

```nix
# NixOS: imports = [ inputs.agent-utils.nixosModules.slick ];
# macOS: imports = [ inputs.agent-utils.darwinModules.slick ];
# NOD:   imports = [ inputs.agent-utils.nixOnDroidModules.slick ];
services.slick = {
  enable = true;
  bind = "127.0.0.1:7612"; # use a private/VPN address for remote clients
  # tokenFile = "/run/secrets/slick-daemon-token"; # optional, owner-only
  # extraArgs = [ ];
};
```

NixOS installs `systemd.user.services.slick-daemon` with restart backoff;
nix-darwin installs `launchd.user.agents.slick-daemon`; Nix-on-Droid installs
`supervisord.programs.slick-daemon` and exports its home/XDG paths. With no
`tokenFile`, Slick generates its private token beside the configured YAML file.

## Graphics compatibility

Slick uses Ratakittui's scene/chrome/lifecycle model but places each chrome scene
as a **stable absolute `z=-1` underlay**. Ratakittui's generic implicit Unicode
placeholder placement (`z=0`, no placement id) accumulated offset gradient strips
and covered all text in the tested Ghostty/tmux path. Stable underlays remove the
placeholder grid, replace rather than accumulate placements, and keep ordinary
Ratatui text above the graphics. `--no-graphics` remains a universal fallback.

Three compatibility rules keep graphics stable during interaction:

- **Image-local chrome geometry.** Ratakittui 0.1 applies a pane's absolute x/y
  to layer geometry inside its footprint-sized PNG, then Kitty applies x/y a
  second time at placement. Slick rasterizes at `(0,0)` and retains x/y only in
  the placement footprint, avoiding clipped and offset pane backgrounds.
- **No cursor advance (`C=1`).** Every absolute chrome and inline-image
  placement uses Kittui's typed `without_cursor_advance()` option. A full-height
  panel or image can therefore never scroll the text plane one row, shift mouse
  hit geometry, or strand the footer below the viewport.
- **Placement reconciliation.** A scene is uploaded and placed only when its
  image id or cell footprint changes. Inline placements absent from the current
  frame are explicitly deleted, so scrolling moves an image instead of leaving
  copies at every historical coordinate.

OSC 8 escapes are never stored in Ratatui buffer symbols: doing so corrupts
`unicode-width` damage calculations and leaves stale cells. Slick records the
rendered link coordinates, then emits the clickable text directly after the
frame flush using absolute cursor moves.

## Development

```bash
nix develop ./slick
cargo test --manifest-path slick/Cargo.toml
cargo clippy --manifest-path slick/Cargo.toml --all-targets -- -D warnings
nix build ./slick#slick
```

The root `agent-utils` flake includes `slick` in its default `symlinkJoin`, so a
normal top-level installation also puts `slick` on `PATH`.
