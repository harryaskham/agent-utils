# skill-server (`skill-search`)

`skill-server` is a Rust utility for dynamic agent skill and MCP tool discovery. It exposes one shared implementation through:

- a CLI (`skill-search` or `skill-server`), including shorthand: `skill-search <domain> <query-or-command...>`
- an MCP stdio server: `skill-search mcp stdio`

The MCP surface is built with the local `mcp-cli` crate copied from the Tendril pattern, so CLI JSON envelopes and MCP tool responses share the same shape.

## Configuration

By default `skill-search` reads `.config/ss/config.yaml`. Override with either:

```bash
SS_CONFIG=/path/to/config.yaml skill-search list
skill-search --config /path/to/config.yaml list
```

Minimal config:

```yaml
skill_paths:
  - prompts
  - web-search/plugins/web-search/commands

mcp_servers:
  - name: web-search
    description: Live web search MCP server.
    domains: [web, search]
    command: web-search-mcp
    args: []
    tools:
      - name: search_web
        aliases: [query, web_search]
        description: Search the live web.
```

`skill_paths` are scanned for `.md`, `.json`, `.yaml`, and `.yml` files. A file named `web-search.md` is discoverable by name `web-search` and domain `web`.

`mcp_servers` describe host stdio server commands and the tool names/aliases that can satisfy a meta request. The initial implementation returns a structured route/invocation plan; the host or a later bridge can use that plan to call the selected server/tool.

## CLI examples

```bash
skill-search --help
skill-search list
skill-search list --json
skill-search web query latest Rust MCP crate
skill-search call web --tool query --query "latest Rust MCP crate" --json
```

A successful meta request returns the selected server/tool plus its command vector. A miss returns a structured `not_found` response instead of guessing.

## MCP stdio

Start the server with:

```bash
skill-search mcp stdio
```

Tools exposed:

- `skill_search` — accepts `{ "domain": "web", "query": "query ...", "tool": "query" }` and returns route metadata.
- `skill_server_list` — lists configured MCP servers and scanned skill files.

The stdio transport uses MCP `Content-Length` framing via `mcp-cli`, matching Tendril's `mcp stdio` structure.

## Build and test

```bash
cargo build -p skill-server
cargo test -p skill-server
cargo clippy -p skill-server --all-targets -- -D warnings
```
