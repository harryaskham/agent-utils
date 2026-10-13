"""Remote authority config, transport, validation, persistence and MCP secret-command tests."""
import argparse
import hashlib
import json
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from linear_extra_mcp import auth, login, server

VIEWER = {"id": "user-1", "name": "Test User", "email": "test@example.invalid",
          "organization": {"id": "org-1", "urlKey": "test-org"}}
CONTEXT = {"user_id": "user-1", "org_id": "org-1", "account_id": None}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    for var in ("LINEAR_AUTH_REMOTE", "LINEAR_API_KEY", "LINEAR_SESSION_COOKIE", "LINEAR_COOKIE_FILE",
                "LINEAR_USER_ID", "LINEAR_ORG_ID", "LINEAR_ACCOUNT_ID", "LINEAR_EXTRA_SETTINGS",
                "PLAYWRIGHT_MCP_EXTENSION_TOKEN", "LINEAR_EXTRA_AUTO_LOGIN"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("LINEAR_AUTH_CONFIG", str(tmp_path / "config.json"))
    monkeypatch.setenv("LINEAR_EXTRA_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(server, "DEFAULT_SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(server, "DEFAULT_COOKIE_PATH", tmp_path / "session.cookie")
    monkeypatch.setattr(auth, "_sops_key", lambda: "")
    monkeypatch.setattr(auth, "api_key_path", lambda cfg: Path(cfg.get("apiKeyFile") or tmp_path / "api-key"))
    (tmp_path / "config.json").write_text(json.dumps({"authRemote": "user@source", "userId": "user-1"}))


def test_common_config_precedence(tmp_path, monkeypatch):
    assert server.parse_args([]).remote == "user@source"
    assert login.parse_login_args([]).user_id == "user-1"
    monkeypatch.setenv("LINEAR_AUTH_REMOTE", "user@env")
    assert login.parse_login_args([]).remote == "user@env"
    assert login.parse_login_args(["--remote", "user@flag"]).remote == "user@flag"
    assert login.parse_login_args(["--local"]).remote is None
    assert server.build_config(server.parse_args([])).auth_remote == "user@env"


def test_cookie_identity_is_hash_bound_and_preserves_symlinks(tmp_path):
    target = tmp_path / "private-cookie"
    target.write_text("old")
    link = tmp_path / "session.cookie"
    link.symlink_to(target)
    auth.save_session(link, "session:a=fresh", VIEWER)
    assert link.is_symlink() and target.read_text() == "session:a=fresh"
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert stat.S_IMODE(auth.identity_path(link).stat().st_mode) == 0o600
    assert auth.cookie_identity(link, "session:a=fresh")["user_id"] == "user-1"
    assert auth.cookie_identity(link, "session:a=other") == {}
    args = server.parse_args(["--cookie-file", str(link)])
    cfg = server.build_config(args)
    assert cfg.user_id == "user-1" and cfg.org_id == "org-1"


def test_live_server_learns_identity_after_import(tmp_path):
    # No hard-coded user/environment on a fresh worker.
    (tmp_path / "config.json").write_text('{"authRemote":"user@source"}')
    cfg = server.build_config(server.parse_args([]))
    assert not cfg.user_id
    auth.save_session(server.DEFAULT_COOKIE_PATH, "session:a=fresh", VIEWER)
    assert server._maybe_reload(cfg)
    assert cfg.user_id == "user-1" and cfg.org_id == "org-1"


def test_remote_login_imports_without_any_browser(monkeypatch):
    monkeypatch.setattr(auth, "fetch_remote", lambda *a: {"cookie": "session:a=imported", "context": CONTEXT})
    checks = []

    def validate(cookie, endpoint, version, **context):
        checks.append((cookie, context))
        return "valid", VIEWER

    monkeypatch.setattr(login, "validate_cookie", validate)
    monkeypatch.setattr(login, "PlaywrightCli", lambda *a: pytest.fail("worker must not construct a browser"))
    result = login.login(login.parse_login_args([]))
    assert result["status"] == "imported"
    assert checks == [("session:a=imported", CONTEXT)]
    assert server.DEFAULT_COOKIE_PATH.read_text() == "session:a=imported"
    assert login.login_lock_holder() is None


def test_valid_local_cookie_never_contacts_remote(monkeypatch):
    auth.save_session(server.DEFAULT_COOKIE_PATH, "session:a=good", VIEWER)
    monkeypatch.setattr(login, "validate_cookie", lambda *a, **k: ("valid", VIEWER))
    monkeypatch.setattr(auth, "fetch_remote", lambda *a: pytest.fail("local valid cookie should win"))
    assert login.login(login.parse_login_args([]))["status"] == "valid"


@pytest.mark.parametrize("status", ["invalid", "error"])
def test_rejected_remote_cookie_does_not_replace_local(status, monkeypatch):
    old = "session:a=old"
    server.DEFAULT_COOKIE_PATH.write_text(old)
    monkeypatch.setattr(auth, "fetch_remote", lambda *a: {"cookie": "session:a=bad", "context": CONTEXT})
    monkeypatch.setattr(login, "validate_cookie", lambda *a, **k: (status, "rejected"))
    result = login.login(login.parse_login_args(["--force"]))
    assert result["status"] == status
    assert server.DEFAULT_COOKIE_PATH.read_text() == old


def test_remote_cookie_respects_pinned_identity(monkeypatch):
    monkeypatch.setattr(auth, "fetch_remote", lambda *a: {"cookie": "session:a=other", "context": {"user_id": "wrong"}})

    def validate(*a, **context):
        assert context["user_id"] == "user-1"
        return "error", "wrong account"

    monkeypatch.setattr(login, "validate_cookie", validate)
    assert login.login(login.parse_login_args([]))["status"] == "error"
    assert not server.DEFAULT_COOKIE_PATH.exists()


def test_shadowed_cookie_is_not_overwritten(monkeypatch):
    monkeypatch.setenv("LINEAR_SESSION_COOKIE", "session:a=override")
    monkeypatch.setattr(auth, "fetch_remote", lambda *a: pytest.fail("must not fetch unused credential"))
    assert login.login(login.parse_login_args(["--force"]))["status"] == "error"


def test_auth_status_is_read_only(monkeypatch, capsys):
    monkeypatch.setattr(auth, "fetch_remote", lambda *a: pytest.fail("status must not transfer"))
    assert auth.auth_main(["status"]) == 2
    output = json.loads(capsys.readouterr().out)
    assert output["api"]["status"] == output["cookie"]["status"] == "missing"
    assert not server.DEFAULT_COOKIE_PATH.exists()


def test_api_remote_import_and_local_precedence(monkeypatch, tmp_path):
    args = server.parse_args([])
    key = "lin_api_fixture"
    monkeypatch.setattr(auth, "fetch_remote", lambda *a: {"api_key": key})
    monkeypatch.setattr(auth, "validate_api_key", lambda value, ctx: ("valid", VIEWER))
    assert auth.sync_api(args)["status"] == "imported"
    path = auth.api_key_path({})
    assert path.read_text() == key and stat.S_IMODE(path.stat().st_mode) == 0o600
    monkeypatch.setattr(auth, "fetch_remote", lambda *a: pytest.fail("must use local credential"))
    assert auth.sync_api(args)["source"] == "file"
    monkeypatch.setattr(auth, "_sops_key", lambda: "lin_api_sops")
    assert auth.local_api_key({}) == ("lin_api_sops", "sops")
    monkeypatch.setenv("LINEAR_API_KEY", "lin_api_env")
    assert auth.local_api_key({}) == ("lin_api_env", "environment")


def test_invalid_managed_api_key_does_not_get_shadow_copy(monkeypatch):
    monkeypatch.setenv("LINEAR_API_KEY", "lin_api_old")
    monkeypatch.setattr(auth, "validate_api_key", lambda *a: ("invalid", "expired"))
    monkeypatch.setattr(auth, "fetch_remote", lambda *a: pytest.fail("managed source still overrides file"))
    assert auth.sync_api(server.parse_args([]))["status"] == "invalid"
    assert not auth.api_key_path({}).exists()


def test_secret_command_only_emits_to_explicit_pipe(monkeypatch, capsys):
    monkeypatch.setenv("LINEAR_API_KEY", "lin_api_fixture_secret")
    assert auth.auth_main(["token"]) == 2
    assert "fixture_secret" not in capsys.readouterr().out
    monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
    assert auth.auth_main(["token", "--for-mcp"]) == 2
    assert "fixture_secret" not in capsys.readouterr().out
    monkeypatch.setattr(sys.stdout, "isatty", lambda: False)
    assert auth.auth_main(["token", "--for-mcp"]) == 0
    assert capsys.readouterr().out == "lin_api_fixture_secret\n"


def test_ssh_command_never_has_credentials_in_arguments(monkeypatch):
    calls = []

    def run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0, '{"version":1,"cookie":"session:a=secret"}', "")

    monkeypatch.setattr(auth.subprocess, "run", run)
    assert auth.fetch_remote("user@source", ["cookie"], {})["cookie"] == "session:a=secret"
    cmd, kw = calls[0]
    assert "StrictHostKeyChecking=yes" in cmd and "BatchMode=yes" in cmd and "ForwardAgent=no" in cmd
    assert cmd[-2] == "user@source" and "secret" not in str(cmd)
    assert kw["input"] == auth.REMOTE_EXPORT and kw["timeout"] <= 5
    for bad in ("-oProxyCommand=bad", "user@host;touch /tmp/oops", "host\ncommand"):
        with pytest.raises(RuntimeError):
            auth.fetch_remote(bad, ["cookie"], {})
    assert len(calls) == 1


@pytest.mark.parametrize("response,returncode", [("secret_key", 1), ("secret_key", 0), ('{"version":2}', 0)])
def test_transport_failure_never_echoes_payload(monkeypatch, response, returncode):
    monkeypatch.setattr(auth.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess([], returncode, response, "secret_key"))
    with pytest.raises(RuntimeError) as exc:
        auth.fetch_remote("user@source", ["api"], {})
    assert "secret_key" not in str(exc.value)


def test_real_remote_export_process_is_bounded_read_only(tmp_path):
    # Exercise the exact script shipped over SSH with an isolated home and disposable credentials.
    home = tmp_path / "authority"
    cookie_path = home / ".pi/agent/linear-session.cookie"
    key_path = home / ".config/linear/api-key"
    cfg_path = home / ".config/linear/config.json"
    auth.save_session(cookie_path, "session:a=fixture", VIEWER)
    auth.write_private(key_path, "lin_api_fixture")
    cfg_path.write_text('{"authRemote":"must-not-recurse"}')
    before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in home.rglob('*') if p.is_file()}
    env = {"HOME": str(home), "PATH": "/does-not-exist", "PLAYWRIGHT_MCP_EXTENSION_TOKEN": "never-export-me"}
    result = subprocess.run([sys.executable, "-c", auth.REMOTE_EXPORT, json.dumps({"kinds": ["cookie", "api"]})],
                            env=env, capture_output=True, text=True, timeout=10, check=True)
    data = json.loads(result.stdout)
    assert data["cookie"] == "session:a=fixture" and data["api_key"] == "lin_api_fixture"
    assert data["context"]["user_id"] == "user-1" and "never-export-me" not in result.stdout
    assert before == {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in home.rglob('*') if p.is_file()}
    assert data["version"] == 1


