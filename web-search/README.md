# web-search-mcp

Tiny stdio MCP server that proxies GitHub Copilot's Responses API with the `web_search` tool forced on.

## Defaults

- token file: `~/.config/gh-auth-tokens/copilot.token`
- model: `gpt-5.2-codex`
- max output tokens: `16000`
- API base: `https://api.githubcopilot.com/v1`
- editor version header: `vscode/1.103.1`

## Run locally

```bash
cd ~/cosmos/projects/agent-utils/web-search
uv run web-search-mcp
```

## Flags

```bash
uv run web-search-mcp \
  --token-file ~/.config/gh-auth-tokens/copilot.token \
  --model gpt-5.2-codex \
  --max-output-tokens 16000
```

## Nix

Build from the subflake:

```bash
cd ~/cosmos/projects/agent-utils/web-search
nix build .#web-search-mcp
```

Or from the repo root collator:

```bash
cd ~/cosmos/projects/agent-utils
nix build .#web-search-mcp
```

## Claude plugin marketplace

The repo root exposes a plugin marketplace at:

```text
~/cosmos/projects/agent-utils/.claude-plugin/marketplace.json
```

The plugin for this server lives at:

```text
~/cosmos/projects/agent-utils/web-search/plugins/web-search
```
