# Slick

Slick is a fast, read-only Slack terminal client built with Rust, Ratatui, and
[kittui](https://github.com/harryaskham/kittui)'s `ratakittui` graphical
chrome. It uses the same compact projection as the native `slack_*` Pi tools:
message text and provenance stay visible, repeated Web API metadata disappears,
and Slack Canvas HTML becomes bounded, rich Markdown.

## Run

```bash
nix run ./slick                 # live Slack session
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

- **Activity** combines mentions, unread DMs, and recent DM activity.
- **Favorites** is a dedicated view over everything Slack has starred.
- **Direct messages** and **Channels** are complete, separately paginated API inventories normalized by name, favorite, recency, and unread state. Clicking either section opens a searchable, bounded overview before opening a conversation.
- The sidebar's channel list is ordered by **channels you have posted in recently** (`search.messages from:me`, seven-day window), backfilled through `conversations.info` so non-member channels still resolve to names.
- Slick mirrors Slack favorites via `stars.list`. Slack's arbitrary custom sidebar-section layout is not exposed by the supported Web API, so Slick presents Favorites/Active DMs/Channels over the complete inventory rather than pretending to reproduce private UI-only section metadata.
- Conversations read oldest → newest and open pinned to the newest message, like a chat client.
- Messages carrying replies can be opened as **threads** (`conversations.replies`); threads stack and `q` pops one level at a time.
- Permalinks render as an `open ↗` OSC 8 hyperlink rather than raw URLs, and URLs inside Markdown bodies become clickable in place.
- Opening a conversation lazy-loads its compact content.
- **Files** presents recent files in the middle pane and renders selected Slack
  Canvas content as rich Markdown on the right.
- Cached content appears immediately at startup while network work stays on a
  dedicated worker thread. Keyboard/mouse processing and painting never wait on
  Slack or disk I/O.

### Keys

| Key | Action |
|---|---|
| `1`…`5`, `h`/`l`, arrows | Switch Activity / Favorites / DMs / Channels / Files |
| `j`/`k`, arrows | Move selection, move between messages, or scroll the focused pane |
| `gg`, `G`, `0` | Top, bottom, home |
| `Enter` | Open/lazy-load a conversation or file; on a reply-bearing message, open its thread |
| `q` | Pop the thread stack, then fullscreen, then a hidden sidebar, then the conversation |
| `\` | Toggle sidebar visibility (any view) |
| `f` | Fullscreen the Markdown pane (messages, threads, Canvas) |
| `Tab` / `Shift-Tab` | Cycle sidebar/content/detail focus; always restores a hidden sidebar |
| `Ctrl-R` | Refresh the visible view plus the DM/channel list |
| `Ctrl-U` / `Ctrl-D`, `PageUp` / `PageDown`, `Space` | Page rich content |
| `/` | Filter cached names and files locally |
| `?` | Help |
| `Ctrl-C` | Quit |

Mouse clicks select navigation, conversations, notifications, files, and
reply-bearing messages (opening their thread). The wheel scrolls the focused
rich-content pane. Passive mouse motion never triggers a repaint.

## Refresh and cache contract

The first live startup refreshes identity, separately paginates every accessible DM/group-DM and public/private channel, applies favorites, then loads mentions/DM activity, recent files, and a bounded set of active or unread DMs.
It requests no more than seven days when history is available. Responses are
cached at `$SLICK_CACHE_DIR/state.json` or the platform cache directory.

`Ctrl-R` does **not** redownload everything. It refreshes the DM/channel sidebar,
then only the visible target:

- Activity → mentions and DM activity
- DMs/Channels → selected conversation since its last refresh
- Files → recent-file search since the last refresh date

The client is deliberately read-only: no sends, edits, reactions, joins, read
markers, or presence mutations.

## Graphics compatibility

Slick uses Ratakittui's scene/chrome/lifecycle model but places each chrome scene
as a **stable absolute `z=-1` underlay**. Ratakittui's generic implicit Unicode
placeholder placement (`z=0`, no placement id) accumulated offset gradient strips
and covered all text in the tested Ghostty/tmux path. Stable underlays remove the
placeholder grid, replace rather than accumulate placements, and keep ordinary
Ratatui text above the graphics. `--no-graphics` remains a universal fallback.

Two further host-side rules keep graphics stable during interaction:

- **Placement diffing.** A scene is re-placed only when its image id or cell
  footprint changes, so idle repaints (for example the one-second staleness
  timer) emit no graphics traffic at all.
- **Cursor preservation.** Kitty placement commands move the real cursor while
  Ratatui still tracks its own position, which made text drift and scroll away
  under mouse movement. Slick wraps every graphics transaction in `ESC 7` /
  `ESC 8` so the next text diff starts from the position Ratatui expects.

OSC 8 hyperlinks are emitted in two-character cell chunks, matching the
workaround in ratatui's own hyperlink example, because `unicode-width`
mis-measures escape bytes and would otherwise blank the following cells.

## Development

```bash
nix develop ./slick
cargo test --manifest-path slick/Cargo.toml
cargo clippy --manifest-path slick/Cargo.toml --all-targets -- -D warnings
nix build ./slick#slick
```

The root `agent-utils` flake includes `slick` in its default `symlinkJoin`, so a
normal top-level installation also puts `slick` on `PATH`.
