# Session summary — mcp-cli: isolate per-message errors in the MCP stdio serve loop

## Goal

Harden the `mcp-cli` MCP stdio server so a single transient error (one malformed
frame or one bad request) no longer tears down the whole client connection.
This came directly from Harry's operator discussion about MCP reconnection:
"since we control the mcp stdio binary we could do something smarter than just
fail to reacknowledge connections from the same agent." This bead is the
server-side root-cause fix; the complementary client-side transparent reconnect
and the auto-`caco agent reconnect-mcp` watcher are cacophony-bridge scope and
were explicitly left out of this change.

## Bead(s)

- `bd-8f99c0` — mcp-cli: harden McpServer stdio serve loop to isolate per-message
  errors (stop dropping the connection on transient errors)

## Before state

- Failing tests: none (18 mcp-cli tests passing before this change).
- `crates/mcp-cli/src/server.rs` `serve_transport` was a bare loop that
  `?`-propagated both the per-frame JSON parse and the per-request handler
  error, so one malformed frame or one `tools/call` with bad params dropped the
  entire MCP session — the "erroring MCP fails to reacknowledge" symptom hit
  fleet-wide during the daemon-flap window.

## After state

- Failing tests: none. `cargo test -p mcp-cli` → 19 passed (was 18; +3 new).
  `cargo clippy -p mcp-cli --tests` clean (pedantic).
- `serve_transport` now isolates per-message errors: a malformed frame is
  answered with a JSON-RPC parse error (-32700, id null), a handler error with
  an internal error (-32603) that preserves the request id, and the loop keeps
  serving. Only a genuine reader EOF / broken stream ends the session.
  Re-`initialize` stays idempotent (a reconnecting client is re-acknowledged).

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: `crates/mcp-cli/src/server.rs` (serve loop + two error-builder
  helpers + 3 new `#[cfg(test)]` tests), `crates/mcp-cli/README.md` (resilience
  note).
- Tests: +3 (`serve_transport_isolates_malformed_frame_and_keeps_serving`,
  `serve_transport_isolates_handler_error_and_preserves_id`,
  `serve_transport_reinitialize_is_idempotent`); 0 removed; 0 flipped.
- Behavioural delta: transient per-message errors return JSON-RPC error frames
  instead of dropping the connection; genuine stream death still ends the
  session.

## Operator-takeaway

The MCP "fails to reacknowledge / drops on error" pain has a concrete server-side
root cause in `mcp-cli`: the serve loop used to die on the first transient
parse/handler error. It now stays up and answers errors as JSON-RPC frames, so
most transient hiccups never break the link. The remaining piece — client-side
transparent reconnect + auto-`caco agent reconnect-mcp` — belongs in the
cacophony stdio bridge (the "precursor to mcp-cli"), which is outside agent-utils
worker scope and should be routed to a cacophony worker / caco-ctrl. Separately,
a realtime `local-vad` listen mode (local VAD + batch model like
mai-transcribe-1.5, 1s-insert / 3s-commit / reset-on-speech) was scoped during
the same conversation and is still pending an operator go-ahead to build.
