#!/usr/bin/env python3
"""Real Pi PTY acceptance: isolated HOME, no model/audio/controller access.
Usage: choice-ui-pty.py --pi /path/to/pi --fixture fixture.json --out /tmp/evidence
"""
import argparse, faulthandler, fcntl, json, os, pathlib, pty, select, shutil, signal, socket, struct, subprocess, tempfile, termios, time
faulthandler.dump_traceback_later(30, repeat=True)

repo = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--pi', default=os.environ.get('PI_BIN') or shutil.which('pi'))
parser.add_argument('--fixture', default=str(repo / 'test/fixtures/choice-ui.json'))
parser.add_argument('--out', default=None)
parser.add_argument('--theme', default='dark')
parser.add_argument('--tui-mode', default='fullscreen', choices=['fullscreen', 'regular'])
args = parser.parse_args()
if not args.pi: parser.error('Pi must be installed, or supply --pi /path/to/pi')
out = pathlib.Path(args.out or tempfile.mkdtemp(prefix='choice-ui-evidence-', dir='/tmp')).resolve(); out.mkdir(parents=True, exist_ok=True)

with tempfile.TemporaryDirectory(prefix='choice-pty-', dir='/tmp') as folder:
    root = pathlib.Path(folder); config = root / 'config'; config.mkdir()
    (config / 'settings.json').write_text(json.dumps({'packages': [], 'defaultProjectTrust': 'no', 'theme': args.theme}))
    master, slave = pty.openpty(); original_termios = termios.tcgetattr(slave)
    def resize(cols, rows): fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    resize(80, 30)
    endpoint = str(root / 'qa.sock')
    env = {k: os.environ[k] for k in ['PATH', 'TMPDIR', 'LANG'] if k in os.environ}
    env.update(HOME=folder, TERM='xterm-256color', COLORTERM='truecolor', PI_OFFLINE='1', PI_TELEMETRY='0', DISABLE_PI_CACO='1', PI_DISABLE_AHP='1', PI_CODING_AGENT_DIR=str(config), PI_AGENT_UTILS_STATE_DIR=str(root / 'state'), CHOICE_QA_SOCKET=endpoint, CHOICE_QA_FIXTURE=str(pathlib.Path(args.fixture).resolve()))
    child = subprocess.Popen([args.pi, '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--use-theme', args.theme, '--tui-mode', args.tui_mode, '-e', str(repo / 'test/fixtures/choice-ui-extension.js')], cwd=folder, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    print(json.dumps({'stage':'started', 'pid':child.pid, 'root':folder}), flush=True)
    transcript = bytearray(); captures = []
    def drain(delay=0.03):
        deadline = time.monotonic() + delay
        while time.monotonic() < deadline:
            if select.select([master], [], [], max(0, deadline - time.monotonic()))[0]:
                try: data = os.read(master, 65536)
                except OSError: break
                if not data: break
                transcript.extend(data)
                if len(transcript) > 4 * 1024 * 1024: raise AssertionError('unbounded terminal output')
    def call(action):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2); client.connect(endpoint)
            client.sendall((json.dumps({'id':'qa', 'action':action})+'\n').encode())
            data = bytearray(); deadline = time.monotonic() + 5
            while b'\n' not in data:
                ready = select.select([client, master], [], [], max(0, deadline-time.monotonic()))[0]
                if not ready: raise TimeoutError('QA response timeout')
                # A TTY writer may block on its small kernel buffer. Drain it
                # while awaiting control replies instead of deadlocking the UI.
                if master in ready:
                    transcript.extend(os.read(master, 65536))
                if client in ready:
                    piece = client.recv(65536)
                    if not piece: break
                    data.extend(piece)
                if len(data) > 200000: raise AssertionError('unbounded snapshot')
            value = json.loads(data); assert 'error' not in value, value
            return value
    def wait(predicate, timeout=20):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            drain()
            if child.poll() is not None: raise AssertionError('Pi exited: '+transcript[-6000:].decode(errors='replace'))
            try:
                last = call('snapshot')
                if predicate(last): return last
            except (FileNotFoundError, ConnectionRefusedError): pass
        raise AssertionError('state timeout: '+str(last)+'\n'+transcript[-6000:].decode(errors='replace'))
    def key(data): os.write(master, data.encode()); drain()
    def capture(name, state):
        drain(.12)
        (out / (name+'.ansi')).write_bytes(transcript)
        (out / (name+'.json')).write_text(json.dumps(state, indent=2))
        captures.append({'name':name, 'columns':state['frame']['columns'], 'rows':state['frame']['rows']})
    try:
        wait(lambda s: True); call('open')
        state = wait(lambda s: s.get('frame') and s['frame'].get('view',{}).get('layout') is not None)
        assert state['frame']['view']['expanded']
        assert not state['frame']['view']['fullscreen']
        assert state['frame']['view']['layout']['rowOffset'] == 15
        assert len(state['frame']['lines']) == 15
        capture('bottom-80x30', state)
        key('f'); state = wait(lambda s: s['frame']['view']['fullscreen'])
        assert state['frame']['view']['layout']['rowOffset'] == 0
        capture('fullscreen-80x30', state)
        key('f'); state = wait(lambda s: not s['frame']['view']['fullscreen'])
        # Dedicated question scrolling must not move the selected option.
        key('\x1b[6;2~'); state = wait(lambda s: s['frame']['view']['layout']['question']['offset'] > 0)
        assert state['frame']['view']['layout']['index'] == 0
        capture('question-scrolled-80x30', state)
        key('\x1b[B'); state = wait(lambda s: s['frame']['view']['layout']['index'] == 1)
        key('\x1b[6~'); state = wait(lambda s: s['frame']['view']['layout']['blocks'][1]['offset'] > 0)
        assert state['frame']['view']['layout']['index'] == 1
        capture('description-scrolled-80x30', state)
        key('v'); state = wait(lambda s: not s['frame']['view']['expanded']); capture('compact-80x30', state)
        key('q'); wait(lambda s: not s['pending'])
        call('open'); state = wait(lambda s: s.get('frame') and s['pending'] and not s['frame']['view']['expanded'])
        key('v'); wait(lambda s: s['frame']['view']['expanded'])
        resize(40, 20); os.kill(child.pid, signal.SIGWINCH)
        state = wait(lambda s: s.get('frame') and s['frame']['columns']==40 and s['frame']['rows']==20)
        capture('expanded-40x20', state)
        # Mouse wheel over prompt: selection and list position stay put.
        layout = state['frame']['view']['layout']; row = layout.get('rowOffset', 0) + layout['question']['top'] + 1
        key(f'\x1b[<65;10;{row}M')
        state = wait(lambda s: s['frame']['view']['layout']['question']['offset'] > 0)
        assert state['frame']['view']['layout']['index'] == 0
        resize(40, 10); os.kill(child.pid, signal.SIGWINCH)
        state = wait(lambda s: s.get('frame') and s['frame']['rows']==10); capture('expanded-40x10', state)
        key('i'); key('view toggle stays text');
        state = wait(lambda s: any('Reply:' in line for line in s['frame']['lines']))
        key('\x1b'); wait(lambda s: not any('Reply:' in line for line in s['frame']['lines']))
        key('2'); state = wait(lambda s: not s['pending'])
        assert state['result']['status']=='selected' and state['result']['index']==1
        key('\x04')
        deadline=time.monotonic()+8
        while child.poll() is None and time.monotonic()<deadline: drain()
        assert child.poll() == 0, 'Pi did not shut down cleanly'
        assert not pathlib.Path(endpoint).exists(), 'QA socket leaked'
        try: assert termios.tcgetattr(slave)==original_termios, 'PTY mode not restored'
        except termios.error as error:
            # Darwin can detach the slave when its controlling session exits.
            if error.args[0] != 25: raise
            assert (args.tui_mode == 'regular' and b'\x1b[?1006r' in transcript) or (b'\x1b[?1049l' in transcript and b'\x1b[?1006l' in transcript), 'terminal modes not restored before hangup'
        assert json.loads((root / 'state/choice/ui.json').read_text()) == {'version':1, 'expanded':True, 'fullscreen':False}
        (out / 'manifest.json').write_text(json.dumps({'version':1, 'theme':args.theme, 'captures':captures, 'cleanup':True}, indent=2))
        print(json.dumps({'ok':True,'captures':len(captures),'out':str(out),'cleanup':True}))
    finally:
        (out / 'terminal-tail.log').write_bytes(transcript[-16000:])
        if child.poll() is None:
            child.terminate()
            deadline = time.monotonic() + 5
            while child.poll() is None and time.monotonic() < deadline: drain()
            if child.poll() is None:
                child.kill(); deadline = time.monotonic() + 5
                while child.poll() is None and time.monotonic() < deadline: drain()
                if child.poll() is None: print(f'Owned QA child {child.pid} did not reap after SIGKILL', flush=True)
        os.close(master); os.close(slave)
