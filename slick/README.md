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
```

Slick reads the existing `~/.slack-mcp-tokens.json` credentials used by the
native Pi Slack tools. It never writes credentials to its cache. If Slack auth
expires, refresh it with `/slack-refresh` in Pi and press `Ctrl-R` in Slick.

## UI

Slick mirrors Slack's navigation shape:

- **Activity** combines mentions, unread DMs, and recent DM activity.
- **Direct messages** and **Channels** are normalized by name and unread state.
- Opening a conversation lazy-loads its compact content.
- **Files** presents recent files in the middle pane and renders selected Slack
  Canvas content as rich Markdown on the right.
- Cached content appears immediately at startup while network work stays on a
  dedicated worker thread. Keyboard/mouse processing and painting never wait on
  Slack or disk I/O.

### Keys

| Key | Action |
|---|---|
| `1`…`4`, `h`/`l`, arrows | Switch Activity / DMs / Channels / Files |
| `j`/`k`, arrows | Move selection or scroll the focused pane |
| `gg`, `G`, `0` | Top, bottom, home |
| `Enter` | Open/lazy-load selected conversation or file |
| `Tab` / `Shift-Tab` | Cycle sidebar/content/detail focus |
| `Ctrl-R` | Refresh the visible view plus the DM/channel list |
| `Ctrl-U` / `Ctrl-D`, `PageUp` / `PageDown`, `Space` | Page rich content |
| `/` | Filter cached names and files locally |
| `?` | Help |
| `q`, `Ctrl-C` | Quit |

Mouse clicks select navigation, conversations, notifications, and files. The
wheel scrolls the focused rich-content pane.

## Refresh and cache contract

The first live startup refreshes identity, the conversation/user sidebar,
mentions/DM activity, recent files, and a bounded set of active or unread DMs.
It requests no more than seven days when history is available. Responses are
cached at `$SLICK_CACHE_DIR/state.json` or the platform cache directory.

`Ctrl-R` does **not** redownload everything. It refreshes the DM/channel sidebar,
then only the visible target:

- Activity → mentions and DM activity
- DMs/Channels → selected conversation since its last refresh
- Files → recent-file search since the last refresh date

The client is deliberately read-only: no sends, edits, reactions, joins, read
markers, or presence mutations.

## Development

```bash
nix develop ./slick
cargo test --manifest-path slick/Cargo.toml
cargo clippy --manifest-path slick/Cargo.toml --all-targets -- -D warnings
nix build ./slick#slick
```

The root `agent-utils` flake includes `slick` in its default `symlinkJoin`, so a
normal top-level installation also puts `slick` on `PATH`.
