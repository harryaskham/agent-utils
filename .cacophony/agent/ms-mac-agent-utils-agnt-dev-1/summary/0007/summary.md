# Session summary — Tendril MCP wire-protocol cutover: Content-Length -> NDJSON

## Goal

The tendril agent broadcast that Tendril's MCP stdio transport moved from
Content-Length (LSP-style) headers to newline-delimited JSON (NDJSON), the
MCP-spec-correct framing, and warned that any Pi/Cacophony-side MCP surface
still on the old contract must move in lockstep or live MCP stdio breaks. This
repo (agent-utils) owns `crates/mcp-cli`, whose stdio framing `crates/skill-server`
consumes and whose docs explicitly promise it matches "Tendril's mcp stdio
structure". The goal was to bring this repo's framing into lockstep so the
vendored crate and skill-server stay wire-compatible with the new NDJSON
contract rather than silently drifting.

## Bead(s)

- `bd-dc9438` — Tendril MCP wire-protocol cutover: move vendored mcp-cli +
  skill-server stdio framing from Content-Length to NDJSON (task, P1)
- Duplicates filed by peers during the claim race and folded into this bead:
  `bd-bde816` (dev-0, closed duplicate-of bd-dc9438). dev-2 had scoped the same
  work and stood off.

## Before state

- Failing tests: none, but the framing was a latent interop break.
- `crates/mcp-cli/src/protocol.rs` read/write used Content-Length headers
  (`Content-Length: N\r\n\r\n` + body; header-parsed reader).
- `crates/mcp-cli/src/lib.rs` test helpers `frame_request`/`parse_framed_responses`
  hardcoded Content-Length framing.
- `crates/skill-server/src/lib.rs` doc + `docs/skill-server/README.md` documented
  the Content-Length contract "matching Tendril's mcp stdio structure" — now
  stale after the tendril cutover (tendril bd-6ffb52, mcp-cli 941015b).

## After state

- Failing tests: none. Targeted validation green: `cargo build -p mcp-cli -p skill-server`
  OK; `cargo test -p mcp-cli -p skill-server` = 8 + 6 + doctests passing
  (including `stdio_server_handles_initialize_list_and_call`, which exercises the
  new NDJSON path end-to-end via the updated helpers); `cargo clippy -p mcp-cli
  -p skill-server --all-targets -- -D warnings` clean.
- Framing is now NDJSON: one compact JSON object per line, `\n`-terminated, no
  Content-Length header. Reader skips blank lines and returns `Ok(None)` at EOF.
- No `Content-Length` references remain in repo code or docs.

## Diff summary

- Code/content commit: b7b2576 (local; final landed squash SHA comes from the
  reintegration receipt).
- Files touched: `crates/mcp-cli/src/protocol.rs` (read/write framing + module/fn
  docs), `crates/mcp-cli/src/lib.rs` (test helpers), `crates/skill-server/src/lib.rs`
  (Stdio doc comment), `docs/skill-server/README.md` (framing sentence).
- Tests: 0 added / 0 removed; 1 framing-exercising integration test (and its
  helpers) migrated to NDJSON and still passing.
- Behavioural delta: MCP stdio messages are now framed as one compact JSON
  object per line terminated by `\n` instead of Content-Length-prefixed bodies.
  `server.rs` was unchanged — the framing is fully encapsulated in `protocol.rs`,
  so only the transport functions and their tests/docs moved.

## Operator-takeaway

agent-utils `crates/mcp-cli` is the shared MCP stdio framing that Tendril-style
clients (and skill-server) depend on; it now speaks NDJSON in lockstep with the
tendril transport cutover, so live Pi<->MCP stdio stays working. The latent risk
worth remembering: the vendored crate's canonical upstream
(`github.com/harryaskham/mcp-cli`) is not reachable and nothing guards against
the vendored copy drifting from whatever Tendril actually consumes — this exact
break only surfaced because tendril broadcast it. A drift guard or a documented
single source of truth would catch the next divergence automatically.
