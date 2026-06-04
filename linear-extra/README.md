# linear-extra-mcp

A tiny stdio MCP server that exposes **Linear draft-comment** operations the official Linear MCP
does not: create, update, fetch, and delete *draft comments* on issues.

## Why

The public Linear API (and the official `mcp.linear.app` server) expose comments but have **no draft
mutations**. Linear *draft comments* — private, unpublished notes attached to an issue, visible only
to their author until published in the UI — are only available through Linear's **internal** client
GraphQL endpoint (`https://client-api.linear.app/graphql`), authenticated with the browser **session
cookie**.

This server wraps the `draftCreate` / `draftUpdate` / `draftDelete` operations (plus a draft fetch),
accepts **Markdown**, and converts it to Linear's ProseMirror `bodyData` shape.

It is **drafts-only by design**: it never creates a live comment and never publishes a draft.
Publishing stays a deliberate human action in the Linear UI — so an agent can stage review-ready
comments safely, and you publish (or discard) them yourself.

## Tools

| Tool | Purpose |
|------|---------|
| `linear_draft_create(issue, markdown)` | Create a private draft comment on an issue (identifier like `HE-212` or UUID). Returns `draftId`. |
| `linear_draft_update(draft_id, markdown)` | Replace a draft's body with new Markdown. |
| `linear_draft_fetch(issue?)` | List your drafts, optionally scoped to one issue. |
| `linear_draft_delete(draft_id)` | Discard a draft. |

## Auth

Drafts require the Linear **session cookie** (the OAuth token used by the official MCP is not
accepted by the internal endpoint). Resolution order (first match wins):

1. `LINEAR_SESSION_COOKIE` — the full cookie string:
   `session:<acct>=<jwt>; uploadsSig:<acct>=<jwt>`
2. `LINEAR_COOKIE_FILE` — path to a file containing that cookie string
3. `settings.json` (`~/.pi/agent/settings.json` or `--settings`): a `linear-extra.cookie`
   (literal value) or `linear-extra.cookieFile` (path) entry
4. Default file: `~/.pi/agent/linear-session.cookie` — picked up automatically with no config

`accountId` and `organizationId` are derived from the cookie's JWT claims automatically; the Linear
`user` id (needed for one header, distinct from the account id) is fetched once via `viewer { id }`.
Override any of them with `LINEAR_ACCOUNT_ID` / `LINEAR_ORG_ID` / `LINEAR_USER_ID` if needed.

> The session cookie is a sensitive, full-account credential. Prefer `LINEAR_COOKIE_FILE` (mode
> `600`) or an env var injected at runtime; do not commit it. Rotate the Linear session if a copy
> leaks.

## mcp.json wiring

Exposed through the agent-utils nix flake as `linear-extra-mcp`:

```json
{
  "mcpServers": {
    "linear-extra": {
      "command": "linear-extra-mcp",
      "env": { "LINEAR_COOKIE_FILE": "~/.pi/agent/linear-session.cookie" }
    }
  }
}
```

(`nix run .#linear-extra-mcp`, or add the flake package to your profile so `linear-extra-mcp` is on
`PATH`.)

## Develop / test

```sh
cd linear-extra
uv lock            # if dependencies changed
PYTHONPATH=src python3 -m pytest -q   # converter tests (no network)
```

The ProseMirror converter (`prosemirror.py`) is pure and unit-tested. The GraphQL layer mirrors the
exact mutation shapes captured from the Linear web client.
