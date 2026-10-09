#!/usr/bin/env python3
"""Real Pi Ctrl-Space acceptance, isolated state and fake audio/provider.
Usage: python3 scripts/ptt-shortcut-pty.py [--pi /path/to/pi] [--out /tmp/evidence]
"""
import argparse
import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import socket
import struct
import subprocess
import tempfile
import termios
import time

repo = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--pi', default=os.environ.get('PI_BIN') or shutil.which('pi'))
parser.add_argument('--out')
args = parser.parse_args()
if not args.pi:
    parser.error('pi must be available')
out = pathlib.Path(args.out or tempfile.mkdtemp(prefix='ptt-shortcut-evidence-', dir='/tmp')).resolve()
out.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='ptt-shortcut-qa-', dir='/tmp') as folder:
    root = pathlib.Path(folder).resolve()
    config = root / 'config'
    config.mkdir()
    settings = {'packages': [], 'defaultProjectTrust': 'no', 'agentUtils': {'stt': {'model': 'fixture-model', 'shortcutsEnabled': True}}}
    (config / 'settings.json').write_text(json.dumps(settings))
    endpoint = str(root / 'qa.sock')
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    env = {k: os.environ[k] for k in ['PATH', 'TMPDIR', 'LANG'] if k in os.environ}
    env.update(HOME=str(root), TERM='xterm-256color', COLORTERM='truecolor', PI_OFFLINE='1', PI_TELEMETRY='0', DISABLE_PI_CACO='1', PI_DISABLE_AHP='1', PI_CODING_AGENT_DIR=str(config), PI_AGENT_UTILS_STATE_DIR=str(root / 'state'), PTT_QA_SOCKET=endpoint)
    child = subprocess.Popen([args.pi, '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--tui-mode', 'regular', '-e', str(repo / 'test/fixtures/ptt-shortcut-extension.js')], cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    transcript = bytearray()

    def drain(delay=.03):
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
                    raise AssertionError('unbounded terminal output')

    def call(action='snapshot'):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2)
            client.connect(endpoint)
            client.sendall((json.dumps({'action': action}) + '\n').encode())
            data = bytearray()
            deadline = time.monotonic() + 5
            while b'\n' not in data:
                ready = select.select([client, master], [], [], max(0, deadline - time.monotonic()))[0]
                if not ready:
                    raise TimeoutError('fixture response timeout')
                if master in ready:
                    transcript.extend(os.read(master, 65536))
                if client in ready:
                    piece = client.recv(65536)
                    if not piece:
                        break
                    data.extend(piece)
                if len(data) > 100000 or len(transcript) > 4 * 1024 * 1024:
                    raise AssertionError('unbounded fixture response/output')
            result = json.loads(data)
            assert 'error' not in result, result
            return result

    def wait(predicate, timeout=20):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            drain()
            if child.poll() is not None:
                raise AssertionError('Pi exited: ' + transcript[-5000:].decode(errors='replace'))
            try:
                last = call()
                if predicate(last):
                    return last
            except (FileNotFoundError, ConnectionRefusedError):
                pass
        raise AssertionError('state timeout: ' + str(last) + '\n' + transcript[-5000:].decode(errors='replace'))

    def key(data):
        os.write(master, data.encode())
        drain(.08)

    try:
        state = wait(lambda s: s['ready'])
        assert state['shortcuts'] == ['ctrl+space'], state
        assert state['captures'] == 0
        # Pi itself may persist startup migration/changelog metadata; compare
        # its speech/provider selections, not unrelated first-run bookkeeping.
        settings_before = json.loads((config / 'settings.json').read_text())
        key(' ')
        assert call()['captures'] == 0, 'plain Space must not start capture'
        call('clear')
        call('modal')
        wait(lambda s: s['modal'])
        key('\x00')
        assert call()['captures'] == 0, 'a modal owns Ctrl-Space, not the editor shortcut'
        key('\x1b')
        wait(lambda s: not s['modal'])
        key('\x00')
        wait(lambda s: s['active'] == 1 and s['captures'] == 1)
        (out / 'ptt-recording.ansi').write_bytes(transcript)
        call('modal')
        wait(lambda s: s['modal'])
        key('\x00')
        key('\r')
        assert call()['active'] == 1, 'dialog input must not finish active PTT'
        key('\x1b')
        wait(lambda s: not s['modal'])
        key('\x1b[32;5:2u')
        key('\x1b[32;5:3u')
        assert call()['active'] == 1, 'repeat/release cannot finish PTT'
        key('\x00')
        wait(lambda s: s['active'] == 0 and len(s['sent']) == 1)
        key('\x1b[32;5u')
        wait(lambda s: s['active'] == 1 and s['captures'] == 2)
        key('\x1b[32;5u')
        wait(lambda s: s['active'] == 0 and len(s['sent']) == 2)
        key('\x00')
        wait(lambda s: s['active'] == 1)
        key('\x1b')
        wait(lambda s: s['active'] == 0 and s['editor'] == 'fixture PTT transcript')
        assert len(call()['sent']) == 2, 'Escape must not send'
        call('clear')
        key('\x00')
        wait(lambda s: s['active'] == 1)
        key('\x03')
        state = wait(lambda s: s['active'] == 0)
        assert len(state['sent']) == 2, 'Ctrl-C must not send'
        settings_after = json.loads((config / 'settings.json').read_text())
        for field in ['agentUtils', 'defaultModel', 'defaultProvider']:
            assert settings_after.get(field) == settings_before.get(field), f'provider setting {field} changed'
        key('\x04')
        deadline = time.monotonic() + 8
        while child.poll() is None and time.monotonic() < deadline:
            drain()
        assert child.poll() == 0, 'Pi did not exit cleanly'
        assert not pathlib.Path(endpoint).exists(), 'QA socket leaked'
        try:
            assert termios.tcgetattr(slave) == original, 'terminal mode leaked'
        except termios.error as error:
            if error.args[0] != 25:
                raise
            assert all(code in transcript for code in [b'\x1b[?25h', b'\x1b[?2004l', b'\x1b[<u']), 'no terminal/keyboard restoration before hangup'
        receipt = {'ok': True, 'legacyAndKitty': True, 'modalIsolation': True, 'repeatReleaseIgnored': True, 'escapePreserves': True, 'ctrlCCancels': True, 'providerSettingsUnchanged': True, 'cleanup': True, 'state': state}
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2))
        print(json.dumps({'ok': True, 'evidence': str(out), 'cleanup': True}))
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
