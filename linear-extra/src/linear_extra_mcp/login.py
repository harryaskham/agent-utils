"""Interactive Linear sign-in that captures the session cookie for linear-extra.

`linear-extra-mcp login` checks the configured cookie and, when Linear rejects it, opens a headed
browser (via `playwright-cli`) at the Linear sign-in page with a dedicated persistent profile. Once
you sign in, it reads the cookies the browser would send to the Linear client API (including
httpOnly ones), validates them with a `viewer` query, atomically writes the cookie file (mode 600)
and closes the window. The cookie value is never printed.

With PLAYWRIGHT_MCP_EXTENSION_TOKEN set (or --extension msedge), reuse the operator's existing
browser instead of opening a new profile. After capture, detach without closing that browser.
The MCP server runs recovery in the background when a tool call hits an expired session.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import server

DEFAULT_LOGIN_URL = "https://linear.app/login"
# Keep short: playwright-cli embeds it in a Unix socket path (104-byte limit on macOS).
DEFAULT_SESSION = "lxlogin"
PNPM_PLAYWRIGHT_CLI = Path("~/.local/pnpm/playwright-cli").expanduser()
VIEWER_QUERY = "query Viewer { viewer { id name email organization { id name urlKey } } }"


# --- single-login lock ---------------------------------------------------------------------------

def _lock_path() -> Path:
    return server.state_dir() / "login.lock"


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def login_lock_holder() -> int | None:
    """PID of a live sign-in already in progress; stale locks are removed."""
    path = _lock_path()
    try:
        pid = int(path.read_text(encoding="utf-8").strip())
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        pid = 0
    if pid > 0 and _pid_alive(pid):
        return pid
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    return None


def acquire_login_lock() -> int | None:
    """Take the lock. Returns None on success, or the PID of the live holder."""
    path = _lock_path()
    for _ in range(2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            holder = login_lock_holder()
            if holder:
                return holder
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
        return None
    return login_lock_holder() or -1


def release_login_lock() -> None:
    path = _lock_path()
    try:
        if path.read_text(encoding="utf-8").strip() == str(os.getpid()):
            path.unlink()
    except (OSError, ValueError):
        pass


# --- cookies -------------------------------------------------------------------------------------

def cookie_header(cookies: list[dict[str, Any]]) -> str:
    pairs = sorted((c["name"], c.get("value", "")) for c in cookies if c.get("name"))
    return "; ".join(f"{name}={value}" for name, value in pairs)


def has_session_cookie(cookies: list[dict[str, Any]]) -> bool:
    return any(
        str(c.get("name", "")) == "session" or str(c.get("name", "")).startswith("session:")
        for c in cookies
        if c.get("value")
    )


def parse_cookies_output(output: str) -> list[dict[str, Any]]:
    """Decode `playwright-cli --raw run-code` output, which JSON-encodes the returned string."""
    try:
        value: Any = json.loads(output.strip())
        if isinstance(value, str):
            value = json.loads(value)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Could not parse browser cookies from playwright-cli output.") from exc
    if not isinstance(value, list):
        raise RuntimeError("Unexpected browser cookie output from playwright-cli.")
    return [c for c in value if isinstance(c, dict)]


def write_cookie_file(path: Path, cookie: str) -> None:
    """Atomically replace `path` with the cookie, readable only by the owner."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(cookie)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def validate_cookie(
    cookie: str,
    endpoint: str,
    client_version: str = server.DEFAULT_CLIENT_VERSION,
    *,
    account_id: str | None = None,
    org_id: str | None = None,
    user_id: str | None = None,
) -> tuple[str, dict[str, Any] | str]:
    """Return ("valid", viewer), ("invalid", reason) or ("error", reason)."""
    claims = server._parse_cookie_claims(cookie)
    config = server.ServerConfig(
        cookie=cookie,
        endpoint=endpoint,
        client_version=client_version,
        account_id=account_id or claims.get("account_id"),
        org_id=org_id or claims.get("org_id"),
        user_id=user_id,
    )
    try:
        data = server._graphql_once(config, VIEWER_QUERY, operation_name="Viewer", user_id=user_id)
    except server.LinearAuthError as exc:
        return "invalid", str(exc)[:300]
    except (RuntimeError, OSError) as exc:
        return "error", str(exc)[:300]
    viewer = data.get("viewer") or {}
    if not viewer.get("id"):
        return "error", "Linear viewer query returned no user."
    if user_id and viewer["id"] != user_id:
        return "error", "Linear session belongs to a different configured user; cookie not saved."
    if org_id and (viewer.get("organization") or {}).get("id") != org_id:
        return "error", "Linear session belongs to a different configured workspace; cookie not saved."
    return "valid", viewer


def _viewer_summary(viewer: dict[str, Any]) -> dict[str, Any]:
    org = viewer.get("organization") or {}
    return {"name": viewer.get("name"), "email": viewer.get("email"), "organization": org.get("urlKey")}


