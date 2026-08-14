# Session summary — Slick terse CLI and MCP query surfaces

## Goal

Expose Slick's compact Slack cache as a scriptable product, not only a TUI: the same bounded source-aware implementations should serve human commands, stable JSON, and MCP tools without forcing agents to download the full cache.

## Bead(s)

- `bd-a5e9c8` — Slick CLI and MCP stdio: terse cache/daemon query commands.
- Reflection: `bd-0ecea5` — draft bounded Nix packaging smoke for saturated shared hosts.

## Before state

- Slick data was available only through the TUI, full `/snapshot`, and full-state SSE.
- Agents could not ask for one channel, DM inventory, Feed slice, or Canvas without obtaining and understanding the entire cache schema.
- There was no `--json` query contract or MCP stdio server.
- One-shot queries had no cache-first/daemon-partial/fallback source resolver.

## After state

- Human commands work for `feed`, `activity list`, `dm list/get`, `channel list/get`, and `files list/get`, each with bounded `--limit` where relevant.
- Global `--json` returns mcp-cli schema-versioned envelopes containing terse records: activity is grouped once by conversation provenance, repeated user/channel metadata is removed, messages retain links/thread/file identity, and Canvas content is bounded Markdown.
- `slick mcp stdio` exposes the same functions as `slick_feed`, `slick_activity_list`, `slick_dm_list/get`, `slick_channel_list/get`, and `slick_files_list/get` over NDJSON MCP.
- Authenticated partial snapshot routes cover Feed, Activity, DMs, channels, files, one conversation, and one file. Missing surfaces queue the existing daemon refresh API and poll only their projection.
- Remote partial results merge into the local cache without erasing unrelated surfaces. With cache unavailable, queries use the daemon; with daemon unavailable and fallback permitted, they acquire the same owner-only lease and perform a bounded read-only refresh.
- Canonical `mcp-cli-core` is pinned in Cargo and rewritten to an immutable private source input for Nix sandbox builds.

## Diff summary

- Code/content commit: `d21895e`.
- Files touched: new `slick/src/query.rs`; `slick/src/{main,daemon,client,lib}.rs`; Slick Cargo/flake locks and manifests; root/Slick READMEs.
- Tests: 104 library + 3 CLI tests pass; strict all-target clippy passes. Tests cover projections/merge preservation, terse grouping, Canvas Markdown, MCP tool names, partial HTTP auth/routes, query CLI parsing, and existing daemon/client/UI behavior.
- Live smoke: CLI JSON Feed/channel envelopes parsed with bounded counts; MCP initialize, tools/list, and `slick_feed` tools/call returned non-error mcp-cli envelopes.
- Packaging: Nix source parsing and vendor hash `sha256-m0RasH/6OlnNgz3bIRCkk9yQ91LY08z9yVvgtVJuAAQ=` are verified. The full local Nix compile was killed at the one-hour bound on a saturated shared Mac; hosted required CI owns that final repeated compile.

## Operator-takeaway

Slick is now one Slack data plane for humans and agents: TUI, terse CLI, JSON, and MCP all read the same cache/daemon projections and share the same refresh and fallback rules.
