# web-search-mcp

Tiny stdio MCP server that proxies GitHub Copilot's Responses API with the `web_search` tool forced on.

## Defaults

- bearer source: Pi's `~/.pi/agent/auth.json` (`github-copilot.access`, auto-refreshed by Pi), falling back to the static token file `~/.config/gh-auth-tokens/copilot.token`
- token file (fallback / explicit override): `~/.config/gh-auth-tokens/copilot.token`
- model: `gpt-5.3-codex`
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
  --auth-json ~/.pi/agent/auth.json \
  --model gpt-5.3-codex \
  --max-output-tokens 16000
```

To force the legacy static token file instead of Pi's `auth.json`, pass an
explicit `--token-file` (or set `WEB_SEARCH_COPILOT_TOKEN_FILE`):

```bash
uv run web-search-mcp \
  --token-file ~/.config/gh-auth-tokens/copilot.token \
  --model gpt-5.3-codex \
  --max-output-tokens 16000
```

## Build and test

Run the Python test suite from the `web-search/` directory using `uv`, which
resolves `uv.lock`, builds a `.venv`, and installs the `test` extra (`mcp` +
`pytest`):

```bash
cd ~/cosmos/projects/agent-utils/web-search
uv run --extra test python -m pytest
```

This is the canonical invocation. Plain `python3 -m pytest` fails with
`ModuleNotFoundError` because of the `src`-layout, and
`PYTHONPATH=src python3 -m pytest` still fails on `No module named 'mcp'` since
the `mcp` dependency is not installed in the ambient environment. Using
`uv run --extra test` avoids both problems.

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
