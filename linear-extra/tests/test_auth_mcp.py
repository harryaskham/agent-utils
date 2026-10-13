"""Cross the real stdio MCP -> detached login -> SSH process -> HTTP validator boundary."""
import asyncio
import http.server
import json
import os
import sys
import threading
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def test_fresh_mcp_worker_imports_then_recovers_without_restart(tmp_path):
    viewer = {"id": "fixture-user", "email": "fixture@example.invalid", "name": "Fixture",
              "organization": {"id": "fixture-org", "urlKey": "fixture"},
              "issueDrafts": {"nodes": []}}
    calls = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            calls.append(self.headers.get("user"))
            valid = self.headers.get("cookie") == "session:a=fixture" and self.headers.get("user") == viewer["id"]
            payload = {"data": {"viewer": viewer}} if valid else {"errors": [{"message": "Authentication required"}]}
            body = json.dumps(payload).encode()
            self.send_response(200 if valid else 401)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    cookie = tmp_path / 'cookie'
    config = tmp_path / 'config.json'
    config.write_text(json.dumps({"authRemote": "fixture@source", "cookieFile": str(cookie)}))
    bundle = {"version": 1, "cookie": "session:a=fixture",
              "context": {"user_id": viewer["id"], "org_id": viewer["organization"]["id"]}}
    ssh = tmp_path / 'ssh'
    ssh.write_text(f'#!{sys.executable}\nimport sys\nassert "StrictHostKeyChecking=yes" in sys.argv\nsys.stdin.read()\nprint({json.dumps(bundle)!r})\n')
    ssh.chmod(0o700)
    env = dict(os.environ)
    for key in list(env):
        if key.startswith(('LINEAR_', 'PLAYWRIGHT_')) or key in ('DISPLAY', 'WAYLAND_DISPLAY'):
            env.pop(key)
    env.update(PATH=str(tmp_path), NO_PROXY='127.0.0.1,localhost', LINEAR_EXTRA_STATE_DIR=str(tmp_path / 'state'),
               LINEAR_EXTRA_SETTINGS=str(tmp_path / 'missing-settings.json'),
               LINEAR_EXTRA_AUTO_LOGIN='1')
    endpoint = f'http://127.0.0.1:{httpd.server_port}/graphql'

    async def exercise():
        params = StdioServerParameters(command=sys.executable, args=['-m', 'linear_extra_mcp',
            '--config', str(config), '--endpoint', endpoint], env=env)
        async with stdio_client(params) as (r, w), ClientSession(r, w) as session:
            await session.initialize()
            first = await session.call_tool('linear_draft_fetch', {})
            assert first.isError and 'session recovery' in first.content[0].text
            deadline = time.monotonic() + 12
            while not cookie.exists() and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            assert cookie.exists(), 'detached remote refresh did not finish'
            second = await session.call_tool('linear_draft_fetch', {})
            assert not second.isError
            assert json.loads(second.content[0].text)['count'] == 0
            assert (tmp_path / 'cookie.identity.json').exists()
            while (tmp_path / 'state/login.lock').exists() and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            assert not (tmp_path / 'state/login.lock').exists()
            assert not (tmp_path / 'state/browser-profile').exists()

    try:
        asyncio.run(exercise())
        assert calls and all(user == viewer['id'] for user in calls)
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)
