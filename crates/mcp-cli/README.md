# mcp-cli

`mcp-cli` is a small Rust framework for exposing the same command implementation
through a traditional CLI JSON surface and a Model Context Protocol (MCP) stdio
server. It is intentionally application-agnostic: consumers provide typed input
structures, output values, and structured errors; the crate handles envelopes,
JSON schema generation, MCP framing, tool listing, and tool calls.

## What it provides

- Stable `JsonEnvelope<T>` success/error responses for `--json` CLI output.
- `StructuredError` and `JsonError` for projecting domain errors into a shared
  machine-readable shape.
- `ToolRouter` and typed `Tool` registration backed by `schemars` input schemas.
- A minimal `McpServer` that speaks MCP over stdio using newline-delimited JSON
  (NDJSON) framing — one compact JSON-RPC object per line, `\n`-terminated.
- A resilient stdio serve loop: a single malformed frame or a single
  per-request handler error is answered with a JSON-RPC error frame (`-32700`
  parse error / `-32603` internal error, preserving the request id) and the
  connection **keeps serving** instead of tearing down. Only a genuine reader
  EOF or a broken read/write stream ends the session, so a transient "erroring
  MCP" no longer drops the client connection. Re-`initialize` is idempotent, so
  a reconnecting client is cleanly re-acknowledged.
- Generic tests that prove a CLI command surface and MCP tool surface can share
  the same command contracts without hard-coding any one application.

## Minimal pattern

```rust
use mcp_cli::{ErrorCategory, McpServer, StdioServerConfig, StructuredError, ToolRouter};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Deserialize, JsonSchema)]
struct AddInput {
    lhs: i64,
    rhs: i64,
}

#[derive(Debug, Serialize)]
struct AddOutput {
    sum: i64,
}

#[derive(Debug)]
struct AppError(String);

impl StructuredError for AppError {
    fn category(&self) -> ErrorCategory { ErrorCategory::Validation }
    fn code(&self) -> String { "app_error".to_owned() }
    fn message(&self) -> String { self.0.clone() }
}

let mut router = ToolRouter::new();
router.add_typed_tool("math_add", "Add two integers.", |(), input: AddInput| {
    Ok::<_, AppError>(AddOutput { sum: input.lhs + input.rhs })
});

let server = McpServer::new(
    StdioServerConfig {
        server_name: "my-cli".to_owned(),
        server_version: env!("CARGO_PKG_VERSION").to_owned(),
    },
    router,
);
# let _ = json!({ "tools": server.tool_metadata() });
```

For CLI commands, use `write_json_result` or `write_json_result_ref` to emit the
same stable envelope shape that MCP `tools/call` returns as structured content.

## Source of truth and wire compatibility

This crate is **vendored** into `agent-utils` from its canonical upstream,
[`github.com/harryaskham/mcp-cli`](https://github.com/harryaskham/mcp-cli). Treat
the upstream as the source of truth for the framework's API: land cross-cutting
framework changes upstream and re-vendor, rather than letting this copy drift on
its own.

The MCP stdio transport uses **newline-delimited JSON (NDJSON)** framing — one
compact JSON-RPC object per line, `\n`-terminated, with **no `Content-Length`
headers**. It must stay wire-compatible with Tendril's `mcp stdio` structure and
with consumers such as `skill-server` (see `docs/skill-server/README.md`). A
silent reversion to `Content-Length` framing previously broke that compatibility
in production (bd-dc9438 / bd-6ffb52, caught only by a manual broadcast), so the
framing contract is now pinned by drift-guard tests in `src/protocol.rs`. Keep
those tests green — and this section accurate — when touching the transport.

## Development

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

Keep this crate generic. Application-specific concepts (for example window IDs,
platform adapters, or project-specific error codes) belong in the consuming CLI,
not in `mcp-cli`.
