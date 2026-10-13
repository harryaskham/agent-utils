"""Shared Linear auth configuration and read-only credential import over SSH.

The authority host serves files/SOPS credentials, never runs a browser or recursively pulls.
Received credentials are validated against Linear before replacing local owner-only files.
Only `auth token --for-mcp` emits a key, to a pipe for the MCP adapter's secret-command API.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib import error, request

API_ENDPOINT = "https://api.linear.app/graphql"
VIEWER_QUERY = "query { viewer { id name email organization { id name urlKey } } }"
MAX_COOKIE = 65536
MAX_KEY = 4096


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward a Linear credential through an HTTP redirect.


def config_path(override=None):
    return Path(override or os.environ.get("LINEAR_AUTH_CONFIG") or
                Path(os.environ.get("XDG_CONFIG_HOME", "~/.config")).expanduser() /
                "linear/config.json").expanduser()


def load_settings(override=None):
    path = config_path(override)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            raise ValueError
        for key in ("authRemote", "cookieFile", "apiKeyFile", "remoteCookieFile", "remoteApiKeyFile",
                    "userId", "orgId", "accountId"):
            if key in data and data[key] is not None and not isinstance(data[key], str):
                raise ValueError
        return data
    except (ValueError, OSError) as exc:
        raise RuntimeError(f"Invalid Linear auth config: {path}") from exc


def apply_settings(args):
    args.auth_config = str(config_path(args.auth_config))
    settings = load_settings(args.auth_config)
    args.remote = None if args.local else (
        args.remote or os.environ.get("LINEAR_AUTH_REMOTE") or settings.get("authRemote")
    )
    for attr, env, key in (("cookie_file", "LINEAR_COOKIE_FILE", "cookieFile"),
                           ("user_id", "LINEAR_USER_ID", "userId"),
                           ("org_id", "LINEAR_ORG_ID", "orgId"),
                           ("account_id", "LINEAR_ACCOUNT_ID", "accountId")):
        setattr(args, attr, getattr(args, attr) or os.environ.get(env) or settings.get(key))
    return args


def api_key_path(settings):
    return Path(settings.get("apiKeyFile") or "~/.config/linear/api-key").expanduser()


def read_bounded(path, limit):
    with Path(path).expanduser().open("r") as fh:
        value = fh.read(limit + 1)
    if len(value) > limit:
        raise RuntimeError("Credential file exceeds size limit")
    return value.strip()


def write_private(path, value):
    # Resolve a valid managed link; don't replace the operator's symlink.
    path = Path(path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "w") as fh:
            os.fchmod(fh.fileno(), 0o600)
            fh.write(value)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def identity_path(path):
    return Path(str(Path(path).expanduser()) + ".identity.json")


def cookie_identity(path, cookie):
    if path is None:
        return {}
    try:
        data = json.loads(read_bounded(identity_path(path), 8192))
        if data.get("version") != 1 or data.get("sha256") != hashlib.sha256(cookie.encode()).hexdigest():
            return {}
        context = data["context"]
        return {k: context[k] for k in ("user_id", "org_id", "account_id")
                if isinstance(context.get(k), str) and context[k]}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError):
        return {}


def context_for(args, path=None, cookie=""):
    saved = cookie_identity(path, cookie)
    return {key: getattr(args, key, None) or os.environ.get("LINEAR_" + key.upper()) or saved.get(key)
            for key in ("user_id", "org_id", "account_id")}


def save_session(path, cookie, viewer):
    from .server import _parse_cookie_claims

    context = {"user_id": viewer["id"], "org_id": viewer["organization"]["id"],
               "account_id": _parse_cookie_claims(cookie).get("account_id")}
    data = {"version": 1, "sha256": hashlib.sha256(cookie.encode()).hexdigest(), "context": context}
    # Install hash-bound metadata first. Readers ignore it until the cookie matches.
    write_private(identity_path(path), json.dumps(data) + "\n")
    write_private(path, cookie)


def _valid_key(value):
    return (isinstance(value, str) and 0 < len(value) <= MAX_KEY
            and all(33 <= ord(c) < 127 for c in value) and value != "null")


def _sops_key():
    cmd = shutil.which("cltv-secret-get")
    if not cmd:
        return ""
    try:
        result = subprocess.run([cmd, "-s", ".keys.ms.linear"], stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=2)
        value = result.stdout.strip() if result.returncode == 0 else ""
        return value if _valid_key(value) else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def local_api_key(settings):
    value = os.environ.get("LINEAR_API_KEY", "").strip()
    if value:
        return value, "environment"
    value = _sops_key()
    if value:
        return value, "sops"
    try:
        return read_bounded(api_key_path(settings), MAX_KEY), "file"
    except FileNotFoundError:
        return "", "missing"


def validate_api_key(value, context=None):
    if not _valid_key(value):
        return "invalid", "No usable Linear API key"
    req = request.Request(API_ENDPOINT, data=json.dumps({"query": VIEWER_QUERY}).encode(),
                          headers={"Authorization": value, "Content-Type": "application/json"})
    try:
        with request.build_opener(NoRedirect).open(req, timeout=3) as response:
            data = json.loads(response.read(65536))
        viewer = (data.get("data") or {}).get("viewer") or {}
        if not viewer.get("id") or data.get("errors"):
            return "invalid", "Linear rejected the API credential"
        context = context or {}
        if context.get("user_id") and viewer["id"] != context["user_id"]:
            return "error", "API key belongs to a different user"
        if context.get("org_id") and (viewer.get("organization") or {}).get("id") != context["org_id"]:
            return "error", "API key belongs to a different workspace"
        return "valid", viewer
    except error.HTTPError as exc:
        return ("invalid" if exc.code == 401 else "error"), f"Linear API HTTP {exc.code}"
    except (OSError, ValueError, TypeError):
        return "error", "Could not validate the Linear API credential"


# Run over SSH stdin. Only this bounded, read-only export program runs on the authority host.
# It requires Python 3, not a new version of linear-extra or an interactive login shell.
REMOTE_EXPORT = r'''
import hashlib, json, os, pathlib, shutil, subprocess, sys
spec = json.loads(sys.argv[1])
def read(path, limit):
    p = pathlib.Path(path).expanduser()
    if not p.exists(): return ""
    with p.open() as f: text = f.read(limit + 1)
    if len(text) > limit: raise ValueError("oversized file")
    return text.strip()
try:
    cfgpath = pathlib.Path(os.environ.get("LINEAR_AUTH_CONFIG") or pathlib.Path(os.environ.get("XDG_CONFIG_HOME", "~/.config")).expanduser() / "linear/config.json").expanduser()
    cfg = json.loads(read(cfgpath, 16384) or "{}")
    out = {"version": 1}
    if "cookie" in spec["kinds"]:
        path = pathlib.Path(spec.get("cookieFile") or os.environ.get("LINEAR_COOKIE_FILE") or cfg.get("cookieFile") or "~/.pi/agent/linear-session.cookie").expanduser()
        cookie = os.environ.get("LINEAR_SESSION_COOKIE") or read(path, 65536)
        meta = json.loads(read(str(path) + ".identity.json", 8192) or "{}")
        context = meta.get("context", {}) if meta.get("sha256") == hashlib.sha256(cookie.encode()).hexdigest() else {}
        for key, setting in (("user_id", "userId"), ("org_id", "orgId"), ("account_id", "accountId")):
            context[key] = os.environ.get("LINEAR_" + key.upper()) or cfg.get(setting) or context.get(key)
        out.update(cookie=cookie, context=context)
    if "api" in spec["kinds"]:
        key = os.environ.get("LINEAR_API_KEY", "")
        if not key:
            cmd = shutil.which("cltv-secret-get") or str(pathlib.Path.home() / ".nix-profile/bin/cltv-secret-get")
            if pathlib.Path(cmd).exists():
                proc = subprocess.run([cmd, "-s", ".keys.ms.linear"], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=2)
                if proc.returncode == 0: key = proc.stdout.strip()
        if not key or key == "null": key = read(spec.get("apiKeyFile") or cfg.get("apiKeyFile") or "~/.config/linear/api-key", 4096)
        out["api_key"] = key
    print(json.dumps(out))
except Exception:
    print(json.dumps({"error": "Authority could not read the selected Linear credentials"}))
    sys.exit(1)
'''


def fetch_remote(remote, kinds, settings):
    if not isinstance(remote, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@:\[\]%-]*", remote):
        raise RuntimeError("Invalid SSH auth host; use a configured host alias or user@host")
    spec = {"kinds": kinds, "cookieFile": settings.get("remoteCookieFile"),
            "apiKeyFile": settings.get("remoteApiKeyFile")}
    command = "python3 - " + shlex.quote(json.dumps(spec))
    argv = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=3", "-o", "ForwardAgent=no", "--", remote, command]
    try:
        result = subprocess.run(argv, input=REMOTE_EXPORT, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("SSH auth import failed or timed out; check reachability and SSH key setup") from exc
    if result.returncode:
        # Never echo a remote command's output: it may contain credentials.
        raise RuntimeError("SSH auth import failed; check trusted host key, SSH access and source files")
    try:
        if len(result.stdout) > 100000:
            raise ValueError
        data = json.loads(result.stdout)
        if data.get("version") != 1 or data.get("error"):
            raise ValueError
        return data
    except (ValueError, AttributeError) as exc:
        raise RuntimeError("Invalid credential response from SSH auth host") from exc


def pull_cookie(args, context=None):
    from . import login, server

    target, shadowed = server.cookie_target_path(args)
    if shadowed:
        return {"status": "error", "detail": "A literal cookie overrides the file; remove that override before importing"}
    try:
        data = fetch_remote(args.remote, ["cookie"], load_settings(args.auth_config))
        cookie = data.get("cookie")
        if (not isinstance(cookie, str) or not cookie or len(cookie) > MAX_COOKIE
                or not all(32 <= ord(c) < 127 for c in cookie)):
            return {"status": "missing", "detail": "No usable cookie on auth host; refresh there with login --local"}
        incoming = data.get("context") or {}
        if not isinstance(incoming, dict) or any(v is not None and not isinstance(v, str) for v in incoming.values()):
            return {"status": "error", "detail": "Invalid identity context from auth host"}
        expected = {k: (context or {}).get(k) or incoming.get(k) for k in ("user_id", "org_id", "account_id")}
        status, info = login.validate_cookie(cookie, args.endpoint, args.client_version, **expected)
        if status != "valid":
            return {"status": status, "detail": "Auth-host cookie did not validate; refresh it there with login --local. Local cookie unchanged."}
        save_session(target, cookie, info)
        return {"status": "imported", "remote": args.remote, "cookie_file": str(target),
                "viewer": login._viewer_summary(info)}
    except (RuntimeError, OSError):
        return {"status": "error", "detail": "Cannot import Linear cookie; check SSH host/key access, source files and local file permissions"}


def sync_api(args, check=False, force=False):
    from . import login

    settings = load_settings(args.auth_config)
    key, source = local_api_key(settings)
    context = context_for(args)
    if key and not force:
        status, info = validate_api_key(key, context)
        if status == "valid":
            return {"status": "valid", "source": source, "viewer": login._viewer_summary(info)}
        if check or status == "error":
            return {"status": status, "detail": info}
        if source in {"environment", "sops"}:
            return {"status": "invalid", "detail": "Refresh the configured environment/SOPS API key; it overrides imported files"}
    if check or not args.remote:
        return {"status": "missing", "detail": "Configure LINEAR_API_KEY or an authRemote"}
    if source in {"environment", "sops"}:
        return {"status": "error", "detail": "Environment/SOPS key takes precedence; use --check or refresh that source"}
    data = fetch_remote(args.remote, ["api"], settings)
    key = data.get("api_key")
    status, info = validate_api_key(key, context)
    if status != "valid":
        return {"status": status, "detail": "Auth-host API key did not validate; local key unchanged"}
    write_private(api_key_path(settings), key)
    return {"status": "imported", "remote": args.remote, "viewer": login._viewer_summary(info)}


def auth_main(argv=None):
    from . import login, server

    parser = argparse.ArgumentParser(prog="linear-extra-mcp auth")
    parser.add_argument("action", choices=("status", "sync", "token"))
    server.add_common_args(parser)
    parser.add_argument("--only", choices=("api", "cookie", "both"), default="both")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--for-mcp", action="store_true", help="Allow token output to a non-terminal pipe for an MCP secret command")
    args = apply_settings(parser.parse_args(argv))
    try:
        if args.action == "token":
            if not args.for_mcp or sys.stdout.isatty():
                print("Token output is only for a piped MCP secret command (--for-mcp).", file=sys.stderr)
                return 2
            key, _ = local_api_key(load_settings(args.auth_config))
            if not key and args.remote:
                receipt = sync_api(args)
                if receipt["status"] != "imported":
                    raise RuntimeError("API credential unavailable; run auth sync")
                key, _ = local_api_key(load_settings(args.auth_config))
            if not _valid_key(key):
                raise RuntimeError("API credential unavailable; run auth sync")
            print(key)
            return 0
        receipts = {}
        if args.only in {"api", "both"}:
            receipts["api"] = sync_api(args, check=args.action == "status", force=args.force)
        if args.only in {"cookie", "both"}:
            login_args = login.parse_login_args(["--config", args.auth_config, "--check"])
            for key in ("remote", "cookie", "cookie_file", "settings", "account_id", "org_id", "user_id", "endpoint", "client_version"):
                setattr(login_args, key, getattr(args, key))
            receipts["cookie"] = login.login(login_args)
            if args.action == "sync" and (args.force or receipts["cookie"]["status"] in {"invalid", "missing"}) and args.remote:
                receipts["cookie"] = pull_cookie(args, context_for(args))
        print(json.dumps(receipts, indent=2))
        return 0 if all(r["status"] in {"valid", "imported"} for r in receipts.values()) else 2
    except (RuntimeError, OSError):
        print("Linear auth failed; check config, SSH access and local credentials. No secret output.", file=sys.stderr)
        return 1
