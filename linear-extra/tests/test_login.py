"""Tests for session refresh: auth errors, cookie reload, background sign-in and the login flow."""

from __future__ import annotations

import http.server
import json
import os
import shutil
import stat
import subprocess
import sys
import threading
import uuid

import pytest

from linear_extra_mcp import login, server


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    for var in (
        "LINEAR_SESSION_COOKIE",
        "LINEAR_COOKIE_FILE",
        "LINEAR_EXTRA_SETTINGS",
        "LINEAR_ACCOUNT_ID",
        "LINEAR_ORG_ID",
        "LINEAR_USER_ID",
        "LINEAR_EXTRA_ENDPOINT",
        "LINEAR_EXTRA_AUTO_LOGIN",
        "LINEAR_EXTRA_PROFILE_DIR",
        "LINEAR_EXTRA_LOGIN_URL",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("LINEAR_EXTRA_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(server, "DEFAULT_SETTINGS_PATH", tmp_path / "no-settings.json")
    monkeypatch.setattr(server, "DEFAULT_COOKIE_PATH", tmp_path / "default.cookie")


@pytest.fixture
def fake_linear():
    """A local stand-in for linear.app: /login sets a session cookie, /graphql checks it."""
    state = {"session": "session:a=good", "forbidden": False, "graphql_calls": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, code, body=b"", headers=()):
            self.send_response(code)
            for key, value in headers:
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith("/login"):
                html = b"<html><body>sign in<script>setTimeout(() => fetch('/set-session'), 300)</script></body></html>"
                self._send(200, html, [("Content-Type", "text/html")])
            elif self.path.startswith("/set-session"):
                self._send(
                    200,
                    b"ok",
                    [("Set-Cookie", f"{state['session']}; Path=/; HttpOnly"), ("Set-Cookie", "loggedIn=1; Path=/")],
                )
            else:
                self._send(404)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            state["graphql_calls"] += 1
            pairs = {p.strip() for p in (self.headers.get("cookie") or "").split(";")}
            if state["forbidden"]:
                errors = [{"message": "Auth method not allowed", "extensions": {"code": "FORBIDDEN", "type": "forbidden"}}]
                self._send(400, json.dumps({"errors": errors}).encode())
            elif state["session"] in pairs:
                viewer = {"id": "user-1", "name": "Test User", "email": "t@example.com",
                          "organization": {"id": "org-1", "name": "Org", "urlKey": "org"}}
                self._send(200, json.dumps({"data": {"viewer": viewer}}).encode())
            else:
                errors = [{"message": "Authentication required, not authenticated",
                           "extensions": {"type": "authentication error", "code": "AUTHENTICATION_ERROR"}}]
                self._send(401, json.dumps({"errors": errors}).encode())

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    state.update(base=base, endpoint=f"{base}/graphql")
    try:
        yield state
    finally:
        srv.shutdown()
        srv.server_close()


class FakePlaywright:
    def __init__(self, states, open_after_failure=True):
        self.states = list(states)
        self.opened = None
        self.closed = 0
        self.open_after_failure = open_after_failure

    def open(self, url, *, headless, browser, profile_dir):
        self.opened = {"url": url, "headless": headless, "browser": browser, "profile_dir": profile_dir}

    def cookies(self, url):
        state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        if isinstance(state, Exception):
            raise state
        return state

    def is_open(self):
        return self.open_after_failure

    def close(self):
        self.closed += 1


def login_args(fake, cookie_file, tmp_path, *extra):
    return login.parse_login_args(
        ["--endpoint", fake["endpoint"], "--cookie-file", str(cookie_file),
         "--profile-dir", str(tmp_path / "profile"), "--poll-interval", "0",
         "--validate-interval", "0", *extra]
    )


def cookie(name, value):
    return {"name": name, "value": value, "domain": "linear.app", "path": "/", "httpOnly": True}


# --- helpers -------------------------------------------------------------------------------------

def test_cookie_header_and_session_detection():
    cookies = [cookie("session:a", "jwt"), cookie("loggedIn", "1"), {"name": "", "value": "x"}]
    assert login.cookie_header(cookies) == "loggedIn=1; session:a=jwt"
    assert login.has_session_cookie(cookies)
    assert not login.has_session_cookie([cookie("loggedIn", "1"), cookie("session:a", "")])


def test_parse_cookies_output_handles_double_encoding():
    raw = [cookie("session:a", "v=1;x")]
    assert login.parse_cookies_output(json.dumps(raw)) == raw
    assert login.parse_cookies_output(json.dumps(json.dumps(raw)) + "\n") == raw
    with pytest.raises(RuntimeError):
        login.parse_cookies_output("not json")


def test_write_cookie_file_is_private(tmp_path):
    path = tmp_path / "nested" / "linear.cookie"
    login.write_cookie_file(path, "session:a=good")
    login.write_cookie_file(path, "session:a=newer")
    assert path.read_text(encoding="utf-8") == "session:a=newer"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert [p.name for p in path.parent.iterdir()] == ["linear.cookie"]


def test_cookie_target_path_precedence(tmp_path, monkeypatch):
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"linear-extra": {"cookieFile": str(tmp_path / "s.cookie")}}))
    target, shadowed = server.cookie_target_path(server.parse_args(["--settings", str(settings)]))
    assert (target, shadowed) == (tmp_path / "s.cookie", False)

    args = server.parse_args(["--settings", str(settings), "--cookie-file", str(tmp_path / "x.cookie")])
    assert server.cookie_target_path(args) == (tmp_path / "x.cookie", False)

    monkeypatch.setenv("LINEAR_SESSION_COOKIE", "session:a=literal")
    assert server.cookie_target_path(args) == (tmp_path / "x.cookie", True)

    monkeypatch.delenv("LINEAR_SESSION_COOKIE")
    assert server.cookie_target_path(server.parse_args([])) == (server.DEFAULT_COOKIE_PATH, False)


