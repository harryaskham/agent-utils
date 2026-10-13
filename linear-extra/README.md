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

Drafts require the Linear **session cookie**: the internal endpoint rejects API keys (`Auth method
not allowed: apiKey`) and the official MCP's OAuth token. Resolution order (first match wins):

1. `LINEAR_SESSION_COOKIE` — the full cookie string:
   `session:<acct>=<jwt>; uploadsSig:<acct>=<jwt>`
2. `LINEAR_COOKIE_FILE` — path to a file containing that cookie string
3. `settings.json` (`~/.pi/agent/settings.json` or `--settings`): a `linear-extra.cookie`
   (literal value) or `linear-extra.cookieFile` (path) entry
4. Default file: `~/.pi/agent/linear-session.cookie` — picked up automatically with no config

`accountId` and `organizationId` are derived from the cookie's JWT claims automatically; the Linear
`user` id (distinct from the account id) is fetched via `viewer { id }` when supported. Some sessions
require an explicit user header even for that query: configure `LINEAR_USER_ID` / `--user-id` (the
repository wrapper already supplies it). Override account/workspace with `LINEAR_ACCOUNT_ID` /
`LINEAR_ORG_ID` or the corresponding flags. Login validation preserves this context, rejects a
mismatching viewer/workspace, and background recovery forwards the server's resolved context.

> The session cookie is a sensitive, full-account credential. Prefer `LINEAR_COOKIE_FILE` (mode
> `600`) or an env var injected at runtime; do not commit it. Rotate the Linear session if a copy
> leaks.

## Signing in / refreshing the session

Linear sessions expire or get revoked. Refresh the cookie without DevTools:

```sh
linear-extra-mcp login --check   # exit 0 valid, 2 expired/missing; opens nothing
linear-extra-mcp login           # keep a valid cookie, otherwise sign in
linear-extra-mcp login --force   # capture again even if the cookie still works
linear-extra-mcp login --extension msedge  # reuse your already-signed-in Edge
```

For enterprise SAML, prefer your existing Edge profile. Install the
[Playwright MCP Bridge](https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm)
in that profile, keep a signed-in Linear tab available, and inject
`PLAYWRIGHT_MCP_EXTENSION_TOKEN` through your secret manager. When that variable is present, login
**defaults to attaching to Edge**, reads only cookies applicable to the Linear client API, and
**detaches without closing your browser**. It does not start a new profile or replay SAML. Use
`LINEAR_EXTRA_EXTENSION=chrome` to choose Chrome, or `--extension none` to opt into a dedicated
profile. A rejected attachment never silently falls back to a new browser. This reuses a valid
session; it does not resolve Entra application-assignment failures for future fresh logins.

The bridge requires **playwright-cli 0.1.22 or newer** (0.1.10 fails with "unsupported protocol
version"). Check `playwright-cli --version`; select a compatible executable with
`LINEAR_EXTRA_PLAYWRIGHT_CLI` if the one on PATH is older. Tokens are inherited through the environment,
not placed in CLI arguments or printed. CLI attachment output is suppressed because its connection
URL can contain the token.

Without an extension, `login` opens a headed browser at `https://linear.app/login` with a dedicated persistent profile
(`~/.cache/linear-extra/browser-profile`, so later sign-ins are usually one click). Sign in normally;
it reads the cookies the browser would send to `client-api.linear.app` (including httpOnly ones),
validates them with a `viewer` query, writes the cookie file atomically with mode `600`, and closes
the window. It prints only the account and cookie names, never values, and waits up to 10 minutes
(`--timeout`). It writes to the same file the server reads (`--cookie-file`, `LINEAR_COOKIE_FILE`,
`settings.json` `cookieFile`, else the default path).

The running server re-reads its cookie file whenever it changes, so no restart is needed. When Linear
rejects the session, a tool call fails with "Linear session expired" and starts recovery in the
background (one at a time), using the extension when configured. Complete any connection/sign-in
prompt, then retry the call. A spawned process is not proof that authentication succeeded.

Requires [`playwright-cli`](https://www.npmjs.com/package/@playwright/cli) (on `PATH`, at
`~/.local/pnpm/playwright-cli`, or `LINEAR_EXTRA_PLAYWRIGHT_CLI`). Other settings:
`LINEAR_EXTRA_AUTO_LOGIN=0` (never open a browser from the server; also off without a display),
`LINEAR_EXTRA_BROWSER` (`chrome` default, or `msedge`), `LINEAR_EXTRA_PROFILE_DIR`,
`LINEAR_EXTRA_STATE_DIR` (profile, lock and `login.log`).

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
PYTHONPATH=src python3 -m pytest -q   # unit tests (local fake Linear, no network)
LINEAR_EXTRA_E2E=1 uv run --group dev python -m pytest -q  # + real headless browser sign-in
```

The ProseMirror converter (`prosemirror.py`) is pure and unit-tested. The GraphQL layer mirrors the
exact mutation shapes captured from the Linear web client.
