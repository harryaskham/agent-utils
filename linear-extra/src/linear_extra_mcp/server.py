"""MCP server exposing Linear comment-draft operations via the internal Linear GraphQL API.

The public Linear API (and the official Linear MCP) expose comments but NOT drafts. Linear's
*draft comments* — private, unpublished, server-side notes attached to an issue, visible only to
their author until published in the UI — are only available through the internal client GraphQL
endpoint at https://client-api.linear.app/graphql, authenticated with the browser session cookie.

This server wraps the `draftCreate` / `draftUpdate` / `draftDelete` mutations (plus a draft fetch via
the issue's `comments`/`drafts` surface) observed from the Linear web client, accepting Markdown and
converting it to Linear's ProseMirror `bodyData` shape.

It is intentionally scoped to DRAFTS ONLY: it never creates a live comment and never publishes a
draft. Publishing remains a deliberate human action in the Linear UI.

Auth resolution (first match wins):
  1. LINEAR_SESSION_COOKIE  — full cookie string, e.g.
       "session:<acct>=<jwt>; uploadsSig:<acct>=<jwt>"
  2. LINEAR_COOKIE_FILE     — path to a file whose contents are that cookie string
  3. settings.json (PI agent dir or --settings): keys linear-extra.cookie / linearExtra.cookie
User / org / account ids are derived from the cookie's JWT claims when not provided explicitly; the
Linear `user` id (distinct from accountId) is fetched once via a `viewer { id }` query.
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib import error, request

from mcp.server.fastmcp import FastMCP

from .prosemirror import markdown_to_body_data

DEFAULT_ENDPOINT = "https://client-api.linear.app/graphql"
DEFAULT_CLIENT_VERSION = "1.66706.0"
DEFAULT_SETTINGS_PATH = Path("~/.pi/agent/settings.json").expanduser()
DEFAULT_COOKIE_PATH = Path("~/.pi/agent/linear-session.cookie").expanduser()

log = logging.getLogger("linear-extra-mcp")


@dataclass
class ServerConfig:
    cookie: str
    endpoint: str = DEFAULT_ENDPOINT
    client_version: str = DEFAULT_CLIENT_VERSION
    account_id: str | None = None
    org_id: str | None = None
    user_id: str | None = None  # Linear user id (for `user` header); resolved lazily if absent
    _resolved_user: str | None = field(default=None, repr=False)


def configure_logging(level: str = "WARNING") -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.WARNING),
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


def _b64url_json(segment: str) -> dict[str, Any]:
    segment += "=" * (-len(segment) % 4)
    return json.loads(base64.urlsafe_b64decode(segment))


def _decode_jwt_claims(jwt: str) -> dict[str, Any]:
    try:
        return _b64url_json(jwt.split(".")[1])
    except Exception:  # noqa: BLE001 - best-effort claim extraction
        return {}


def _parse_cookie_claims(cookie: str) -> dict[str, Any]:
    """Pull accountId + orgIds from the session/uploadsSig JWTs inside the cookie string."""
    claims: dict[str, Any] = {}
    for part in cookie.split(";"):
        part = part.strip()
        if "=" not in part:
            continue
        name, _, value = part.partition("=")
        if name.startswith("session:"):
            c = _decode_jwt_claims(value)
            if c.get("userAccountId"):
                claims["account_id"] = c["userAccountId"]
        elif name.startswith("uploadsSig:"):
            c = _decode_jwt_claims(value)
            org_ids = c.get("organizationIds") or []
            if org_ids:
                claims["org_id"] = org_ids[0]
    return claims


def resolve_cookie(args: argparse.Namespace) -> str:
    if args.cookie:
        return args.cookie.strip()
    env_cookie = os.environ.get("LINEAR_SESSION_COOKIE")
    if env_cookie:
        return env_cookie.strip()
    cookie_file = args.cookie_file or os.environ.get("LINEAR_COOKIE_FILE")
    if cookie_file:
        return Path(cookie_file).expanduser().read_text(encoding="utf-8").strip()
    settings_path = Path(args.settings or os.environ.get("LINEAR_EXTRA_SETTINGS", DEFAULT_SETTINGS_PATH)).expanduser()
    if settings_path.exists():
        try:
            data = json.loads(settings_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = {}
        for key in ("linear-extra", "linearExtra"):
            section = data.get(key)
            if not isinstance(section, dict):
                continue
            # A literal cookie value takes precedence over a referenced file.
            if section.get("cookie"):
                return str(section["cookie"]).strip()
            cookie_file_setting = section.get("cookieFile") or section.get("cookie_file")
            if cookie_file_setting:
                return Path(str(cookie_file_setting)).expanduser().read_text(encoding="utf-8").strip()
    # Final fallback: the conventional cookie file location, so the server works with no config.
    if DEFAULT_COOKIE_PATH.exists():
        return DEFAULT_COOKIE_PATH.read_text(encoding="utf-8").strip()
    raise RuntimeError(
        "No Linear session cookie found. Set LINEAR_SESSION_COOKIE, LINEAR_COOKIE_FILE, "
        "a linear-extra.cookie or linear-extra.cookieFile entry in settings.json, "
        f"or place the cookie at {DEFAULT_COOKIE_PATH}."
    )


def build_config(args: argparse.Namespace) -> ServerConfig:
    cookie = resolve_cookie(args)
    claims = _parse_cookie_claims(cookie)
    return ServerConfig(
        cookie=cookie,
        endpoint=args.endpoint,
        client_version=args.client_version,
        account_id=args.account_id or os.environ.get("LINEAR_ACCOUNT_ID") or claims.get("account_id"),
        org_id=args.org_id or os.environ.get("LINEAR_ORG_ID") or claims.get("org_id"),
        user_id=args.user_id or os.environ.get("LINEAR_USER_ID"),
    )


def _headers(config: ServerConfig, user_id: str | None) -> dict[str, str]:
    headers = {
        "accept": "*/*",
        "content-type": "application/json",
        "origin": "https://linear.app",
        "linear-client-version": config.client_version,
        "cookie": config.cookie,
    }
    if config.org_id:
        headers["organization"] = config.org_id
    if config.account_id:
        headers["useraccount"] = config.account_id
    if user_id:
        headers["user"] = user_id
    return headers


def graphql(
    config: ServerConfig,
    query: str,
    variables: dict[str, Any] | None = None,
    operation_name: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    payload = {"query": query, "variables": variables or {}}
    if operation_name:
        payload["operationName"] = operation_name
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(config.endpoint, data=body, method="POST")
    for key, value in _headers(config, user_id).items():
        req.add_header(key, value)
    try:
        with request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"Linear GraphQL HTTP {exc.code}: {detail}") from exc
    if data.get("errors"):
        raise RuntimeError(f"Linear GraphQL error: {json.dumps(data['errors'])}")
    return data.get("data", {})


def resolve_user_id(config: ServerConfig) -> str:
    """Fetch and cache the Linear user id (for the `user` header) via viewer { id }."""
    if config.user_id:
        return config.user_id
    if config._resolved_user:
        return config._resolved_user
    data = graphql(config, "query { viewer { id } }")
    uid = (data.get("viewer") or {}).get("id")
    if not uid:
        raise RuntimeError("Could not resolve Linear user id from viewer query.")
    config._resolved_user = uid
    return uid


def resolve_issue_uuid(config: ServerConfig, issue: str) -> str:
    """Accept an issue UUID or human identifier (e.g. HE-212) and return the internal UUID."""
    if "-" in issue and len(issue) >= 32 and issue.count("-") >= 4:
        return issue  # already a UUID
    uid = resolve_user_id(config)
    data = graphql(
        config,
        "query IssueId($id: String!) { issue(id: $id) { id identifier } }",
        {"id": issue},
        operation_name="IssueId",
        user_id=uid,
    )
    found = (data.get("issue") or {}).get("id")
    if not found:
        raise RuntimeError(f"Could not resolve issue '{issue}' to an internal UUID.")
    return found


# --- Draft mutations -------------------------------------------------------------------------

_DRAFT_CREATE = (
    "mutation DraftCreate($input: DraftCreateInput!) "
    "{ draftCreate(input: $input) { lastSyncId draft { id } } }"
)
_DRAFT_UPDATE = (
    "mutation DraftUpdate($id: String!, $input: DraftUpdateInput!) "
    "{ draftUpdate(id: $id, input: $input) { lastSyncId draft { id } } }"
)
_DRAFT_DELETE = "mutation DraftDelete($id: String!) { draftDelete(id: $id) { lastSyncId } }"


def create_draft(config: ServerConfig, issue: str, markdown: str) -> dict[str, Any]:
    uid = resolve_user_id(config)
    issue_uuid = resolve_issue_uuid(config, issue)
    draft_id = str(uuid.uuid4())
    body_data = markdown_to_body_data(markdown)
    variables = {
        "input": {
            "id": draft_id,
            "userId": uid,
            "wasLocalDraft": False,
            "data": {},
            "issueId": issue_uuid,
            "bodyData": body_data,
        }
    }
    data = graphql(config, _DRAFT_CREATE, variables, "DraftCreate", user_id=uid)
    return {
        "draftId": draft_id,
        "issueId": issue_uuid,
        "lastSyncId": (data.get("draftCreate") or {}).get("lastSyncId"),
    }


def update_draft(config: ServerConfig, draft_id: str, markdown: str) -> dict[str, Any]:
    uid = resolve_user_id(config)
    body_data = markdown_to_body_data(markdown)
    variables = {"id": draft_id, "input": {"bodyData": body_data}}
    data = graphql(config, _DRAFT_UPDATE, variables, "DraftUpdate", user_id=uid)
    return {
        "draftId": draft_id,
        "lastSyncId": (data.get("draftUpdate") or {}).get("lastSyncId"),
    }


def delete_draft(config: ServerConfig, draft_id: str) -> dict[str, Any]:
    uid = resolve_user_id(config)
    data = graphql(config, _DRAFT_DELETE, {"id": draft_id}, "DraftDelete", user_id=uid)
    return {
        "draftId": draft_id,
        "deleted": True,
        "lastSyncId": (data.get("draftDelete") or {}).get("lastSyncId"),
    }


def fetch_drafts(config: ServerConfig, issue: str) -> dict[str, Any]:
    """List the caller's draft comments. Optionally scope to one issue's UUID."""
    uid = resolve_user_id(config)
    issue_uuid = resolve_issue_uuid(config, issue) if issue else None
    data = graphql(
        config,
        "query Drafts { viewer { issueDrafts { nodes "
        "{ id title description descriptionData parentIssueId parentId updatedAt createdAt } } } }",
        operation_name="Drafts",
        user_id=uid,
    )
    nodes = (((data.get("viewer") or {}).get("issueDrafts") or {}).get("nodes")) or []
    if issue_uuid:
        nodes = [d for d in nodes if d.get("parentIssueId") == issue_uuid]
    return {"issueId": issue_uuid, "count": len(nodes), "drafts": nodes}


def create_server(config: ServerConfig) -> FastMCP:
    server = FastMCP("linear-extra")

    @server.tool()
    def linear_draft_create(issue: str, markdown: str) -> dict[str, Any]:
        """Create a private Linear draft comment on an issue from Markdown.

        `issue` accepts a Linear issue identifier (e.g. "HE-212") or internal UUID. The draft is
        private to you and unpublished — it is NOT a live comment and notifies no one until you
        publish it in the Linear UI. Returns the new draftId.
        """
        log.info("Creating Linear draft on issue %s", issue)
        return create_draft(config, issue, markdown)

    @server.tool()
    def linear_draft_update(draft_id: str, markdown: str) -> dict[str, Any]:
        """Replace the body of an existing Linear draft comment with new Markdown."""
        log.info("Updating Linear draft %s", draft_id)
        return update_draft(config, draft_id, markdown)

    @server.tool()
    def linear_draft_fetch(issue: str = "") -> dict[str, Any]:
        """List your Linear draft comments, optionally scoped to one issue (identifier or UUID)."""
        log.info("Fetching Linear drafts (issue=%s)", issue or "<all>")
        return fetch_drafts(config, issue)

    @server.tool()
    def linear_draft_delete(draft_id: str) -> dict[str, Any]:
        """Discard a Linear draft comment by id. Only affects unpublished drafts."""
        log.info("Deleting Linear draft %s", draft_id)
        return delete_draft(config, draft_id)

    return server


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the linear-extra MCP server over stdio")
    parser.add_argument("--cookie", default=None, help="Full Linear session cookie string")
    parser.add_argument("--cookie-file", default=None, help="Path to a file containing the cookie")
    parser.add_argument("--settings", default=None, help="settings.json path for linear-extra.cookie")
    parser.add_argument("--endpoint", default=os.environ.get("LINEAR_EXTRA_ENDPOINT", DEFAULT_ENDPOINT))
    parser.add_argument(
        "--client-version",
        default=os.environ.get("LINEAR_CLIENT_VERSION", DEFAULT_CLIENT_VERSION),
    )
    parser.add_argument("--account-id", default=None)
    parser.add_argument("--org-id", default=None)
    parser.add_argument("--user-id", default=None)
    parser.add_argument("--log-level", default=os.environ.get("LINEAR_EXTRA_LOG_LEVEL", "WARNING"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    configure_logging(args.log_level)
    config = build_config(args)
    server = create_server(config)
    server.run(transport="stdio")