# --- playwright-cli ------------------------------------------------------------------------------

def find_playwright_cli() -> str:
    for candidate in (os.environ.get("LINEAR_EXTRA_PLAYWRIGHT_CLI"), shutil.which("playwright-cli")):
        if candidate:
            return candidate
    if PNPM_PLAYWRIGHT_CLI.exists():
        return str(PNPM_PLAYWRIGHT_CLI)
    raise RuntimeError(
        "playwright-cli not found. Install it (`npm install -g @playwright/cli@latest`) or set "
        "LINEAR_EXTRA_PLAYWRIGHT_CLI."
    )


class PlaywrightCli:
    """Minimal driver for one named playwright-cli browser session."""

    def __init__(self, session: str, cwd: Path, binary: str | None = None):
        self.session = session
        self.cwd = cwd
        self.binary = binary or find_playwright_cli()

    def _cmd(self, *args: str) -> list[str]:
        return [self.binary, f"-s={self.session}", *args]

    def _run(self, *args: str, timeout: float = 60) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            self._cmd(*args),
            cwd=self.cwd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def open(self, url: str, *, headless: bool, browser: str, profile_dir: Path) -> None:
        args = ["open", url, f"--browser={browser}", f"--profile={profile_dir}"]
        if not headless:
            args.append("--headed")
        log_path = self.cwd / "playwright-open.log"
        # Write to a file rather than a pipe: the browser daemon may inherit the descriptors.
        with open(log_path, "w", encoding="utf-8") as log_file:
            result = subprocess.run(
                self._cmd(*args),
                cwd=self.cwd,
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                timeout=120,
            )
        if result.returncode != 0:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-500:]
            raise RuntimeError(f"playwright-cli open failed ({result.returncode}): {tail}")

    def attach(self, browser: str) -> None:
        # The current bridge uses protocol v2; CLI 0.1.10 cannot connect to it.
        result = self._run("--version", timeout=15)
        version = re.search(r"\b(\d+)\.(\d+)\.(\d+)\b", result.stdout)
        if result.returncode or not version or tuple(map(int, version.groups())) < (0, 1, 22):
            raise RuntimeError(
                "The Edge bridge requires playwright-cli 0.1.22 or newer. "
                "Select a compatible binary with LINEAR_EXTRA_PLAYWRIGHT_CLI."
            )
        result = self._run("--raw", "attach", f"--extension={browser}", timeout=90)
        if result.returncode:
            # CLI output may contain the extension token in its connection URL. Never echo it.
            raise RuntimeError(
                "Playwright extension attachment failed. Check the installed bridge, CLI version "
                "and PLAYWRIGHT_MCP_EXTENSION_TOKEN; no separate browser was opened."
            )

    def detach(self) -> None:
        # Never close/kill an operator-owned browser, even when refresh fails.
        try:
            self._run("detach", timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def cookies(self, url: str) -> list[dict[str, Any]]:
        code = f"async page => JSON.stringify(await page.context().cookies([{json.dumps(url)}]))"
        result = self._run("--raw", "run-code", code, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(f"playwright-cli run-code failed ({result.returncode})")
        return parse_cookies_output(result.stdout)

    def is_open(self) -> bool:
        try:
            result = subprocess.run(
                [self.binary, "list", "--json"],
                cwd=self.cwd,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=30,
            )
            browsers = json.loads(result.stdout).get("browsers", [])
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, AttributeError):
            return False
        return any(b.get("name") == self.session and b.get("status") == "open" for b in browsers)

    def close(self) -> None:
        try:
            self._run("close", timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            pass


# --- login flow ----------------------------------------------------------------------------------

def login(
    args: argparse.Namespace,
    *,
    playwright: Any = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    endpoint = args.endpoint
    context = {
        "account_id": args.account_id or os.environ.get("LINEAR_ACCOUNT_ID"),
        "org_id": args.org_id or os.environ.get("LINEAR_ORG_ID"),
        "user_id": args.user_id or os.environ.get("LINEAR_USER_ID"),
    }
    target, shadowed = server.cookie_target_path(args)
    result: dict[str, Any] = {"cookie_file": str(target)}
    if shadowed:
        result["warning"] = (
            "A literal cookie (--cookie, LINEAR_SESSION_COOKIE or settings linear-extra.cookie) "
            "takes precedence over this file; remove it so the refreshed file is used."
        )

    try:
        current, source = server.resolve_cookie_source(args)
    except RuntimeError:
        current, source = "", None
    if current and not args.force:
        status, info = validate_cookie(current, endpoint, args.client_version, **context)
        if status == "valid":
            return {
                **result,
                "status": "valid",
                "source": str(source) if source else "literal",
                "viewer": _viewer_summary(info),
            }
        if args.check:
            return {**result, "status": status, "detail": info}
    elif args.check:
        return {**result, "status": "missing"}

    holder = acquire_login_lock()
    if holder:
        return {**result, "status": "busy", "pid": holder}
    pw = playwright
    opened = False
    try:
        cwd = server.state_dir()
        if pw is None:
            pw = PlaywrightCli(args.session, cwd)
        if args.extension:
            pw.attach(args.extension)
            message = (
                f"Attached to existing {args.extension}. Keep your signed-in Linear tab available; "
                "the helper will detach after saving the session, leaving the browser open."
            )
        else:
            profile_dir = Path(args.profile_dir or cwd / "browser-profile").expanduser()
            profile_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            pw.close()  # only our dedicated browser, never the extension-attached browser
            pw.open(args.login_url, headless=args.headless, browser=args.browser, profile_dir=profile_dir)
            message = (
                f"Opened Linear sign-in ({args.browser}). Sign in there; the window closes itself "
                "once the session is saved."
            )
        opened = True
        print(f"{message} Waiting up to {int(args.timeout)}s.", file=sys.stderr, flush=True)
        cookie_url = args.cookie_url or endpoint
        deadline = clock() + args.timeout
        last_header: str | None = None
        last_validated = float("-inf")
        last_status = "waiting"
        failures = 0
        while clock() < deadline:
            try:
                cookies = pw.cookies(cookie_url)
                failures = 0
            except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
                failures += 1
                if failures >= 3 or not pw.is_open():
                    return {**result, "status": "aborted", "detail": f"sign-in window closed ({exc})"}
                sleep(args.poll_interval)
                continue
            header = cookie_header(cookies)
            now = clock()
            if (
                has_session_cookie(cookies)
                and header != last_header
                and now - last_validated >= args.validate_interval
            ):
                last_header, last_validated = header, now
                status, info = validate_cookie(header, endpoint, args.client_version, **context)
                last_status = status
                if status == "valid":
                    write_cookie_file(target, header)
                    return {
                        **result,
                        "status": "refreshed",
                        "viewer": _viewer_summary(info),
                        "cookie_names": sorted({c["name"] for c in cookies if c.get("name")}),
                    }
            sleep(args.poll_interval)
        return {**result, "status": "timeout", "last_validation": last_status}
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        return {**result, "status": "error", "detail": str(exc)[:500]}
    finally:
        if pw is not None:
            if args.extension:
                # Also detach after a failed/partially completed attachment.
                pw.detach()
            elif opened:
                pw.close()
        release_login_lock()


def _login_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="linear-extra-mcp login",
        description="Check the Linear session cookie and, if Linear rejects it, open a browser to "
        "sign in and save the fresh cookie (never printed).",
    )
    server.add_common_args(parser)
    parser.add_argument("--check", action="store_true", help="Only report whether the cookie works")
    parser.add_argument("--force", action="store_true", help="Sign in even if the cookie works")
    parser.add_argument("--timeout", type=float, default=600.0, help="Seconds to wait for sign-in")
    parser.add_argument(
        "--browser",
        default=os.environ.get("LINEAR_EXTRA_BROWSER", "chrome"),
        help="playwright-cli browser/channel: chrome (default), msedge, firefox, webkit",
    )
    parser.add_argument(
        "--extension",
        choices=("msedge", "chrome", "none"),
        default=os.environ.get("LINEAR_EXTRA_EXTENSION")
        or ("msedge" if os.environ.get("PLAYWRIGHT_MCP_EXTENSION_TOKEN") else "none"),
        help="Reuse a running browser via the Playwright bridge; defaults to msedge when the "
        "extension token is set. 'none' uses a dedicated sign-in profile.",
    )
    parser.add_argument(
        "--profile-dir",
        default=os.environ.get("LINEAR_EXTRA_PROFILE_DIR"),
        help="Persistent sign-in browser profile (default: <state dir>/browser-profile)",
    )
    parser.add_argument(
        "--login-url", default=os.environ.get("LINEAR_EXTRA_LOGIN_URL", DEFAULT_LOGIN_URL)
    )
    parser.add_argument("--cookie-url", default=None, help="URL whose cookies to capture (default: endpoint)")
    parser.add_argument("--headless", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--session", default=DEFAULT_SESSION, help=argparse.SUPPRESS)
    parser.add_argument("--poll-interval", type=float, default=1.0, help=argparse.SUPPRESS)
    parser.add_argument("--validate-interval", type=float, default=3.0, help=argparse.SUPPRESS)
    return parser


def parse_login_args(argv: list[str] | None = None) -> argparse.Namespace:
    args = _login_parser().parse_args(argv)
    if args.extension == "none":
        args.extension = None
    return args


EXIT_CODES = {"valid": 0, "refreshed": 0, "invalid": 2, "missing": 2, "timeout": 3, "aborted": 3, "busy": 4}


def login_main(argv: list[str] | None = None) -> int:
    args = parse_login_args(argv)
    server.configure_logging(args.log_level)
    result = login(args)
    print(json.dumps(result, indent=2))
    return EXIT_CODES.get(result["status"], 1)
