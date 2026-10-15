import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs, tokenize } from '../extensions/lib/session-fork/args.js';
import { canonical, peerCall, validateOptions } from '../extensions/lib/session-fork/core.js';
import { parseSnapshot, materialize } from '../extensions/lib/session-fork/snapshot.js';
import { atomicWrite, boundedRead, hash, localPath, run, withLock, writeJson } from '../extensions/lib/session-fork/io.js';
import { openHerdr } from '../extensions/lib/session-fork/herdr.js';

const header = { type: 'session', version: 3, id: 'source-id', cwd: '/home/alice/repo', timestamp: '2026-08-21T00:00:00.000Z', parentSession: '/source-only/parent.jsonl' };
const entries = [
  { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Inspect /home/alice/repo/a', timestamp: 1 } },
  { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Read /home/alice/repo/a', thinkingSignature: 'unchanged-signature' }, { type: 'toolCall', id: 't', name: 'read', arguments: { path: '/home/alice/repo/a' }, thoughtSignature: 'unchanged-too' }], usage: { totalTokens: 42 } } },
  { type: 'custom', id: 'x', parentId: 'a', customType: 'unknown-extension', data: { socket: '/home/alice/.sock', token: 'opaque', image: { type: 'image', data: 'YWJj', mimeType: 'image/png' } } },
  { type: 'message', id: 'abandoned', parentId: 'u', message: { role: 'user', content: 'other branch' } },
];
const source = () => Buffer.from([header, ...entries].map(x => ` ${JSON.stringify(x)} `).join('\r\n') + '\r\n');
const request = bytes => ({ version: 1, id: 'fixture-request', sessionId: 'a7c6ec01-c163-47b0-9af0-847bc5441c8f', name: 'my fork', createdAt: '2026-10-15T00:00:00.000Z', origin: { sessionId: header.id, cwd: header.cwd, home: '/home/alice', host: 'host-a', leafId: 'x', sha256: hash(bytes) }, options: {} });
const destination = { cwd: '/Users/bob/work/repo', home: '/Users/bob', host: 'host-b' };

test('SF-01/02: history bytes, signatures, images, branches and custom state remain identical', () => {
  const bytes = source(); const before = Buffer.from(bytes);
  const fork = materialize(request(bytes), bytes, destination);
  const firstLF = bytes.indexOf(10); const newLF = fork.indexOf(10);
  assert.deepEqual(fork.subarray(newLF + 1, newLF + 1 + bytes.length - firstLF - 1), bytes.subarray(firstLF + 1));
  assert.deepEqual(bytes, before);
  const parsed = parseSnapshot(fork);
  assert.equal(parsed.header.parentSession, undefined);
  assert.equal(parsed.header.cwd, destination.cwd);
  assert.equal(parsed.header.forkOrigin.sessionId, header.id);
  assert.equal(parsed.entries.at(-2).parentId, 'x');
  assert.equal(parsed.entries.at(-1).customType, 'agent-utils.session-fork');
  assert.match(parsed.entries.at(-1).content, /history above is unchanged/);
  assert.equal(parsed.entries[1].message.content[0].thinkingSignature, 'unchanged-signature');
  assert.equal(parsed.entries[1].message.usage.totalTokens, 42);
  assert.equal(parsed.entries[2].data.socket, '/home/alice/.sock');
  assert.equal(parsed.entries[3].id, 'abandoned');
});
test('SF-03: fail closed on partial files, cycles, invalid messages, references, versions and checksum mismatch', () => {
  assert.throws(() => parseSnapshot(source().subarray(0, -1)), /incomplete/);
  assert.throws(() => parseSnapshot(Buffer.from([0xff, 10])), /UTF-8/);
  assert.throws(() => parseSnapshot(source(), 'missing'), /leaf/);
  for (const item of [
    { type: 'message', id: 'cycle', parentId: 'cycle', message: { role: 'user', content: 'bad' } },
    { type: 'message', id: 'bad', parentId: null },
    { type: 'compaction', id: 'bad', parentId: null, summary: 'summary', firstKeptEntryId: 'missing', tokensBefore: 100 },
    { type: 'label', id: 'bad', parentId: null, targetId: 'missing' },
  ]) assert.throws(() => parseSnapshot(Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(item)}\n`)));
  assert.throws(() => parseSnapshot(Buffer.from(`${JSON.stringify({ ...header, version: 4 })}\n`)), /v3/);
  assert.throws(() => materialize({ ...request(source()), origin: { ...request(source()).origin, sha256: 'a'.repeat(64) } }, source(), destination), /checksum/);
});
test('SF-10: shell-like quoting without evaluation; CLI and slash options agree', () => {
  const flags = '--cwd="~/target with spaces" --name \'new name\' --herdr --focus';
  assert.deepEqual(parseArgs(flags, { extension: true }).options, parseArgs(['fork', '--cwd=~/target with spaces', '--name', 'new name', '--herdr', '--focus']).options);
  assert.equal(localPath('~/a', '/cwd', '/Users/bob'), '/Users/bob/a');
  assert.equal(localPath('~', '/cwd', '/Users/bob'), '/Users/bob');
  assert.deepEqual(tokenize('"$(touch /tmp/no)"'), ['$(touch /tmp/no)']);
  for (const input of ['--wat', '--name', '--name "oops', '--focus', '--cwd x --worktree y', '--name=']) assert.throws(() => parseArgs(input, { extension: true }));
  assert.throws(() => validateOptions({ remote: '-oProxyCommand=evil' }));
  assert.throws(() => validateOptions({ worktree: '../escape' }));
  assert.throws(() => validateOptions({ clone: 'false' }), /boolean/);
  assert.throws(() => validateOptions({ unexpected: true }), /Unknown/);
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
});
test('SF-07/08: publication is private/no-clobber and locks serialize only the same request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fork-io-'));
  try {
    const path = join(dir, 'out'); await atomicWrite(path, 'original');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(() => atomicWrite(path, 'replacement'), { code: 'EEXIST' });
    assert.equal(await readFile(path, 'utf8'), 'original');
    await assert.rejects(() => boundedRead(path, 2), /limit/);
    await withLock(join(dir, 'one'), async () => {
      await assert.rejects(() => withLock(join(dir, 'one'), () => {}), { code: 'locked' });
      await withLock(join(dir, 'two'), async () => atomicWrite(join(dir, 'other'), 'progress'));
    });
    await assert.rejects(() => withLock(join(dir, 'one'), () => { throw new Error('fixture failure'); }), /fixture failure/);
    await withLock(join(dir, 'one'), async () => {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('SF-08: positively dead local owners are quarantined, unknown/live owners are not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fork-stale-lock-'));
  try {
    const pid = Number((await run(process.execPath, ['-e', 'console.log(process.pid)'], { env: { PATH: process.env.PATH } })).stdout);
    const owner = { pid, host: hostname(), nonce: randomUUID() };
    await mkdir(join(dir, 'lock')); await writeJson(join(dir, 'lock/owner.json'), owner);
    await withLock(dir, async () => {});
    assert.ok((await readdir(dir)).includes(`stale-lock-${owner.nonce}`));
    await mkdir(join(dir, 'lock')); await writeJson(join(dir, 'lock/owner.json'), { ...owner, host: 'another-host' });
    await assert.rejects(() => withLock(dir, () => {}), { code: 'locked' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('SF-04: SSH quotes the executable and carries session data only on stdin', async () => {
  let actual;
  const result = await peerCall({ remote: 'alice@node', remoteCommand: "~/tools/it's pi" }, { version: 1, action: 'status', id: 'private-id' }, async (cmd, args, options) => {
    actual = { cmd, args, options }; return { stdout: JSON.stringify({ version: 1, ok: true, result: { requestId: 'private-id', status: 'ready' } }) };
  });
  assert.equal(result.status, 'ready'); assert.equal(actual.cmd, 'ssh');
  assert.ok(actual.args.includes('BatchMode=yes'));
  assert.ok(!actual.args.join(' ').includes('private-id'));
  assert.ok(!actual.args.join(' ').includes('StrictHostKeyChecking=no'));
  assert.match(actual.options.input, /private-id/);
  assert.match(actual.args.at(-1), /"\$HOME"/);
  await assert.rejects(() => peerCall({ remote: 'node' }, { version: 1, action: 'status', id: 'expected' }, async () => ({ stdout: JSON.stringify({ version: 1, ok: true, result: { requestId: 'wrong' } }) })), { code: 'peer-correlation' });
});
test('SF-09: Herdr targets returned IDs, starts only once, and focus is opt-in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fork-herdr-')); const calls = [];
  const req = { ...request(source()), options: { herdr: true, herdrSession: 'isolated' } };
  const receipt = { cwd: '/target', sessionFile: '/sessions/fork.jsonl', destination: { makeWorktree: false } };
  const exec = async (_cmd, args) => {
    calls.push(args);
    if (args.includes('create')) return { stdout: JSON.stringify({ result: { workspace: { workspace_id: 'w20' }, root_pane: { pane_id: 'w20:p30' } } }) };
    return { stdout: JSON.stringify({ result: { agent: { pane_id: 'w20:p30', terminal_id: 'terminal-opaque' } } }) };
  };
  try {
    const first = await openHerdr(req, receipt, dir, exec);
    assert.equal(first.status, 'ready'); assert.equal(first.paneId, 'w20:p30');
    await openHerdr(req, receipt, dir, exec);
    assert.equal(calls.filter(a => a.includes('start')).length, 1);
    assert.ok(calls[0].includes('--no-focus'));
    assert.ok(calls[1].includes('w20:p30'));
    assert.ok(!calls.some(a => a.includes('focus')));
    assert.deepEqual(calls[1].slice(0, 2), ['--session', 'isolated']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('SF-09: ambiguous Herdr creation/start is never blindly repeated', async () => {
  for (const failAt of ['create', 'start']) {
    const dir = await mkdtemp(join(tmpdir(), 'fork-herdr-fail-')); const calls = [];
    try {
      const req = { ...request(source()), options: { herdr: true } };
      const receipt = { cwd: '/target', sessionFile: '/session', destination: { makeWorktree: false } };
      const exec = async (_cmd, args) => {
        calls.push(args);
        if (args.includes(failAt)) throw new Error('lost response after remote mutation');
        return { stdout: JSON.stringify({ result: { workspace: { workspace_id: 'w2' }, root_pane: { pane_id: 'w2:p1' } } }) };
      };
      assert.equal((await openHerdr(req, receipt, dir, exec)).status, 'indeterminate');
      const count = calls.length;
      assert.equal((await openHerdr(req, receipt, dir, exec)).status, 'indeterminate');
      assert.equal(calls.length, count);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
