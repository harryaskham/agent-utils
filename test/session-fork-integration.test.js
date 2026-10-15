import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../extensions/lib/session-fork/io.js';
import { parseSnapshot } from '../extensions/lib/session-fork/snapshot.js';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'scripts/pi-session.mjs');
const extension = join(root, 'extensions/session-fork.js');
const piBinary = process.env.PI_SESSION_TEST_PI_BIN;
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home-a'); await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, '.pi/agent'), PI_OFFLINE: '1', PI_DISABLE_AHP: '1', DISABLE_PI_CACO: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', LANG: 'C.UTF-8' };
  const command = (cmd, args, options = {}) => run(cmd, args, { cwd: dir, env, ...options });
  const invoke = async (...args) => {
    const result = await command(process.execPath, [cli, ...args, '--json'], { allowFailure: true });
    return { ...JSON.parse(result.stdout), code: result.code };
  };
  const session = async cwd => {
    const path = join(dir, `source-${Math.random().toString(16).slice(2)}.jsonl`);
    const rows = [
      { type: 'session', version: 3, id: 'source-fixture', timestamp: '2026-08-21T00:00:00.000Z', cwd },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-21T00:00:01.000Z', message: { role: 'user', content: `Read ${cwd}/a.txt`, timestamp: 1 } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-08-21T00:00:02.000Z', message: { role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', content: [{ type: 'thinking', thinking: `Inspect ${cwd}/a.txt`, thinkingSignature: 'opaque-test-signature' }, { type: 'text', text: 'Done' }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 2 } },
    ];
    await writeFile(path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    return path;
  };
  const git = (cwd, ...args) => command('git', ['-C', cwd, ...args]);
  const repo = async (path = join(home, 'repo')) => {
    await mkdir(path, { recursive: true }); await git(path, 'init', '--quiet', '--initial-branch=main');
    await writeFile(join(path, 'a.txt'), 'base\n'); await git(path, 'add', 'a.txt'); await git(path, 'commit', '--quiet', '--no-gpg-sign', '-m', 'initial'); return path;
  };
  return { dir, home, env, command, invoke, session, git, repo };
}

test('SF-07/10: real CLI local fork, HOME expansion, retry after source advances, status and private receipt', async t => {
  const f = await fixture(t); const source = await f.session(f.home);
  await mkdir(join(f.home, 'destination with spaces'));
  const before = await readFile(source);
  const args = ['fork', '--session', source, '--cwd', '~/destination with spaces', '--name', "name with 'quotes'", '--request', 'same-fork'];
  const first = await f.invoke(...args);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.result.cwd, join(f.home, 'destination with spaces'));
  assert.deepEqual(await readFile(source), before);
  assert.equal((await stat(first.result.sessionFile)).mode & 0o777, 0o600);
  const initialFork = await readFile(first.result.sessionFile);
  await appendFile(source, JSON.stringify({ type: 'message', id: 'u2', parentId: 'a1', message: { role: 'user', content: 'Later source work' } }) + '\n');
  const retry = await f.invoke('retry', 'same-fork');
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.result.sessionId, first.result.sessionId);
  assert.deepEqual(await readFile(first.result.sessionFile), initialFork);
  const state = await f.invoke('status', 'same-fork'); assert.equal(state.result.status, 'ready');
  assert.equal((await f.invoke(...args)).result.sessionId, first.result.sessionId);
  const collision = await f.invoke(...args.slice(0, -2), '--request', 'same-fork', '--dirty', 'omit');
  assert.equal(collision.error.code, 'request-conflict');
  await appendFile(first.result.sessionFile, JSON.stringify({ type: 'custom', id: 'later', parentId: parseSnapshot(initialFork).leafId, customType: 'new-state', data: {} }) + '\n');
  assert.equal((await f.invoke('retry', 'same-fork')).result.sessionId, first.result.sessionId, 'appended destination history must not prevent retry');
});

