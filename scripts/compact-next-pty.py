#!/usr/bin/env python3
"""Offline real-TUI proof for /compact-next; owns a disposable PTY/config/session."""
import fcntl
import json
import os
import pty
import select
import signal
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
# npm prepends the pinned SDK's .bin; select the installed runtime, not that CLI.
host_path = os.pathsep.join(p for p in os.environ.get("PATH", "").split(os.pathsep) if "node_modules" not in p)
pi_bin = os.environ.get("PI_BIN") or shutil.which("pi", path=host_path)
if not pi_bin:
    raise RuntimeError("Pi host not found; set PI_BIN to a Pi 1.3.0+ executable")
with tempfile.TemporaryDirectory(prefix="compact-next-pty-") as temp:
    directory = Path(temp)
    agent = directory / "agent"
    agent.mkdir()
    (agent / "settings.json").write_text(json.dumps({
        "compaction": {"enabled": False, "keepRecentTokens": 0}, "packages": []
    }))
    trace = directory / "trace.jsonl"
    trace.write_text("")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 120, 0, 0))
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent),
               PI_CODING_AGENT_SESSION_DIR=str(directory / "sessions"), PI_OFFLINE="1",
               COMPACT_NEXT_TRACE=str(trace), COMPACT_NEXT_FINAL="0", TERM="xterm-256color")
    process = subprocess.Popen([
        pi_bin, "--no-session", "--no-extensions", "--no-skills",
        "--no-prompt-templates", "--no-themes", "-e", str(root / "test/fixtures/compact-next-runtime.js"),
        "--provider", "compact-next-fixture", "--model", "fixture", "Perform the offline fixture task."
    ], cwd=directory, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def events():
        return [json.loads(line) for line in trace.read_text().splitlines() if line]

    def wait(check, description):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], .02)
            if ready:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
            if check():
                return
        raise AssertionError(description + "\n" + output[-3000:].decode(errors="replace"))

    def send(text):
        os.write(master, text.encode() + b"\r")

    try:
        wait(lambda: any(e.get("event") == "tool-start" for e in events()), "tools start")
        send("/compact-next")
        wait(lambda: b"queued for the next safe boundary" in output, "command admitted without interruption")
        assert not any(e.get("event") == "summary" for e in events())
        send("/cn-release one")
        wait(lambda: any(e.get("event") == "tool-end" and e.get("name") == "one" for e in events()), "first tool finishes")
        assert not any(e.get("event") == "summary" for e in events())
        send("/cn-release two")
        wait(lambda: any(e.get("event") == "agent_settled" for e in events()), "run settles")
        rows = events()
        assert len([e for e in rows if e.get("event") == "agent_start"]) == 1
        assert len([e for e in rows if e.get("event") == "summary"]) == 1
        assert all(not e["aborted"] for e in rows if e.get("event") == "tool-end")
        assert len([e for e in rows if e.get("event") == "model"]) == 2
        if os.environ.get("PI_COMPACT_NEXT_PTY_LOG"):
            Path(os.environ["PI_COMPACT_NEXT_PTY_LOG"]).write_bytes(output)
        print(json.dumps({"ok": True, "surface": "Pi TUI via PTY", "dimensions": "120x35",
                          "toolsAborted": False, "summaries": 1, "agentRuns": 1, "modelRequests": 2}))
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        os.close(master)
