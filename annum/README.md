# Annum

Annum is a deterministic Outlook + Teams terminal client built with Rust,
Kittui, `mcp-cli`, `remote-cli`, `configurable-cli`, and Microsoft's official
WorkIQ MCP server.

Plain `annum` opens the graphical smart client. The same domain functions back
terse CLI commands and an MCP server:

```sh
annum                              # Kittui smart client
annum daemon                       # central WorkIQ collector + cache + SSE
annum log -n 100                    # current daemon service log
annum log -f                        # follow daemon log
annum log --stream all -f           # stdout + stderr
annum email list --unread
annum email get --id MESSAGE_ID
annum calendar list
annum calendar get --id EVENT_ID
annum chat list
annum chat get --id CHAT_ID
annum teams list
annum teams channels --team-id TEAM_ID
annum teams get --team-id TEAM_ID --channel-id CHANNEL_ID
annum search "architecture review" # deterministic local cache
annum search --semantic "..."       # explicit WorkIQ retrieval
annum copilot ask "prepare me for my next meeting"
annum mcp stdio                 # cache + daemon only (default)
annum mcp stdio --standalone    # explicit cache/direct-WorkIQ fallback
```

The main application is not generative. Email, calendar, chat, channel, and
local search surfaces are projections of bounded Graph-shaped WorkIQ fetches.
`copilot ask` and `search --semantic` are explicit opt-in commands and have
separate MCP tools.

Normal `annum mcp stdio` never starts WorkIQ: deterministic reads come from the
cache/daemon and explicit semantic or mutation tools use the daemon's
authenticated command conduit. `--standalone` is the deliberate escape hatch
for cache plus direct WorkIQ fallback when operating without a daemon.

## Authentication

Annum does not read Edge cookies, desktop-app databases, or Microsoft tokens.
It starts the official pinned package as a persistent MCP child:

```text
npx -y @microsoft/workiq@1.0.0 mcp --log-level None --account <account>
```

Authenticate once with WorkIQ itself:

```sh
npx -y @microsoft/workiq@1.0.0 auth login
npx -y @microsoft/workiq@1.0.0 config set account you@example.com
```

Or set `workiq.account` in Annum config / pass `--account`. WorkIQ retains token
ownership; Annum's durable cache contains selected M365 content but no tokens.

For managed installations, placing a `workiq` executable on `PATH` and setting
`workiq.command: workiq` avoids `npx` startup entirely.

## Daemon/client architecture

Annum uses the same canonical `remote-cli` substrate as Slick:

- one daemon owns WorkIQ traffic;
- initial bounded backfills advance one page per collector cycle;
- opaque Graph `nextLink` cursors survive restarts, while newest pages are
  revisited after completion so edits/read state converge;
- inbox, sent mail, event, chat-message, and channel-message deltas are
  independent domains;
- a rolling calendar view provides deterministic recurrence instances;
- cache writes are atomic and owner-only;
- clients paint the local cache immediately, fetch `/snapshot`, and follow
  authenticated `/events` SSE;
- remote SSE snapshots write through to the local cache and deduplicate by
  collector revision;
- `unix:///absolute/path.sock` and HTTP(S) use the same protocol;
- if cache and daemon stop progressing, one local client may acquire the
  fallback lease and run a bounded embedded sync.

The daemon exposes:

```text
GET  /snapshot
GET  /snapshot/email
GET  /snapshot/calendar
GET  /snapshot/chats
GET  /snapshot/teams
GET  /health
GET  /events
POST /refresh?domain=<domain>
```

Every endpoint, including Unix sockets, requires the owner-only bearer token.

## Configuration

Annum reads `$ANNUM_CONFIG`, then
`$XDG_CONFIG_HOME/annum/config.yaml`, then
`~/.config/annum/config.yaml`. Every section is defaulted.

```yaml
workiq:
  command: npx
  args: [-y, "@microsoft/workiq@1.0.0", mcp, --log-level, None]
  account: you@example.com
  timeout-secs: 90

client:
  cache: true
  daemon: true
  daemon-url: http://127.0.0.1:7621
  token-file: null
  fallback: true
  fallback-timeout-secs: 90

daemon:
  bind: 127.0.0.1:7621
  unix-socket: null
  token-file: null
  min-refresh-secs: 2

collector:
  mail-refresh-secs: 30
  calendar-refresh-secs: 60
  chats-refresh-secs: 30
  teams-refresh-secs: 120
  mail-backfill-days: 30
  calendar-past-days: 14
  calendar-future-days: 90
  max-chats-per-cycle: 8
  include-teams-channels: true

graphics: true
start-page: email
sidebar-width: 34
detail-percent: 62
```

Canonical config commands are contributed by `configurable-cli`:

```sh
annum config show
annum config status
annum config init
annum config validate
annum config schema
annum config export
annum config import FILE
```

## Mutations

The CLI and MCP server fail closed. Sending, replying, marking read, creating or
responding to meetings, and sending Teams chat messages require explicit
confirmation:

```sh
annum email send --to ada@example.com --subject Hello --body '...' --confirm
annum email reply --id ID --body '...' --confirm
annum email mark-read --id ID --confirm
annum calendar create --subject Review --start 2026-08-05T10:00:00 \
  --end 2026-08-05T10:30:00 --timezone UTC --attendee ada@example.com --confirm
annum calendar respond --id ID --response accept --confirm
annum chat send --chat-id ID --body '...' --confirm
```

MCP mutation inputs carry the equivalent `confirmed: true` field.

## TUI keys

| Key | Action |
|---|---|
| `Tab` / `Shift-Tab`, `1`–`5` | Switch Email/Calendar/Chats/Teams/Search |
| `j`/`k`, arrows | Select or scroll |
| `f` | Toggle list/detail focus |
| `/` | Deterministic local filter |
| `r` | Queue visible daemon domain |
| `o`, `Enter` | Open Outlook/Teams deep link |
| `g` / `G` | First / last |
| `?` | Help |
| `q` | Quit |

## Development

```sh
cd annum
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo run -- --demo snapshot
```
