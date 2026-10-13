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
  4. ~/.pi/agent/linear-session.cookie
User / org / account ids are derived from the cookie's JWT claims when not provided explicitly; the
Linear `user` id (distinct from accountId) is fetched once via a `viewer { id }` query.

Cookie files are re-read whenever they change. When Linear rejects the session, the server starts
background recovery (`linear-extra-mcp login`, see login.py) and asks the caller to retry. With an
extension token it reuses Edge and detaches; otherwise it owns a dedicated sign-in browser.
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import subprocess
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib import error, request

from mcp.server.fastmcp import FastMCP

from . import auth
from .prosemirror import markdown_to_body_data

DEFAULT_ENDPOINT = "https://client-api.linear.app/graphql"
DEFAULT_CLIENT_VERSION = "1.66706.0"
DEFAULT_SETTINGS_PATH = Path("~/.pi/agent/settings.json").expanduser()
DEFAULT_COOKIE_PATH = Path("~/.pi/agent/linear-session.cookie").expanduser()

log = logging.getLogger("linear-extra-mcp")


@dataclass
class ServerConfig:
    cookie: str = field(repr=False)
    endpoint: str = DEFAULT_ENDPOINT
    client_version: str = DEFAULT_CLIENT_VERSION
    account_id: str | None = None
    org_id: str | None = None
    user_id: str | None = None  # Linear user id (for `user` header); resolved lazily if absent
    _resolved_user: str | None = field(default=None, repr=False)
    # Cookie file to watch for refreshed credentials (None for literal/env cookies).
    cookie_source: Path | None = None
    _cookie_stamp: tuple[int, int] | None = field(default=None, repr=False)
    _explicit_account: bool = field(default=False, repr=False)
    _explicit_org: bool = field(default=False, repr=False)
    _explicit_user: bool = field(default=False, repr=False)
    auth_remote: str | None = None
    auth_config: str | None = None


class LinearAuthError(RuntimeError):
    """Linear rejected (or never received) the session cookie."""


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


