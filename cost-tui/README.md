# Cost TUI

Cost TUI is a daemon-backed GitHub Copilot usage dashboard for every account
configured in `gh`. It uses Rust, Ratatui and Kittui graphical underlays.

The daemon is the sole normal data-source process. It polls each selected
account in parallel, writes an atomic cache, appends exact owner-only JSONL
history, computes rate windows, and exposes authenticated HTTP/SSE plus an
optional Unix socket through `remote-cli`. The TUI normally reads only the
cache and daemon, so closing the UI does not stop usage tracking.

It displays:

- exact AI-credit usage, entitlement, remaining quota and overage state;
- dollar equivalents at exactly `$0.01 / credit`;
- persistent charts rehydrated from daemon history;
- freshest `$ / minute` from the latest same-cycle sample interval;
- actual spend observed over 1 hour, 24 hours, 7 days and 28 days;
- UTC calendar-month-to-date spend, segmented across quota resets;
- clear partial-coverage markers when retained history does not span a window.

The API's exact units are preserved. A 50,000,000-credit entitlement remains
50,000,000 credits; it is never divided by 1,000 internally.

## Normal operation

Start the configured service through the NixOS, nix-darwin or Nix-on-Droid
module. For a foreground development daemon:

```bash
cost-tui daemon
```

Then open the smart client:

```bash
cost-tui
# equivalent
cost-tui client
```

The default local endpoint is `http://127.0.0.1:7622`. Remote and Unix-socket
clients use the same authenticated contract:

```bash
cost-tui --daemon-url https://host.example:7622 \
  --token-file ~/.config/cost-tui/daemon-token

cost-tui --daemon-url unix:///absolute/path/cost-tui.sock
```

Direct `gh` collection in a client is explicit:

```bash
cost-tui --standalone
cost-tui --once
cost-tui sync --standalone
```

Plain `cost-tui`, `cost-tui status`, and the TUI never start a hidden `gh`
collector when the daemon is unavailable.

## History and rates

By default:

```text
state:   platform cache dir/cost-tui/state.json
history: platform cache dir/cost-tui/history.jsonl
token:   ~/.config/cost-tui/daemon-token
config:  ~/.config/cost-tui/config.yaml
```

On macOS the daemon module places the cache under
`~/Library/Caches/cost-tui`. Every successful account measurement becomes one
JSONL row containing only sanitized quota/account fields—never credentials.
History is retained for 400 days, capped per account, and atomically compacted
on a bounded cadence.

```bash
cost-tui history -n 100
cost-tui history --filter-account harryaskham@github.com --json
cost-tui status
cost-tui sync                    # ask the daemon to refresh
cost-tui sync --standalone       # explicit direct one-shot writer
```

A `~` before a spend value means the available retained samples cover only
part of that requested window. Counter decreases and reset-marker changes are
boundaries, never negative spend.

## Configuration

```bash
cost-tui config path
cost-tui config show
cost-tui config status
cost-tui config init
cost-tui config validate
cost-tui config schema
```

Representative YAML:

```yaml
graphics: true
refresh-secs: 300
accounts: [] # empty = daemon discovers healthy gh accounts
history:
  retention-days: 400
  max-samples-per-account: 120000
  chart-points: 576
  compact-every-cycles: 288
client:
  cache: true
  daemon: true
  daemon-url: http://127.0.0.1:7622
  fallback: false
daemon:
  bind: 127.0.0.1:7622
  min-refresh-secs: 2
```

## Logs

```bash
cost-tui log
cost-tui log -n 100
cost-tui log -f
cost-tui log --stream all -f
```

This follows launchd files on macOS, the user journal on NixOS, and
supervisord on Nix-on-Droid.

## Offline preview

```bash
cost-tui --snapshot --width 120 --height 42
cost-tui --demo
cost-tui --no-graphics
```

### Keys

| Key | Action |
|---|---|
| arrows, `h`/`j`/`k`/`l` | Select an account |
| `1`…`9` | Select an account directly |
| `r` | Ask the daemon to refresh all accounts |
| `?` | Help |
| `q`, `Ctrl-C` | Quit |

Cards are also mouse-selectable.

## Security

The daemon obtains a selected account token with:

```bash
gh auth token --hostname HOST --user LOGIN
```

The token is passed only through the environment of one `gh api` child. It is
never placed in argv, logs, cache, JSONL history, snapshots or UI state. Cache,
history, bearer-token and configuration writers use owner-only atomic files.

The source endpoint is GitHub's client-facing `/copilot_internal/user`; it may
change. Failures are isolated per account and the last good value remains
visible as stale data.

## Development

```bash
nix develop ./cost-tui
CARGO_BUILD_JOBS=1 cargo test --manifest-path cost-tui/Cargo.toml --all-targets
cargo clippy --manifest-path cost-tui/Cargo.toml --all-targets -- -D warnings
nix build ./cost-tui#cost-tui
```