def test_headless_server_can_start_remote_recovery(monkeypatch):
    monkeypatch.setattr(server, "_display_available", lambda: False)
    monkeypatch.setattr(server, "_LOGIN_PROCS", [])
    calls = []

    class Proc:
        pid = 99
        def poll(self):
            return None

    monkeypatch.setattr(server.subprocess, "Popen", lambda cmd, **kw: calls.append(cmd) or Proc())
    cfg = server.build_config(server.parse_args([]))
    assert server.start_background_login(cfg)["status"] == "started"
    assert calls[0][calls[0].index("--remote") + 1] == "user@source"
    assert "--config" in calls[0] and "--local" not in calls[0]


def test_empty_lock_is_not_assumed_stale():
    lock = server.state_dir() / "login.lock"
    lock.write_text("")
    assert login.acquire_login_lock() == -1
    assert lock.exists() and lock.read_text() == ""


def test_same_cookie_can_load_new_identity_metadata():
    # Cookie bytes need not rotate when context is first captured.
    path = server.DEFAULT_COOKIE_PATH
    path.write_text("session:a=unchanged")
    args = server.parse_args([])
    args.user_id = None
    cfg = server.build_config(args)
    assert cfg.user_id is None
    auth.save_session(path, "session:a=unchanged", VIEWER)
    assert server._maybe_reload(cfg) and cfg.user_id == "user-1"


def test_bad_hash_cannot_override_expected_context():
    path = server.DEFAULT_COOKIE_PATH
    path.write_text("session:a=one")
    auth.write_private(auth.identity_path(path), json.dumps({"version": 1, "sha256": hashlib.sha256(b"other").hexdigest(), "context": {"user_id": "wrong"}}))
    assert auth.context_for(argparse.Namespace(), path, path.read_text())["user_id"] is None
