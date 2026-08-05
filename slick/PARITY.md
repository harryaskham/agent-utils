# remote-cli / configurable-cli extraction parity

Baseline: agent-utils `09972055` (the last Slick source before extraction).

The extraction intentionally changes implementation ownership, not Slick's
Slack, cache, query, TUI, scheduling, or default transport behavior.

## Confirmed contracts

- `CacheStore` is now `remote_cli::CacheStore<CacheState>`.
- `ClientOptions`, `ClientSubscription`, `ClientUpdate`, `ClientHealth`, token
  checks, SSE parsing, write-through, source coordination, and fallback lease
  are specializations/re-exports of `remote-cli`.
- Daemon `SharedSnapshot`, token creation, bearer auth, `/snapshot`, `/events`,
  `/health`, `/refresh`, SSE keepalives, and atomic revision publication come
  from `remote-cli`.
- Slick retains its domain scheduler, rate-limit/backoff handling, Slack API
  collector, partial projections, query functions, Markdown, images, and UI.
- `Config` retains every field/default/YAML key and local favorite/read-marker
  behavior; load/save/path/schema plumbing comes from `configurable-cli`.
- Default HTTP endpoint remains `127.0.0.1:7612`.
- Default token, fallback lease, Linux cache, macOS `Library/Caches`, and
  Nix-on-Droid paths remain unchanged.
- NixOS, nix-darwin, and Nix-on-Droid service names, restart behavior, command
  shape, and module option names remain unchanged.

## Additive behavior

- `slick config show|path|status|init|validate|schema|export|import`.
- Matching read-mostly configuration MCP tools.
- Optional `daemon.unix-socket`, `slick daemon --unix-socket`, and
  `client.daemon-url: unix:///absolute/path.sock`.

## Validation receipt

- All 100 Slick library tests and 3 CLI tests pass after extraction.
- Strict `cargo clippy --all-targets -- -D warnings` passes.
- The deterministic `120x38` Slick snapshot from baseline `09972055` and the
  extracted implementation are byte-for-byte identical.
- Existing authenticated snapshot/refresh/SSE, partial-projection, cache,
  source-health, fallback, query, image lifecycle, and UI regression tests all
  remain green.