def _settings_section(args: argparse.Namespace) -> dict[str, Any]:
    """Return the first linear-extra settings section that configures a cookie."""
    settings_path = Path(
        getattr(args, "settings", None)
        or os.environ.get("LINEAR_EXTRA_SETTINGS", DEFAULT_SETTINGS_PATH)
    ).expanduser()
    if not settings_path.exists():
        return {}
    try:
        data = json.loads(settings_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    for key in ("linear-extra", "linearExtra"):
        section = data.get(key)
        if isinstance(section, dict) and (
            section.get("cookie") or section.get("cookieFile") or section.get("cookie_file")
        ):
            return section
    return {}


def _read_cookie_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise RuntimeError(f"Linear cookie file not found: {path}") from exc


def resolve_cookie_source(args: argparse.Namespace) -> tuple[str, Path | None]:
    """Return (cookie, source file) using the documented precedence; literal sources have no file."""
    if getattr(args, "cookie", None):
        return args.cookie.strip(), None
    env_cookie = os.environ.get("LINEAR_SESSION_COOKIE")
    if env_cookie:
        return env_cookie.strip(), None
    cookie_file = getattr(args, "cookie_file", None) or os.environ.get("LINEAR_COOKIE_FILE")
    if cookie_file:
        path = Path(cookie_file).expanduser()
        return _read_cookie_file(path), path
    section = _settings_section(args)
    # A literal cookie value takes precedence over a referenced file.
    if section.get("cookie"):
        return str(section["cookie"]).strip(), None
    cookie_file_setting = section.get("cookieFile") or section.get("cookie_file")
    if cookie_file_setting:
        path = Path(str(cookie_file_setting)).expanduser()
        return _read_cookie_file(path), path
    # Final fallback: the conventional cookie file location, so the server works with no config.
    if DEFAULT_COOKIE_PATH.exists():
        return _read_cookie_file(DEFAULT_COOKIE_PATH), DEFAULT_COOKIE_PATH
    raise RuntimeError(
        "No Linear session cookie found. Run `linear-extra-mcp login`, or set "
        "LINEAR_SESSION_COOKIE, LINEAR_COOKIE_FILE, a linear-extra.cookie or "
        f"linear-extra.cookieFile entry in settings.json, or place the cookie at {DEFAULT_COOKIE_PATH}."
    )


def resolve_cookie(args: argparse.Namespace) -> str:
    return resolve_cookie_source(args)[0]


def cookie_target_path(args: argparse.Namespace) -> tuple[Path, bool]:
    """Return the file a refreshed cookie belongs in, and whether a literal cookie overrides it."""
    shadowed = bool(getattr(args, "cookie", None) or os.environ.get("LINEAR_SESSION_COOKIE"))
    cookie_file = getattr(args, "cookie_file", None) or os.environ.get("LINEAR_COOKIE_FILE")
    if cookie_file:
        return Path(cookie_file).expanduser(), shadowed
    section = _settings_section(args)
    shadowed = shadowed or bool(section.get("cookie"))
    cookie_file_setting = section.get("cookieFile") or section.get("cookie_file")
    if cookie_file_setting:
        return Path(str(cookie_file_setting)).expanduser(), shadowed
    return DEFAULT_COOKIE_PATH, shadowed


def state_dir() -> Path:
    """Private directory for the sign-in browser profile, lock and log."""
    base = os.environ.get("LINEAR_EXTRA_STATE_DIR")
    path = (
        Path(base).expanduser()
        if base
        else Path(os.environ.get("XDG_CACHE_HOME", "~/.cache")).expanduser() / "linear-extra"
    )
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def _file_stamp(path: Path | None) -> tuple[int, int] | None:
    if path is None:
        return None
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def build_config(args: argparse.Namespace) -> ServerConfig:
    try:
        cookie, source = resolve_cookie_source(args)
    except RuntimeError:
        # Start anyway: the first tool call reports the missing session and opens sign-in.
        cookie, source = "", cookie_target_path(args)[0]
    claims = _parse_cookie_claims(cookie)
    context = auth.context_for(args, source, cookie)
    account_id = args.account_id or os.environ.get("LINEAR_ACCOUNT_ID")
    org_id = args.org_id or os.environ.get("LINEAR_ORG_ID")
    user_id = args.user_id or os.environ.get("LINEAR_USER_ID")
    return ServerConfig(
        cookie=cookie,
        endpoint=args.endpoint,
        client_version=args.client_version,
        account_id=context["account_id"] or claims.get("account_id"),
        org_id=context["org_id"] or claims.get("org_id"),
        user_id=context["user_id"],
        cookie_source=source,
        _cookie_stamp=_file_stamp(source),
        _explicit_account=bool(account_id),
        _explicit_org=bool(org_id),
        _explicit_user=bool(user_id),
        auth_remote=args.remote,
        auth_config=args.auth_config,
    )


def _maybe_reload(config: ServerConfig) -> bool:
    """Re-read the cookie file if it changed since it was last loaded."""
    stamp = _file_stamp(config.cookie_source)
    if stamp is None or stamp == config._cookie_stamp:
        return False
    try:
        cookie = _read_cookie_file(config.cookie_source)
    except RuntimeError:
        return False
    config._cookie_stamp = stamp
    config.cookie = cookie
    claims = _parse_cookie_claims(cookie)
    identity = auth.cookie_identity(config.cookie_source, cookie)
    if not config._explicit_account:
        config.account_id = identity.get("account_id") or claims.get("account_id")
    if not config._explicit_org:
        config.org_id = identity.get("org_id") or claims.get("org_id")
    if not config._explicit_user:
        config.user_id = identity.get("user_id")
    config._resolved_user = None
    log.info("Reloaded Linear session cookie from %s", config.cookie_source)
    return True


def _headers(config: ServerConfig, user_id: str | None) -> dict[str, str]:
    user_id = user_id or config.user_id or config._resolved_user
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


def _is_auth_error(errors: Any) -> bool:
    for err in errors if isinstance(errors, list) else []:
        ext = (err or {}).get("extensions") or {}
        if ext.get("code") == "AUTHENTICATION_ERROR" or "authentication" in str(ext.get("type", "")):
            return True
    return False


def _error_messages(errors: Any, fallback: str) -> str:
    messages = [str(e.get("message")) for e in errors or [] if isinstance(e, dict) and e.get("message")]
    return "; ".join(messages) or fallback[:300]


def _graphql_once(
    config: ServerConfig,
    query: str,
    variables: dict[str, Any] | None = None,
    operation_name: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    if not config.cookie:
        raise LinearAuthError("No Linear session cookie is configured.")
    payload = {"query": query, "variables": variables or {}}
    if operation_name:
        payload["operationName"] = operation_name
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(config.endpoint, data=body, method="POST")
    for key, value in _headers(config, user_id).items():
        req.add_header(key, value)
    try:
        with request.build_opener(auth.NoRedirect).open(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        try:
            errors = json.loads(detail).get("errors")
        except (json.JSONDecodeError, AttributeError):
            errors = None
        if exc.code == 401 or _is_auth_error(errors):
            raise LinearAuthError(
                f"Linear GraphQL HTTP {exc.code}: {_error_messages(errors, detail)}"
            ) from exc
        raise RuntimeError(f"Linear GraphQL HTTP {exc.code}: {detail}") from exc
    if data.get("errors"):
        if _is_auth_error(data["errors"]):
            raise LinearAuthError(f"Linear GraphQL error: {_error_messages(data['errors'], '')}")
        raise RuntimeError(f"Linear GraphQL error: {json.dumps(data['errors'])}")
    return data.get("data", {})


def graphql(
    config: ServerConfig,
    query: str,
    variables: dict[str, Any] | None = None,
    operation_name: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    _maybe_reload(config)
    try:
        return _graphql_once(config, query, variables, operation_name, user_id)
    except LinearAuthError as first:
        cause: LinearAuthError = first
    if _maybe_reload(config):
        try:
            return _graphql_once(config, query, variables, operation_name, user_id)
        except LinearAuthError as retry:
            cause = retry
    login = start_background_login(config)
    raise LinearAuthError(_expired_message(login)) from cause


def _expired_message(login: dict[str, Any]) -> str:
    status = login.get("status")
    prefix = "Linear session expired or missing (Linear rejected the session cookie)."
    if status == "started":
        return (
            f"{prefix} Started Linear session recovery. Complete any sign-in or Edge connection "
            "prompt, then retry this call. Recovery leaves an existing browser open."
        )
    if status == "running":
        return (
            f"{prefix} Linear session recovery is already running (pid {login.get('pid')}): "
            "complete any sign-in or Edge connection prompt, then retry this call."
        )
    reason = {
        "disabled": "automatic sign-in is disabled (LINEAR_EXTRA_AUTO_LOGIN=0)",
        "no-display": "no graphical display is available here",
    }.get(str(status), f"could not open sign-in automatically: {login.get('error', status)}")
    return f"{prefix} {reason[0].upper()}{reason[1:]}. Run `linear-extra-mcp login`, then retry."


def _display_available() -> bool:
    return sys.platform == "darwin" or bool(
        os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
    )


_LOGIN_PROCS: list[subprocess.Popen] = []


def start_background_login(config: ServerConfig) -> dict[str, Any]:
    """Open the interactive sign-in flow in a detached process (at most one at a time)."""
    _LOGIN_PROCS[:] = [p for p in _LOGIN_PROCS if p.poll() is None]
    if os.environ.get("LINEAR_EXTRA_AUTO_LOGIN", "1").strip().lower() in {"0", "false", "no", "off"}:
        return {"status": "disabled"}
    if not config.auth_remote and not _display_available():
        return {"status": "no-display"}
    from .login import login_lock_holder  # local import: login imports this module

    holder = login_lock_holder()
    if holder:
        return {"status": "running", "pid": holder}
    cmd = [
        sys.executable,
        "-m",
        "linear_extra_mcp",
        "login",
        "--timeout",
        "900",
        "--endpoint",
        config.endpoint,
        "--client-version",
        config.client_version,
    ]
    if config.auth_config:
        cmd += ["--config", config.auth_config]
    cmd += ["--remote", config.auth_remote] if config.auth_remote else ["--local"]
    if config.cookie_source is not None:
        cmd += ["--cookie-file", str(config.cookie_source)]
    for option, value in (
        ("--account-id", config.account_id),
        ("--org-id", config.org_id),
        ("--user-id", config.user_id or config._resolved_user),
    ):
        if value:
            cmd += [option, value]
    try:
        with open(state_dir() / "login.log", "a", encoding="utf-8") as log_file:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,  # never read the MCP stdio stream
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
    except OSError as exc:
        return {"status": "failed", "error": str(exc)}
    _LOGIN_PROCS.append(proc)
    return {"status": "started", "pid": proc.pid}


def resolve_user_id(config: ServerConfig) -> str:
    """Fetch and cache the Linear user id (for the `user` header) via viewer { id }."""
    _maybe_reload(config)
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


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", dest="auth_config", default=None, help="Shared Linear auth config (default: ~/.config/linear/config.json)")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--remote", default=None, help="Import existing credentials over SSH from user@host")
    source.add_argument("--local", action="store_true", help="Ignore authRemote; refresh on this node")
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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the linear-extra MCP server over stdio "
        "(`linear-extra-mcp login --help` refreshes the Linear session)"
    )
    add_common_args(parser)
    return auth.apply_settings(parser.parse_args(argv))


def main(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["auth"]:
        raise SystemExit(auth.auth_main(argv[1:]))
    if argv[:1] == ["login"]:
        from .login import login_main

        raise SystemExit(login_main(argv[1:]))
    args = parse_args(argv)
    configure_logging(args.log_level)
    config = build_config(args)
    server = create_server(config)
    server.run(transport="stdio")