# --- server auth handling -----------------------------------------------------------------------

def test_auth_errors_are_distinguished(fake_linear):
    config = server.ServerConfig(cookie="session:a=bad", endpoint=fake_linear["endpoint"])
    with pytest.raises(server.LinearAuthError):
        server._graphql_once(config, "query { viewer { id } }")
    fake_linear["forbidden"] = True
    with pytest.raises(RuntimeError) as excinfo:
        server._graphql_once(config, "query { viewer { id } }")
    assert not isinstance(excinfo.value, server.LinearAuthError)


def test_graphql_reloads_rotated_cookie_file(fake_linear, tmp_path, monkeypatch):
    cookie_file = tmp_path / "linear.cookie"
    cookie_file.write_text("session:a=bad", encoding="utf-8")
    config = server.build_config(
        server.parse_args(["--cookie-file", str(cookie_file), "--endpoint", fake_linear["endpoint"]])
    )
    started = []
    monkeypatch.setattr(server, "start_background_login", lambda cfg: started.append(cfg) or {"status": "started", "pid": 1})

    with pytest.raises(server.LinearAuthError, match="sign-in browser window"):
        server.graphql(config, "query { viewer { id } }")
    assert len(started) == 1

    login.write_cookie_file(cookie_file, "loggedIn=1; session:a=good")
    assert server.graphql(config, "query { viewer { id } }")["viewer"]["id"] == "user-1"
    assert len(started) == 1


def test_missing_cookie_starts_server_then_recovers(fake_linear, tmp_path, monkeypatch):
    config = server.build_config(server.parse_args(["--endpoint", fake_linear["endpoint"]]))
    assert config.cookie == "" and config.cookie_source == server.DEFAULT_COOKIE_PATH
    monkeypatch.setattr(server, "start_background_login", lambda cfg: {"status": "disabled"})
    with pytest.raises(server.LinearAuthError, match="linear-extra-mcp login"):
        server.graphql(config, "query { viewer { id } }")
    assert fake_linear["graphql_calls"] == 0  # an empty cookie is never sent

    login.write_cookie_file(server.DEFAULT_COOKIE_PATH, "session:a=good")
    assert server.graphql(config, "query { viewer { id } }")["viewer"]["id"] == "user-1"


