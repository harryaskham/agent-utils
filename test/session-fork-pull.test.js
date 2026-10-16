import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hash, run } from '../extensions/lib/session-fork/io.js';
import { parseSnapshot } from '../extensions/lib/session-fork/snapshot.js';
import { parseArgs } from '../extensions/lib/session-fork/args.js';
import { installSourcePeer } from './lib/session-fork-peer.js';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'scripts/pi-session.mjs');
const extension = join(root, 'extensions/session-fork.js');
const piBinary = process.env.PI_SESSION_TEST_PI_BIN;
async function fixture(t, { loseAction } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-pull-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'destination'); const sourceHome = join(dir, 'source'); const log = join(dir, 'ssh.jsonl'); const marker = join(dir, 'lose-reply');
  await mkdir(home); await mkdir(sourceHome);
  const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, '.pi/agent'), PI_OFFLINE: '1', PI_DISABLE_AHP: '1', DISABLE_PI_CACO: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', LANG: 'C.UTF-8' };
  if (loseAction) await writeFile(marker, '1');
  const shim = await installSourcePeer({ binDir: join(dir, 'bin'), sourceHome, env, log, loseAction, marker });
  const command = (cmd, args, options = {}) => run(cmd, args, { cwd: home, env, ...options });
  const invoke = async (...args) => {
    const result = await command(process.execPath, [cli, ...args, '--json'], { allowFailure: true });
    return { ...JSON.parse(result.stdout), code: result.code };
  };
  const sourceEnv = { ...env, HOME: sourceHome, PI_CODING_AGENT_DIR: join(sourceHome, '.pi/agent') };
  const callSource = async request => JSON.parse((await command(process.execPath, [cli, '_peer'], { cwd: sourceHome, env: sourceEnv, input: JSON.stringify(request), maxOutput: 16 * 1024 * 1024 })).stdout);
  const git = (cwd, ...args) => command('git', ['-C', cwd, ...args]);
  const session = async (cwd = sourceHome, large = false) => {
    const path = join(sourceHome, 'custom sessions', '2026_source-id.jsonl'); await mkdir(dirname(path), { recursive: true });
    const rows = [
      { type: 'session', version: 3, id: 'source-id', cwd, timestamp: '2026-10-15T00:00:00.000Z' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-10-15T00:00:01.000Z', message: { role: 'user', content: `Source at ${cwd}`, timestamp: 1 } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-15T00:00:02.000Z', message: { role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', content: [{ type: 'thinking', thinking: `Read ${cwd}/a.txt`, thinkingSignature: 'original-signature' }, { type: 'text', text: 'Done' }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 2 } },
    ];
    if (large) rows.push({ type: 'custom', id: 'image', parentId: 'a1', customType: 'test-image', data: { type: 'image', data: 'a'.repeat(2 * 1024 * 1024), mimeType: 'image/png' } });
    await writeFile(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return path;
  };
  const args = ['pull', '--from', 'source-host', '--session', 'source-id', '--source-session-dir', '~/custom sessions', '--remote-command', cli];
  const actions = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  return { dir, home, sourceHome, env, command, invoke, callSource, git, session, args, actions, shim };
}

test('SF-13: pull syntax is destination-side in CLI and Pi, with explicit source identity', () => {
  const cliArgs = parseArgs(['pull', '--from', 'node-a', '--session', 'source-id', '--cwd', '~/target']);
  assert.deepEqual(cliArgs, parseArgs('--from node-a --session source-id --cwd ~/target', { extension: true }));
  assert.deepEqual(cliArgs, parseArgs(['fork', '--from', 'node-a', '--session', 'source-id', '--cwd', '~/target']));
  assert.throws(() => parseArgs(['pull', '--session', 'id']), /--from/);
  assert.throws(() => parseArgs(['pull', '--from', 'node-a']), /--session/);
  assert.throws(() => parseArgs(['fork', '--from', 'node-a', '--session', 'id', '--remote', 'node-b']), /cannot be combined/);
  assert.throws(() => parseArgs('--session local-id', { extension: true }), /active session/);
});

test('SF-13/14: pull uses one-way SSH, source-local IDs, local HOME mapping, large immutable snapshots and frozen retries', async t => {
  const f = await fixture(t, { loseAction: 'snapshot' });
  const targetRepo = join(f.home, 'repo'); await mkdir(targetRepo);
  await f.git(targetRepo, 'init', '--quiet', '--initial-branch=main'); await writeFile(join(targetRepo, 'a.txt'), 'base\n');
  await f.git(targetRepo, 'add', 'a.txt'); await f.git(targetRepo, 'commit', '--quiet', '--no-gpg-sign', '-m', 'base');
  const sourceRepo = join(f.sourceHome, 'repo'); await f.command('git', ['clone', '--quiet', targetRepo, sourceRepo]);
  const linked = join(f.sourceHome, 'linked'); await f.git(sourceRepo, 'worktree', 'add', '-b', 'unpushed', linked);
  await writeFile(join(linked, 'a.txt'), 'captured source commit\n'); await f.git(linked, 'commit', '--quiet', '--no-gpg-sign', '-am', 'source only');
  const commit = (await f.git(linked, 'rev-parse', 'HEAD')).stdout.trim();
  const source = await f.session(linked, true); const before = await readFile(source);
  const sourceState = join(f.sourceHome, '.pi/agent/session-forks');
  const destinationState = join(f.home, '.pi/agent/session-forks');
  const plan = await f.invoke(...f.args, '--name', 'pulled', '--dry-run');
  assert.equal(plan.result?.status, 'planned', JSON.stringify(plan));
  assert.equal(plan.result.destination.repo, targetRepo);
  assert.ok(plan.result.destination.cwd.startsWith(f.home));
  await assert.rejects(() => stat(sourceState)); await assert.rejects(() => stat(destinationState));
  const first = await f.invoke(...f.args, '--name', 'pulled', '--request', 'pull-id');
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(first.error.details.requestId, 'pull-id');
  const pending = await f.invoke('status', 'pull-id');
  assert.equal(pending.result.status, 'pending'); assert.equal(pending.result.phase, 'preparing'); assert.equal(pending.result.direction, 'pull');
  const admitted = JSON.parse(await readFile(join(destinationState, 'outgoing/pull-id/initiation.json')));
  const remoteSaved = JSON.parse(await readFile(join(sourceState, 'exports/pull-id/manifest.json')));
  assert.equal(remoteSaved.metadata.sessionId, admitted.sessionId);
  assert.equal((await stat(join(sourceState, 'exports/pull-id/snapshot.jsonl'))).mode & 0o777, 0o600);
  await appendFile(source, JSON.stringify({ type: 'message', id: 'later', parentId: 'image', message: { role: 'user', content: 'Later source turn' } }) + '\n');
  await writeFile(join(linked, 'a.txt'), 'later source commit\n'); await f.git(linked, 'commit', '--quiet', '--no-gpg-sign', '-am', 'later');
  const sourceAfterAdvance = await readFile(source);
  const retry = await f.invoke('retry', 'pull-id');
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.result.sessionId, admitted.sessionId); assert.equal(retry.result.direction, 'pull');
  assert.equal(retry.result.resume.fromInitiator, retry.result.resume.onDestination);
  assert.equal(retry.result.resume.fromSource, undefined);
  assert.equal(retry.result.snapshotSha256, hash(before));
  assert.equal(retry.result.cwd, join(f.home, '.pi/worktrees/repo/pulled'));
  assert.equal(retry.result.destination.home, f.home);
  assert.equal(retry.result.origin.home, f.sourceHome);
  assert.equal((await f.git(retry.result.cwd, 'rev-parse', 'HEAD')).stdout.trim(), commit);
  assert.equal(await readFile(join(retry.result.cwd, 'a.txt'), 'utf8'), 'captured source commit\n');
  assert.deepEqual(await readFile(source), sourceAfterAdvance, 'pull must not mutate source history');
  const fork = await readFile(retry.result.sessionFile);
  assert.deepEqual(fork.subarray(fork.indexOf(10) + 1, fork.indexOf(10) + 1 + before.length - before.indexOf(10) - 1), before.subarray(before.indexOf(10) + 1));
  assert.equal(parseSnapshot(fork).entries.some(e => e.id === 'later'), false);
  assert.equal(parseSnapshot(fork).entries[1].message.content[0].thinkingSignature, 'original-signature');
  const actions = await f.actions();
  assert.deepEqual(actions.map(a => a.action), ['inspect', 'snapshot', 'snapshot', 'objects']);
  assert.ok(actions.slice(1).every(a => a.sessionId === admitted.sessionId));
  assert.equal((await f.invoke(...f.args, '--name', 'different', '--request', 'pull-id')).error.code, 'request-conflict');
  await writeFile(f.shim, '#!/bin/sh\nexit 255\n');
  assert.equal((await f.invoke('retry', 'pull-id')).result.sessionId, admitted.sessionId, 'completed retry must work with source offline');
  assert.equal((await f.invoke('status', 'pull-id')).result.status, 'ready');
});

test('SF-14: source export/object cache is bound to the destination UUID and snapshot digest', async t => {
  const f = await fixture(t); const source = await f.session(); const before = await readFile(source);
  const sessionId = randomUUID();
  const request = { version: 1, action: 'snapshot', id: 'bound-source', sessionId, source: { session: '~/custom sessions/2026_source-id.jsonl' } };
  const first = await f.callSource(request); assert.equal(first.ok, true, JSON.stringify(first));
  const conflict = await f.callSource({ ...request, sessionId: randomUUID() }); assert.equal(conflict.error.code, 'request-conflict');
  const changedSelector = await f.callSource({ ...request, source: { session: '/different-source' } }); assert.equal(changedSelector.error.code, 'request-conflict');
  const badObjects = await f.callSource({ version: 1, action: 'objects', id: request.id, sessionId, snapshotSha256: 'a'.repeat(64) }); assert.equal(badObjects.error.code, 'request-conflict');
  const same = await f.callSource(request); assert.equal(same.result.origin.sha256, hash(before));
  assert.deepEqual(await readFile(source), before);
  const malicious = { version: 1, id: 'escaped-root', sessionId: randomUUID(), createdAt: '2026-10-15T00:00:00.000Z', name: 'bad-path', invocationCwd: f.home, origin: first.result.origin,
    repository: { root: f.sourceHome, homeRelativeRoot: '../escape', commit: 'a'.repeat(40), remote: null, dirty: false }, options: { from: 'source-host', session: 'source-id' } };
  const refused = JSON.parse((await f.command(process.execPath, [cli, '_peer'], { input: JSON.stringify({ version: 1, action: 'receive', request: malicious, snapshot: first.result.snapshot }) })).stdout);
  assert.equal(refused.error.code, 'protocol');
  await assert.rejects(() => stat(join(f.home, '.pi/agent/session-forks/incoming')));
});

test('SF-13/14: pull keeps destination paths local, enforces dirty omission and can clone explicitly', async t => {
  const f = await fixture(t); const sourceRepo = join(f.sourceHome, 'repo'); await mkdir(sourceRepo);
  await f.git(sourceRepo, 'init', '--quiet', '--initial-branch=main'); await writeFile(join(sourceRepo, 'a.txt'), 'clean\n');
  await f.git(sourceRepo, 'add', 'a.txt'); await f.git(sourceRepo, 'commit', '--quiet', '--no-gpg-sign', '-m', 'base');
  const bare = join(f.dir, 'origin.git'); await f.command('git', ['clone', '--bare', '--quiet', sourceRepo, bare]); await f.git(sourceRepo, 'remote', 'add', 'origin', bare);
  await f.session(sourceRepo); await writeFile(join(sourceRepo, 'a.txt'), 'dirty\n');
  const dirty = await f.invoke(...f.args, '--name', 'dirty'); assert.equal(dirty.error.code, 'source-dirty');
  const noClone = await f.invoke(...f.args, '--name', 'omitted', '--dirty', 'omit'); assert.equal(noClone.error.code, 'clone-required');
  const cloned = await f.invoke(...f.args, '--name', 'omitted', '--dirty', 'omit', '--clone');
  assert.equal(cloned.ok, true, JSON.stringify(cloned));
  assert.equal(cloned.result.destination.repo, join(f.home, 'repo'));
  assert.equal(await readFile(join(cloned.result.cwd, 'a.txt'), 'utf8'), 'clean\n');
  assert.match(cloned.result.warnings[0], /omitted/);
  assert.equal(await readFile(join(sourceRepo, 'a.txt'), 'utf8'), 'dirty\n');
  const absolute = await f.invoke(...f.args, '--cwd', './repo', '--dirty', 'omit');
  // A --no-checkout main clone is not a clean explicit cwd. It must not be reset.
  assert.equal(absolute.error.code, 'destination-dirty');
  const reused = await f.invoke(...f.args, '--cwd', './.pi/worktrees/repo/omitted', '--dirty', 'omit');
  assert.equal(reused.ok, true, JSON.stringify(reused)); assert.equal(reused.result.cwd, cloned.result.cwd);
});

test('SF-14: lost Git-bundle replies recover without rereading a removed source repository', async t => {
  const f = await fixture(t, { loseAction: 'objects' });
  const targetRepo = join(f.home, 'repo'); await mkdir(targetRepo);
  await f.git(targetRepo, 'init', '--quiet', '--initial-branch=main'); await writeFile(join(targetRepo, 'a.txt'), 'base\n');
  await f.git(targetRepo, 'add', 'a.txt'); await f.git(targetRepo, 'commit', '--quiet', '--no-gpg-sign', '-m', 'base');
  const sourceRepo = join(f.sourceHome, 'repo'); await f.command('git', ['clone', '--quiet', targetRepo, sourceRepo]);
  await writeFile(join(sourceRepo, 'a.txt'), 'saved objects\n'); await f.git(sourceRepo, 'commit', '--quiet', '--no-gpg-sign', '-am', 'unpushed');
  const source = await f.session(sourceRepo); const before = await readFile(source);
  const first = await f.invoke(...f.args, '--name', 'objects-copy', '--request', 'object-loss');
  assert.equal(first.ok, false, JSON.stringify(first)); assert.equal(first.error.details.requestId, 'object-loss');
  const sourceCache = join(f.sourceHome, '.pi/agent/session-forks/exports/object-loss');
  assert.ok((await stat(join(sourceCache, 'git-bundle.json'))).size > 0);
  await rm(sourceRepo, { recursive: true, force: true }); await rm(source);
  const retry = await f.invoke('retry', 'object-loss');
  assert.equal(retry.ok, true, JSON.stringify(retry)); assert.equal(retry.result.snapshotSha256, hash(before));
  assert.equal(await readFile(join(retry.result.cwd, 'a.txt'), 'utf8'), 'saved objects\n');
  assert.deepEqual((await f.actions()).map(a => a.action), ['snapshot', 'objects', 'objects']);
  const cachePath = join(f.home, '.pi/agent/session-forks/outgoing/object-loss/git-bundle.json');
  const cached = JSON.parse(await readFile(cachePath)); cached.snapshotSha256 = 'a'.repeat(64); await writeFile(cachePath, JSON.stringify(cached));
  assert.equal((await f.invoke('retry', 'object-loss')).error.code, 'integrity');
});

test('SF-13: real Pi can pull from an empty local session and resume the pulled history', { skip: !piBinary, timeout: 60000 }, async t => {
  const f = await fixture(t); await f.session(); const target = join(f.home, 'new cwd'); await mkdir(target);
  async function rpc(sessionFile) {
    const child = spawn(piBinary, ['--mode', 'rpc', ...(sessionFile ? ['--session', sessionFile] : ['--no-session']), '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '-e', extension], { cwd: target, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', stderr = '', seq = 0; const pending = new Map(); const events = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    const exited = new Promise(resolve => child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); }));
    child.stdout.on('data', data => { buffer += data; const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) { if (!line) continue; const r = JSON.parse(line); if (pending.has(r.id)) { pending.get(r.id)(r); pending.delete(r.id); } else events.push(r); } });
    child.stderr.on('data', data => { stderr += data; });
    return { events, async request(type, extra = {}) { const id = `r${++seq}`; const response = new Promise(resolve => pending.set(id, resolve)); child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n'); return Promise.race([response, exited.then(e => { throw new Error(JSON.stringify(e)); })]); }, async close() { child.stdin.end(); const r = await exited; assert.equal(r.code, 0, JSON.stringify(r)); } };
  }
  let receipt; const original = await rpc();
  try {
    const state = await original.request('get_state');
    const response = await original.request('prompt', { message: `/session-fork --from source-host --session source-id --source-session-dir '~/custom sessions' --remote-command '${cli}' --cwd '${target}' --request native-pull` });
    assert.equal(response.success, true);
    assert.ok(original.events.some(e => /Fork native-pull: ready/.test(e.message)), JSON.stringify(original.events));
    assert.equal((await original.request('get_state')).data.sessionId, state.data.sessionId, 'pull must not replace the local Pi session');
    receipt = (await f.invoke('status', 'native-pull')).result;
  } finally { await original.close(); }
  const resumed = await rpc(receipt.sessionFile);
  try {
    const state = await resumed.request('get_state'); assert.equal(state.data.sessionId, receipt.sessionId);
    const messages = (await resumed.request('get_messages')).data.messages;
    assert.equal(messages.find(m => m.role === 'assistant').content[0].thinkingSignature, 'original-signature');
    assert.ok(messages.at(-1).content.includes(f.sourceHome)); assert.ok(messages.at(-1).content.includes(target));
  } finally { await resumed.close(); }
});
