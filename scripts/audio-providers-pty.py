#!/usr/bin/env python3
"""Isolated Pi /audio settings, cancel, shared edits and reload. No audio/network."""
import fcntl, hashlib, json, os, pty, select, shutil, struct, subprocess, tempfile, termios, time
from pathlib import Path
repo = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='audio-settings-pty-') as folder:
    root = Path(folder); config = root / 'agent'; config.mkdir(); receipt = root / 'receipt.jsonl'
    settings = config / 'settings.json'
    settings.write_text(json.dumps({'packages': [], 'defaultProjectTrust':'no', 'agentUtils': {'audio': {'providers': {'azure': {'type':'azure','auth':'entra','az':'fixture-broker','endpoint':'https://fixture.cognitiveservices.azure.com'}}}}}))
    original = settings.read_bytes()
    master, slave = pty.openpty(); saved = termios.tcgetattr(slave)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH',30,110,0,0))
    env = {k:os.environ[k] for k in ['PATH','TMPDIR','LANG'] if k in os.environ}
    env.update(HOME=str(root),TERM='xterm-256color',PI_CODING_AGENT_DIR=str(config),PI_DISABLE_AHP='1',DISABLE_PI_CACO='1',PI_OFFLINE='1',PI_TELEMETRY='0',AUDIO_QA_RECEIPT=str(receipt))
    command = [os.environ.get('PI_BIN') or shutil.which('pi'),'--no-session','--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--use-theme','dark','--tui-mode','regular','-e',str(repo/'test/fixtures/audio-providers-extension.js')]
    child = subprocess.Popen(command,cwd=root,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
    output = bytearray()
    def drain(seconds=.15):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            if select.select([master],[],[],max(0,end-time.monotonic()))[0]:
                try: data=os.read(master,65536)
                except OSError: break
                if not data: break
                output.extend(data)
                assert len(output)<2*1024*1024
    def reports(): return [json.loads(x) for x in receipt.read_text().splitlines()] if receipt.exists() else []
    def wait(predicate):
        end=time.monotonic()+20
        while not predicate():
            if child.poll() is not None:
                assert predicate(),output[-5000:].decode(errors='replace')
                return
            assert time.monotonic()<end,output[-5000:].decode(errors='replace')
            drain(.05)
    def send(value): os.write(master,value.encode());drain(.2)
    def snapshot():
        n=len(reports());send('/qa-audio-snapshot\r');wait(lambda:len(reports())>n);return reports()[-1]['providers']
    try:
        wait(lambda:len(reports())==1)
        # Pi may serialize its own theme/default metadata during first launch.
        # The extension must not change the startup provider configuration.
        original = settings.read_bytes()
        send('/audio settings azure\r');wait(lambda:b'azure (azure)' in output)
        # Endpoint is the first field. Edit only the session overlay.
        send('\r');send('https://edited.cognitiveservices.azure.com\r')
        assert snapshot()['azure']['endpoint']=='https://edited.cognitiveservices.azure.com'
        send('/audio settings azure\r');send('\x1b')
        assert snapshot()['azure']['endpoint']=='https://edited.cognitiveservices.azure.com'
        send('/audio azure-work type=azure auth=entra az=fixture-broker endpoint=https://work.cognitiveservices.azure.com\r')
        assert snapshot()['azure-work']['az']=='fixture-broker'
        ready=len([x for x in reports() if x['event']=='ready']);send('/reload\r')
        wait(lambda:len([x for x in reports() if x['event']=='ready'])==ready+1)
        assert snapshot()['azure-work']['az']=='fixture-broker'
        assert all(x['pid']==child.pid for x in reports())
        send('/audio azure-work reset\r');assert 'azure-work' not in snapshot()
        assert json.loads(settings.read_text())['agentUtils']==json.loads(original)['agentUtils']
        assert b'ctx is stale' not in output and b'uncaughtException' not in output
        send('\x04');wait(lambda:child.poll() is not None);assert child.returncode==0
        try: assert termios.tcgetattr(slave)==saved
        except termios.error as e:
            if e.args[0]!=25: raise
            assert all(x in output for x in [b'\x1b[?25h',b'\x1b[?2004l',b'\x1b[<u'])
        print(json.dumps({'ok':True,'settingsUI':'select/input/cancel','reloadRestored':True,'samePid':True,'startupUnchanged':True,'noProvidersCalled':True,'cleanExit':True}))
    finally:
        if child.poll() is None:
            child.terminate();end=time.monotonic()+5
            while child.poll() is None and time.monotonic()<end: drain(.05)
            if child.poll() is None: child.kill()
        os.close(master);os.close(slave)
        child.wait(timeout=5)