test('SF-05/06: real Git detached worktree at exact linked-worktree HEAD; dirty policy and collisions', async t => {
  const f = await fixture(t); const repo = await f.repo();
  const linked = join(f.home, 'linked'); await f.git(repo, 'worktree', 'add', '-b', 'feature', linked);
  await writeFile(join(linked, 'a.txt'), 'feature\n'); await f.git(linked, 'commit', '--quiet', '--no-gpg-sign', '-am', 'feature');
  const commit = (await f.git(linked, 'rev-parse', 'HEAD')).stdout.trim(); const source = await f.session(linked);
  const plan = await f.invoke('fork', '--session', source, '--name', 'feature-copy', '--dry-run');
  assert.equal(plan.result.status, 'planned', JSON.stringify(plan));
  assert.equal(plan.result.destination.repo, repo);
  await assert.rejects(() => stat(join(f.home, '.pi/session-forks')));
  const fork = await f.invoke('fork', '--session', source, '--name', 'feature-copy', '--request', 'git-fork');
  assert.equal(fork.ok, true, JSON.stringify(fork));
  assert.equal((await f.git(fork.result.cwd, 'rev-parse', 'HEAD')).stdout.trim(), commit);
  assert.equal((await f.git(fork.result.cwd, 'branch', '--show-current')).stdout.trim(), '');
  assert.equal(await readFile(join(fork.result.cwd, 'a.txt'), 'utf8'), 'feature\n');
  assert.equal((await f.invoke('retry', 'git-fork')).result.sessionId, fork.result.sessionId);
  const collision = await f.invoke('fork', '--session', source, '--name', 'feature-copy');
  assert.equal(collision.error.code, 'worktree-exists');
  await writeFile(join(linked, 'a.txt'), 'dirty changes\n');
  const dirty = await f.invoke('fork', '--session', source, '--name', 'dirty-copy');
  assert.equal(dirty.error.code, 'source-dirty');
  const omit = await f.invoke('fork', '--session', source, '--name', 'dirty-copy', '--dirty', 'omit');
  assert.equal(omit.ok, true, JSON.stringify(omit));
  assert.match(omit.result.warnings[0], /omitted/);
  assert.equal(await readFile(join(omit.result.cwd, 'a.txt'), 'utf8'), 'feature\n');
  assert.equal(await readFile(join(linked, 'a.txt'), 'utf8'), 'dirty changes\n');
  const shared = await f.invoke('fork', '--session', source, '--cwd', linked, '--name', 'same-working-directory');
  assert.equal(shared.ok, true, JSON.stringify(shared));
  assert.match(shared.result.warnings[0], /shared/);
});

test('SF-04/05/07: SSH process adapter invokes real receiver in another HOME; clone, unpushed objects, lost reply and retry', async t => {
  const f = await fixture(t); const repo = await f.repo();
  const bare = join(f.dir, 'origin.git'); await f.command('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare]);
  await f.git(repo, 'remote', 'add', 'origin', bare); await f.git(repo, 'push', '--quiet', 'origin', 'main');
  const linked = join(f.home, 'linked'); await f.git(repo, 'worktree', 'add', '-b', 'unpushed', linked);
  await writeFile(join(linked, 'a.txt'), 'only on source\n'); await f.git(linked, 'commit', '--quiet', '--no-gpg-sign', '-am', 'unpushed');
  const commit = (await f.git(linked, 'rev-parse', 'HEAD')).stdout.trim(); const source = await f.session(linked);
  const remoteHome = join(f.dir, 'home-b'); const bin = join(f.dir, 'bin'); await mkdir(remoteHome); await mkdir(bin);
  const lostReply = join(f.dir, 'lose-one-reply'); await writeFile(lostReply, '1');
  const shim = `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const fs=require('node:fs'); const args=process.argv.slice(2); if(!args.includes('BatchMode=yes')||!args.includes('fixture-host'))process.exit(98); const input=fs.readFileSync(0); const msg=JSON.parse(input); const r=spawnSync('sh',['-c',args.at(-1)],{input,env:{...process.env,HOME:${JSON.stringify(remoteHome)},PI_CODING_AGENT_DIR:${JSON.stringify(join(remoteHome, '.pi/agent'))}},maxBuffer:1024*1024}); if(msg.action==='receive'&&fs.existsSync(${JSON.stringify(lostReply)})){fs.unlinkSync(${JSON.stringify(lostReply)});process.stderr.write('simulated lost SSH reply');process.exit(255);} process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);\n`;
  await writeFile(join(bin, 'ssh'), shim); await chmod(join(bin, 'ssh'), 0o700);
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const args = ['fork', '--session', source, '--remote', 'fixture-host', '--remote-command', cli, '--name', 'remote-copy', '--request', 'remote-request'];
  const noClone = await f.invoke(...args);
  assert.equal(noClone.error.code, 'clone-required', JSON.stringify(noClone));
  const first = await f.invoke(...args, '--clone');
  assert.equal(first.ok, false); assert.equal(first.error.details.requestId, 'remote-request');
  const status = await f.invoke('status', 'remote-request');
  assert.equal(status.result.status, 'ready', JSON.stringify(status));
  assert.ok(status.result.cwd.startsWith(remoteHome));
  const retry = await f.invoke('retry', 'remote-request');
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.result.sessionId, status.result.sessionId);
  assert.equal((await f.git(retry.result.cwd, 'rev-parse', 'HEAD')).stdout.trim(), commit);
  assert.equal(await readFile(join(retry.result.cwd, 'a.txt'), 'utf8'), 'only on source\n');
  const rows = parseSnapshot(await readFile(retry.result.sessionFile));
  assert.ok(rows.entries[1].message.content[0].thinking.includes(linked), 'historical paths remain source paths');
  assert.ok(rows.entries.at(-1).content.includes(remoteHome));
  assert.equal((await readdir(dirname(retry.result.sessionFile))).filter(p => p.endsWith('.jsonl')).length, 1);
});

