import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { run, quote } from '../extensions/lib/session-fork/io.js';
import { installSourcePeer } from './lib/session-fork-peer.js';

const pi = process.env.PI_SESSION_TEST_PI_BIN;
const herdr = process.env.PI_SESSION_TEST_HERDR_BIN;
const root = resolve(import.meta.dirname, '..');
// Opt-in: no operator socket/session/env is inherited, and only this test's
// named server is stopped. The native test does not send a model prompt.
test('SF-09/11: isolated real Herdr workspace, Pi startup, focus and retry without duplicate agent', { skip: !pi || !herdr, timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fork-herdr-live-'));
  const home = join(dir, 'home'); const bin = join(dir, 'bin'); const runtime = join(dir, 'runtime');
  await Promise.all([mkdir(home), mkdir(bin), mkdir(runtime, { mode: 0o700 })]);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'), XDG_RUNTIME_DIR: runtime, PI_CODING_AGENT_DIR: join(home, '.pi/agent'), PI_OFFLINE: '1', PI_DISABLE_AHP: '1', DISABLE_PI_CACO: '1', TERM: 'xterm-256color', SHELL: '/bin/sh', LANG: 'C.UTF-8' };
  await writeFile(join(bin, 'pi'), `#!/bin/sh\nexec ${quote(pi)} --offline --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes --no-context-files "$@"\n`);
  await chmod(join(bin, 'pi'), 0o700);
  // core invokes canonical herdr; route it to the reviewed binary.
  await writeFile(join(bin, 'herdr'), `#!/bin/sh\nexec ${quote(herdr)} "$@"\n`); await chmod(join(bin, 'herdr'), 0o700);
  const name = `fork-test-${process.pid}`;
  const server = spawn(herdr, ['--session', name, 'server'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = ''; server.stdout.on('data', b => { output = (output + b).slice(-12000); }); server.stderr.on('data', b => { output = (output + b).slice(-12000); });
  const exit = new Promise(resolve => server.on('exit', (code, signal) => resolve({ code, signal })));
  const command = (args, options = {}) => run(herdr, ['--session', name, ...args], { cwd: home, env, timeout: 10000, ...options });
  try {
    let ready = false;
    for (let n = 0; n < 60; n++) {
      const probe = await command(['workspace', 'list'], { allowFailure: true });
      if (!probe.code) { ready = true; break; }
      if (server.exitCode !== null) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, `isolated Herdr did not start: ${output}`);
    const source = join(dir, 'source.jsonl');
    await writeFile(source, [
      { type: 'session', version: 3, id: 'original', cwd: home, timestamp: '2026-10-15T00:00:00.000Z' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-10-15T00:00:01.000Z', message: { role: 'user', content: 'Synthetic fixture: do not run a model request', timestamp: 1 } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    const args = [join(root, 'scripts/pi-session.mjs'), 'fork', '--session', source, '--cwd', home, '--name', 'native-fork', '--request', 'herdr-live', '--herdr', '--herdr-session', name, '--focus', '--json'];
    const result = await run(process.execPath, args, { cwd: home, env, timeout: 60000, allowFailure: true });
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true, result.stdout + result.stderr);
    assert.equal(envelope.result.herdr.status, 'ready', result.stdout + output);
    const inspected = await command(['agent', 'get', envelope.result.herdr.agentName]);
    assert.equal(envelope.result.herdr.focused, true, result.stdout + output + inspected.stdout);
    const before = JSON.parse((await command(['agent', 'list'])).stdout).result.agents;
    const retry = JSON.parse((await run(process.execPath, [join(root, 'scripts/pi-session.mjs'), 'retry', 'herdr-live', '--json'], { cwd: home, env })).stdout);
    assert.equal(retry.result.sessionId, envelope.result.sessionId);
    const after = JSON.parse((await command(['agent', 'list'])).stdout).result.agents;
    assert.equal(after.length, before.length);
    assert.equal(after.find(a => a.name === envelope.result.herdr.agentName)?.pane_id, envelope.result.herdr.paneId);

    // Exercise Herdr's distinct worktree-open response and no-focus behavior.
    const repo = join(home, 'repo'); await mkdir(repo);
    const git = args => run('git', ['-C', repo, ...args], { cwd: home, env });
    await git(['init', '--quiet', '--initial-branch=main']);
    await writeFile(join(repo, 'a.txt'), 'fixture\n'); await git(['add', 'a.txt']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
    const gitSource = join(dir, 'git-source.jsonl');
    const rows = (await readFile(source, 'utf8')).trim().split('\n').map(JSON.parse); rows[0].cwd = repo;
    await writeFile(gitSource, rows.map(JSON.stringify).join('\n') + '\n');
    const worktree = JSON.parse((await run(process.execPath, [join(root, 'scripts/pi-session.mjs'), 'fork', '--session', gitSource, '--name', 'native-worktree', '--request', 'herdr-worktree', '--herdr', '--herdr-session', name, '--json'], { cwd: home, env, timeout: 60000 })).stdout);
    assert.equal(worktree.result.herdr.status, 'ready', JSON.stringify(worktree));
    assert.equal(worktree.result.destination.makeWorktree, true);
    assert.equal(worktree.result.herdr.focused, undefined);
    const focus = JSON.parse((await command(['agent', 'get', envelope.result.herdr.agentName])).stdout);
    assert.equal(focus.result.agent.focused, true, 'opening the worktree must not steal focus');

    const sourceHome = join(dir, 'remote-source'); await mkdir(sourceHome);
    const sourceRows = (await readFile(source, 'utf8')).trim().split('\n').map(JSON.parse); sourceRows[0].cwd = sourceHome;
    await writeFile(join(sourceHome, 'source.jsonl'), sourceRows.map(JSON.stringify).join('\n') + '\n');
    await installSourcePeer({ binDir: bin, sourceHome, env, log: join(dir, 'pull-ssh.jsonl') });
    const pulled = JSON.parse((await run(process.execPath, [join(root, 'scripts/pi-session.mjs'), 'pull', '--from', 'source-host', '--remote-command', join(root, 'scripts/pi-session.mjs'), '--session', '~/source.jsonl', '--cwd', home, '--name', 'native-pull', '--request', 'herdr-pull', '--herdr', '--herdr-session', name, '--focus', '--json'], { cwd: home, env, timeout: 60000 })).stdout);
    assert.equal(pulled.result.direction, 'pull'); assert.equal(pulled.result.herdr.status, 'ready'); assert.equal(pulled.result.herdr.focused, true);
    const pulledAgent = JSON.parse((await command(['agent', 'get', pulled.result.herdr.agentName])).stdout).result.agent;
    assert.equal(pulledAgent.pane_id, pulled.result.herdr.paneId); assert.equal(pulledAgent.focused, true);
    const replay = JSON.parse((await run(process.execPath, [join(root, 'scripts/pi-session.mjs'), 'retry', 'herdr-pull', '--json'], { cwd: home, env })).stdout);
    assert.equal(replay.result.herdr.paneId, pulled.result.herdr.paneId);
    assert.equal((await readFile(join(dir, 'pull-ssh.jsonl'), 'utf8')).trim().split('\n').length, 1, 'completed pull/Herdr retry must not reconnect to source');
  } finally {
    await command(['server', 'stop'], { allowFailure: true }).catch(() => {});
    const timer = setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} }, 5000);
    await exit; clearTimeout(timer);
    await rm(dir, { recursive: true, force: true });
  }
});
