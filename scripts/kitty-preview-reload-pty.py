#!/usr/bin/env python3
"""Repeated real /reload with owned preview images, in a private Pi PTY.
No live sessions, model/audio/provider calls, graphics captures or remote hosts.
Use --extension-entry to demonstrate the pre-fix crash in an isolated process.
"""
import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

repo = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--pi', default=os.environ.get('PI_BIN') or shutil.which('pi'))
parser.add_argument('--extension-entry', default=str(repo / 'extensions/kitty-image-preview.js'))
parser.add_argument('--placement', default='aboveEditor', choices=['aboveEditor', 'belowEditor', 'rightOverlay'])
parser.add_argument('--reloads', type=int, default=5)
parser.add_argument('--out')
args = parser.parse_args()
if not args.pi or not 1 <= args.reloads <= 20:
    parser.error('pi is required; --reloads must be 1–20')
out = Path(args.out or tempfile.mkdtemp(prefix='kitty-reload-evidence-', dir='/tmp')).resolve()
out.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='kitty-reload-pty-', dir='/tmp') as folder:
    root = Path(folder).resolve()
    config = root / 'config'
    config.mkdir()
    (config / 'settings.json').write_text(json.dumps({'packages': [], 'defaultProjectTrust': 'no'}))
    image = root / 'fixture.png'
    ready_file = root / 'ready.jsonl'
    image.write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lDL+WQAAAABJRU5ErkJggg=='))
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    env = {k: os.environ[k] for k in ['PATH', 'TMPDIR', 'LANG'] if k in os.environ}
    env.update(HOME=str(root), TERM='xterm-256color', COLORTERM='truecolor', PI_OFFLINE='1', PI_TELEMETRY='0', DISABLE_PI_CACO='1', PI_DISABLE_AHP='1', PI_INCOGNITO='1', PI_CODING_AGENT_DIR=str(config), PI_AGENT_UTILS_STATE_DIR=str(root / 'state'), KITTY_PREVIEW_QA_FIXTURE=str(image), KITTY_PREVIEW_QA_ENTRY=str(Path(args.extension_entry).resolve()), KITTY_PREVIEW_QA_PLACEMENT=args.placement, KITTY_PREVIEW_QA_RECEIPT=str(ready_file))
    child = subprocess.Popen([args.pi, '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--use-theme', 'dark', '--tui-mode', 'regular', '-e', str(repo / 'test/fixtures/kitty-preview-reload-extension.js')], cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    transcript = bytearray()

    def drain(delay=.05):
        deadline = time.monotonic() + delay
        while time.monotonic() < deadline:
            if select.select([master], [], [], max(0, deadline - time.monotonic()))[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                transcript.extend(data)
                if len(transcript) > 4 * 1024 * 1024:
                    raise AssertionError('terminal output exceeded 4 MiB')

    def wait_ready(sequence):
        deadline = time.monotonic() + 30
        while True:
            reports = ready_file.read_text().splitlines() if ready_file.exists() else []
            if len(reports) >= sequence:
                assert json.loads(reports[-1])['pid'] == child.pid, 'Pi process identity changed'
                break
            drain()
            if child.poll() is not None:
                raise AssertionError('Pi exited during reload: ' + transcript[-6000:].decode(errors='replace'))
            if time.monotonic() > deadline:
                raise AssertionError('ready timeout: ' + transcript[-6000:].decode(errors='replace'))
        # The reported crash fired 100 ms after the ready/shutdown boundary.
        drain(.35)
        if child.poll() is not None:
            raise AssertionError('Pi exited after reload: ' + transcript[-6000:].decode(errors='replace'))

    try:
        wait_ready(1)
        for i in range(args.reloads):
            os.write(master, b'/reload\r')
            wait_ready(i + 2)
        assert b'uncaughtException' not in transcript and b'This extension ctx is stale' not in transcript
        assert b'd=I' in transcript, 'owned image free was not written during shutdown'
        os.write(master, b'\x04')
        deadline = time.monotonic() + 8
        while child.poll() is None and time.monotonic() < deadline:
            drain()
        drain(.1)
        assert child.poll() == 0, 'Pi did not exit cleanly'
        try:
            assert termios.tcgetattr(slave) == original, 'PTY mode leaked'
        except termios.error as error:
            if error.args[0] != 25:
                raise
            assert all(code in transcript for code in [b'\x1b[?25h', b'\x1b[?2004l', b'\x1b[<u']), 'no terminal/keyboard restoration before hangup'
        receipt = {'ok': True, 'reloads': args.reloads, 'placement': args.placement, 'sameProcessSurvived': True, 'ownedDataFreeWritten': True, 'cleanExit': True, 'privateState': True}
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2))
        print(json.dumps({**receipt, 'evidence': str(out)}))
    finally:
        (out / 'terminal-tail.ansi').write_bytes(transcript[-24000:])
        if child.poll() is None:
            child.terminate()
            deadline = time.monotonic() + 5
            while child.poll() is None and time.monotonic() < deadline:
                drain()
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
        os.close(master)
        os.close(slave)
