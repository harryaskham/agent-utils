# Cost TUI

Cost TUI is a small, read-only GitHub Copilot usage dashboard for every account
configured in `gh`. It is built with Rust, Ratatui, and
[kittui](https://github.com/harryaskham/kittui), following Slick's graphical
underlay model.

It discovers accounts with `gh auth status --json hosts`, then queries each
account in parallel using its own `gh auth token` credential. By default it
refreshes every five minutes and shows:

- AI credits used, remaining, entitlement, and percent used
- equivalent usage value at `$0.01` per AI credit
- plan, seat SKU, assignment date, snapshot age, and reset metadata
- chat/completion quota state and overage state
- per-process sample history and the delta since the last refresh

The quota values are the exact API units. In particular, a 50,000,000-credit
entitlement is displayed as 50.00M; it is not divided by 1,000.

## Run

```bash
nix run ./cost-tui

# Plain terminal borders (works without Kitty graphics)
nix run ./cost-tui -- --no-graphics

# Fetch once as sanitized JSON
nix run ./cost-tui -- --once

# Deterministic offline preview
nix run ./cost-tui -- --snapshot
```

Cost TUI auto-discovers all healthy accounts known to `gh`. To select an exact
set instead:

```bash
nix run ./cost-tui -- \
  --account harryaskham@github.com \
  --account harryaskham_microsoft@github.com \
  --account harryaskham@msft.ghe.com \
  --account harryaskham@microsoft.ghe.com
```

Change the polling cadence with `--refresh-secs`:

```bash
nix run ./cost-tui -- --refresh-secs 300
```

### Keys

| Key | Action |
|---|---|
| arrows, `h`/`j`/`k`/`l` | Select an account |
| `1`…`9` | Select an account directly |
| `r` | Refresh every account now |
| `?` | Help |
| `q`, `Ctrl-C` | Quit |

Cards are also mouse-selectable.

## Security and API contract

Tokens are obtained with:

```bash
gh auth token --hostname HOST --user LOGIN
```

The selected token is passed only through the environment of one child
`gh api` process. It is never placed in argv and is never written to logs,
cache, snapshots, or application state. Cost TUI itself has no credential
store.

The data source is GitHub's client-facing `/copilot_internal/user` endpoint,
which is also the source of the quota snapshot shown by Copilot clients. The
endpoint is internal and may change; failures are isolated per account and the
last good value remains visible as stale data.

## Development

```bash
nix develop ./cost-tui
CARGO_BUILD_JOBS=1 cargo test --manifest-path cost-tui/Cargo.toml
cargo clippy --manifest-path cost-tui/Cargo.toml --all-targets -- -D warnings
nix build ./cost-tui#cost-tui
```