def test_background_login_disabled_running_and_started(tmp_path, monkeypatch):
    config = server.ServerConfig(cookie="", endpoint="https://example.invalid/graphql",
                                 cookie_source=tmp_path / "linear.cookie")
    monkeypatch.setattr(server, "_display_available", lambda: True)

    monkeypatch.setenv("LINEAR_EXTRA_AUTO_LOGIN", "0")
    assert server.start_background_login(config) == {"status": "disabled"}
    monkeypatch.setenv("LINEAR_EXTRA_AUTO_LOGIN", "1")

    calls = []

    class Proc:
        pid = 4242

        def poll(self):
            return None

    def fake_popen(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return Proc()

    monkeypatch.setattr(server.subprocess, "Popen", fake_popen)
    assert server.start_background_login(config) == {"status": "started", "pid": 4242}
    cmd, kwargs = calls[0]
    assert cmd[1:4] == ["-m", "linear_extra_mcp", "login"]
    assert cmd[cmd.index("--cookie-file") + 1] == str(tmp_path / "linear.cookie")
    assert kwargs["stdin"] is subprocess.DEVNULL and kwargs["start_new_session"]

    (server.state_dir() / "login.lock").write_text(str(os.getppid()))
    assert server.start_background_login(config) == {"status": "running", "pid": os.getppid()}
    assert len(calls) == 1

    monkeypatch.setattr(server, "_display_available", lambda: False)
    (server.state_dir() / "login.lock").unlink()
    assert server.start_background_login(config) == {"status": "no-display"}


# --- login flow ----------------------------------------------------------------------------------

def test_login_keeps_valid_cookie_without_browser(fake_linear, tmp_path):
    cookie_file = tmp_path / "linear.cookie"
    cookie_file.write_text("session:a=good")
    pw = FakePlaywright([[]])
    result = login.login(login_args(fake_linear, cookie_file, tmp_path), playwright=pw)
    assert result["status"] == "valid" and result["viewer"]["email"] == "t@example.com"
    assert pw.opened is None


def test_check_reports_invalid_or_missing_without_browser(fake_linear, tmp_path):
    cookie_file = tmp_path / "linear.cookie"
    pw = FakePlaywright([[]])
    assert login.login(login_args(fake_linear, cookie_file, tmp_path, "--check"), playwright=pw)["status"] == "missing"
    cookie_file.write_text("session:a=bad")
    assert login.login(login_args(fake_linear, cookie_file, tmp_path, "--check"), playwright=pw)["status"] == "invalid"
    assert pw.opened is None


def test_login_captures_validated_cookie(fake_linear, tmp_path):
    cookie_file = tmp_path / "linear.cookie"
    cookie_file.write_text("session:a=bad")
    pw = FakePlaywright([
        [],
        [cookie("session:a", "stale")],
        [cookie("session:a", "good"), cookie("loggedIn", "1")],
    ])
    result = login.login(login_args(fake_linear, cookie_file, tmp_path), playwright=pw)
    assert result["status"] == "refreshed"
    assert result["cookie_names"] == ["loggedIn", "session:a"]
    assert "good" not in json.dumps(result)  # cookie values are never reported
    assert cookie_file.read_text() == "loggedIn=1; session:a=good"
    assert stat.S_IMODE(cookie_file.stat().st_mode) == 0o600
    assert pw.opened["headless"] is False and pw.opened["browser"] == "chrome"
    assert pw.opened["profile_dir"] == tmp_path / "profile"
    assert pw.closed >= 2  # stale-session cleanup, then closing the sign-in window
    assert login.login_lock_holder() is None


def test_login_busy_when_another_sign_in_runs(fake_linear, tmp_path):
    (server.state_dir() / "login.lock").write_text(str(os.getppid()))
    pw = FakePlaywright([[]])
    result = login.login(login_args(fake_linear, tmp_path / "c", tmp_path, "--force"), playwright=pw)
    assert result == {"cookie_file": str(tmp_path / "c"), "status": "busy", "pid": os.getppid()}
    assert pw.opened is None


def test_stale_lock_is_reclaimed(fake_linear, tmp_path):
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    (server.state_dir() / "login.lock").write_text(str(dead.pid))
    pw = FakePlaywright([[cookie("session:a", "good")]])
    result = login.login(login_args(fake_linear, tmp_path / "c", tmp_path), playwright=pw)
    assert result["status"] == "refreshed"


def test_login_aborts_when_window_closed(fake_linear, tmp_path):
    pw = FakePlaywright([RuntimeError("browser closed")], open_after_failure=False)
    result = login.login(login_args(fake_linear, tmp_path / "c", tmp_path), playwright=pw)
    assert result["status"] == "aborted"
    assert login.login_lock_holder() is None


def test_login_times_out(fake_linear, tmp_path):
    pw = FakePlaywright([[cookie("loggedIn", "1")]])
    result = login.login(
        login_args(fake_linear, tmp_path / "c", tmp_path, "--timeout", "0.05"),
        playwright=pw,
        sleep=lambda _: None,
    )
    assert result["status"] == "timeout"
    assert not (tmp_path / "c").exists()


def test_login_main_exit_code_and_json(fake_linear, tmp_path, capsys):
    code = login.login_main(
        ["--endpoint", fake_linear["endpoint"], "--cookie-file", str(tmp_path / "c"), "--check"]
    )
    assert code == 2
    assert json.loads(capsys.readouterr().out)["status"] == "missing"


def test_server_main_dispatches_login(fake_linear, tmp_path, capsys):
    with pytest.raises(SystemExit) as excinfo:
        server.main(["login", "--endpoint", fake_linear["endpoint"],
                     "--cookie-file", str(tmp_path / "c"), "--check"])
    assert excinfo.value.code == 2


@pytest.mark.skipif(
    os.environ.get("LINEAR_EXTRA_E2E") != "1" or not shutil.which("playwright-cli"),
    reason="set LINEAR_EXTRA_E2E=1 with playwright-cli installed to drive a real browser",
)
def test_e2e_real_browser_captures_httponly_cookie(fake_linear, tmp_path):
    session = f"lxt{uuid.uuid4().hex[:4]}"  # short: socket path limit
    cookie_file = tmp_path / "linear.cookie"
    args = login.parse_login_args(
        ["--endpoint", fake_linear["endpoint"], "--login-url", f"{fake_linear['base']}/login",
         "--cookie-file", str(cookie_file), "--profile-dir", str(tmp_path / "profile"),
         "--session", session, "--headless", "--timeout", "90",
         "--poll-interval", "0.5", "--validate-interval", "0.5"]
    )
    result = login.login(args)
    assert result["status"] == "refreshed", result
    assert cookie_file.read_text() == "loggedIn=1; session:a=good"
    listed = json.loads(subprocess.run(["playwright-cli", "list", "--json"], capture_output=True,
                                       text=True, check=True).stdout)
    assert not any(b.get("name") == session and b.get("status") == "open" for b in listed["browsers"])
