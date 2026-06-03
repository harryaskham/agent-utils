# Session summary — Native per-call --remote hooks for tendril cross-machine capture

## Goal

Enable transparent capture of applications running on different machines through
the tendril extension. Previously the Tendril `--remote`/`--wsl-tunnel` bridge
was configured only once per session via `AGENT_UTILS_TENDRIL_REMOTE`. This
session added native per-call hooks so a single Pi session can target a Tendril
bridge on any machine for an individual capture/list/describe/stream call,
without changing global env — making multi-machine app capture a first-class,
transparent operation for the model.

## Bead(s)

- `bd-96cc8e` — Add native hooks for --remote flags in tendril (feature, P2)

## Before state

- Failing tests: none (baseline suite green at 472)
- `buildTendrilCommand(args)` read remote/wslTunnel only from env; no per-call override.
- `tendril_*` tools and `/tendril` slash command had no way to target a specific
  remote host per invocation.

## After state

- Failing tests: none (suite green at 477; +5 new tendril override tests)
- `buildTendrilCommand(args, env, overrides)` / `tendrilBridgeConfig(env, overrides)` /
  `tendrilCommandSummary(env, overrides)` accept an explicit `{ remote, wslTunnel }`
  override that takes precedence over env, with `remoteSource`/`wslTunnelSource`
  provenance fields.
- All `tendril_*` tools (`tendril_list`, `tendril_capture`, `tendril_describe`,
  `tendril_stream`, `tendril_bridge_doctor`) expose `remote` + `wslTunnel` params.
- `/tendril` slash command parses `--remote <host>` / `--remote=<host>`, `--local`
  (force local), and `--wsl-tunnel` / `--no-wsl-tunnel`.
- README documents the per-call override; docs:check passes.

## Diff summary

- Code/content commits: pending final squash SHA from reintegration receipt.
- Files touched: extensions/tendril-command.js, extensions/tendril-share.js,
  test/tendril-share.test.js, README.md
- Tests: +5 (override builder, overrideFromParams, parseShareFlags remote flags,
  parseCaptureArgs threading, tendril_capture forwards override); 1 existing
  deepEqual updated for new provenance fields. 472 -> 477, 0 failing.
- Behavioural delta: per-call remote targeting is now layered on top of the env
  default; omitted keys fall back to env, empty `remote` forces local bridge.

## Operator-takeaway

Cross-machine tendril capture no longer requires reconfiguring session env: any
single capture/describe/stream/list call can name its own `--remote` host (with
optional WSL tunnel), so the model can fluidly inspect apps on ms-dev, astra, or
the local box within one session. The override is purely additive — existing
env-configured single-bridge setups behave exactly as before.