test('SF-07: recover publication after lost receipt and refuse tampered destination', async t => {
  const f = await fixture(t); const source = await f.session(f.home);
  const first = await f.invoke('fork', '--session', source, '--cwd', f.home, '--request', 'published');
  assert.equal(first.ok, true, JSON.stringify(first));
  await rm(join(f.home, '.pi/agent/session-forks/incoming/published/receipt.json'));
  const recovered = await f.invoke('retry', 'published');
  assert.equal(recovered.result.sessionFile, first.result.sessionFile);
  await writeFile(first.result.sessionFile, 'tampered\n');
  assert.equal((await f.invoke('status', 'published')).result.status, 'conflict');
  const refused = await f.invoke('retry', 'published'); assert.equal(refused.error.code, 'publication-conflict');
  assert.equal(await readFile(first.result.sessionFile, 'utf8'), 'tampered\n');
});

async function rpc(f, session, cwd, extra = []) {
  const child = spawn(piBinary, ['--mode', 'rpc', '--session', session, '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', ...extra], { cwd, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', sequence = 0; const pending = new Map(); const events = [];
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const exited = new Promise(resolve => child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); }));
  child.stdout.on('data', data => {
    buffer += data; const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) { if (!line) continue; const record = JSON.parse(line); if (pending.has(record.id)) { pending.get(record.id)(record); pending.delete(record.id); } else events.push(record); }
  });
  child.stderr.on('data', data => { stderr += data; });
  return {
    events,
    async request(type, rest = {}) { const id = `r${++sequence}`; const response = new Promise(resolve => pending.set(id, resolve)); child.stdin.write(JSON.stringify({ id, type, ...rest }) + '\n'); return Promise.race([response, exited.then(e => { throw new Error(JSON.stringify(e)); })]); },
    async close() { child.stdin.end(); const exit = await exited; assert.equal(exit.code, 0, JSON.stringify(exit)); },
  };
}
test('SF-11: actual Pi slash-command fork and new Pi process resume (no provider request)', { skip: !piBinary, timeout: 60000 }, async t => {
  const f = await fixture(t); const source = await f.session(f.home); const target = join(f.home, 'new cwd'); await mkdir(target);
  const live = await rpc(f, source, f.home, ['-e', extension]);
  let receipt;
  try {
    const response = await live.request('prompt', { message: `/session-fork --cwd '${target}' --name 'moved' --request native-pi` });
    assert.equal(response.success, true);
    assert.ok(live.events.some(e => /Fork native-pi: ready/.test(e.message)), JSON.stringify(live.events));
    receipt = (await f.invoke('status', 'native-pi')).result;
  } finally { await live.close(); }
  const moved = await rpc(f, receipt.sessionFile, target);
  try {
    const state = await moved.request('get_state'); assert.equal(state.data.sessionId, receipt.sessionId);
    const history = await moved.request('get_messages');
    const assistant = history.data.messages.find(m => m.role === 'assistant');
    assert.equal(assistant.content[0].thinkingSignature, 'opaque-test-signature');
    assert.equal(assistant.content[0].thinking, `Inspect ${f.home}/a.txt`);
    assert.equal(assistant.usage.totalTokens, 3);
    assert.match(history.data.messages.at(-1).content, /Session fork \/ relocation/);
  } finally { await moved.close(); }
});
