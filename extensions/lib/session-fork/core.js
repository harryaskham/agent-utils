import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VERSION, MAX_SESSION, ForkError, atomicWrite, boundedRead, exists, fail, hash, localPath, quote, readJson, requestDir, run, sessionDirectory, withLock, writeJson } from './io.js';
import { capture, findSession, materialize, parseSnapshot } from './snapshot.js';
import { destinationPlan, makeGitBundle, prepareGit, repository, slug } from './git.js';
import { openHerdr } from './herdr.js';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function validateOptions(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail('options', 'Expected a fork options object');
  const strings = new Set(['session', 'remote', 'name', 'worktree', 'repo', 'worktreeRoot', 'cwd', 'dirty', 'herdrSession', 'request', 'sessionDir', 'sourceSessionDir', 'remoteCommand']);
  const booleans = new Set(['clone', 'herdr', 'focus', 'dryRun', 'json', 'help', 'runtimeCwd']);
  for (const [key, value] of Object.entries(o)) {
    if (strings.has(key)) { if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) fail('options', `Invalid string option: ${key}`); }
    else if (booleans.has(key)) { if (typeof value !== 'boolean') fail('options', `Invalid boolean option: ${key}`); }
    else fail('options', `Unknown fork option: ${key}`);
  }
  if (o.remote && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:%\[\]-]*$/.test(o.remote)) fail('remote', 'Use an SSH host alias or user@host, without options or whitespace');
  if (o.focus && !o.herdr) fail('options', '--focus requires --herdr');
  if (o.cwd && (o.worktree || o.worktreeRoot || o.clone || o.repo)) fail('options', '--cwd reuses a directory and cannot be combined with worktree/repo/clone options');
  if (o.worktree && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(o.worktree) || o.worktree.includes('..'))) fail('worktree-name', 'Worktree names must be a single simple path component');
  if (o.dirty && o.dirty !== 'omit') fail('dirty-policy', 'The only opt-in dirty policy is --dirty omit (changes stay on source)');
  if (o.name !== undefined && (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 200 || /[\0\r\n]/.test(o.name))) fail('name', 'Session name must be 1–200 characters, without NUL/newlines');
  if (o.herdrSession && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(o.herdrSession)) fail('herdr-session', 'Invalid Herdr session name');
  if (o.remoteCommand && /[\0\r\n]/.test(o.remoteCommand)) fail('remote-command', '--remote-command is one executable path, not a shell fragment');
  return o;
}
function validateRequest(r) {
  if (!r || r.version !== VERSION) fail('protocol', 'Unsupported session-fork protocol');
  requestDir('incoming', r.id);
  if (!/^[a-f0-9-]{36}$/.test(r.sessionId || '') || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(r.createdAt || '') || !Number.isFinite(Date.parse(r.createdAt))) fail('protocol', 'Invalid destination session identity/timestamp');
  if (!r.origin || !/^[a-f0-9]{64}$/.test(r.origin.sha256 || '') || !['host', 'home', 'cwd', 'sessionId'].every(k => typeof r.origin[k] === 'string' && r.origin[k])) fail('protocol', 'Invalid source provenance');
  if (r.repository && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r.repository.commit || '')) fail('protocol', 'Invalid Git commit identity');
  if (!r.options || typeof r.name !== 'string' || !r.name || r.name.length > 200) fail('protocol', 'Invalid fork options/name');
  validateOptions(r.options);
}
export async function peerCall(options, payload, execute = run) {
  if (!options.remote) return peer(payload);
  validateOptions(options);
  const executable = options.remoteCommand || 'pi-session';
  const remoteExecutable = executable.startsWith('~/') ? `"$HOME"/${quote(executable.slice(2))}` : quote(executable);
  const result = await execute('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', options.remote, `exec ${remoteExecutable} _peer`], {
    input: `${JSON.stringify(payload)}\n`, timeout: 300000,
  });
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { fail('peer-output', 'Remote pi-session did not return JSON; verify its installation and noninteractive shell startup'); }
  if (envelope.version !== VERSION) fail('protocol', 'Remote pi-session protocol mismatch');
  if (!envelope.ok) throw new ForkError(envelope.error?.code || 'peer', envelope.error?.message || 'Remote fork failed', envelope.error?.details);
  if (envelope.result?.requestId !== (payload.request?.id ?? payload.id)) fail('peer-correlation', 'Remote receipt belongs to a different request');
  if (payload.action === 'receive' && (envelope.result.sessionId !== payload.request.sessionId || envelope.result.snapshotSha256 !== payload.request.origin.sha256)) fail('peer-correlation', 'Remote receipt does not match the transferred snapshot/session');
  return envelope.result;
}
async function verifyPrefix(path, expected) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!Number.isSafeInteger(expected.length) || expected.length < 1 || expected.length > MAX_SESSION + 1024 * 1024) fail('publication-conflict', 'Invalid published prefix length');
    if (!info.isFile() || info.size < expected.length) fail('publication-conflict', 'Published session was removed, replaced or truncated');
    const actual = Buffer.alloc(expected.length); let offset = 0;
    while (offset < actual.length) {
      const { bytesRead } = await handle.read(actual, offset, actual.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (Buffer.isBuffer(expected) ? !actual.equals(expected) : hash(actual) !== expected.sha256) fail('publication-conflict', 'Published session no longer has the original fork prefix; refusing overwrite');
  } finally { await handle.close(); }
}
function resumeCommand(receipt, remote) {
  const command = `cd ${quote(receipt.cwd)} && pi --session ${quote(receipt.sessionFile)}`;
  return { onDestination: command, fromSource: remote ? `ssh -t -- ${quote(remote)} ${quote(command)}` : command };
}
export async function receive(request, snapshot, bundle) {
  validateRequest(request);
  if (typeof snapshot !== 'string' || snapshot.length > Math.ceil(MAX_SESSION * 4 / 3) + 4) fail('size', 'Invalid or oversized session snapshot');
  const bytes = Buffer.from(snapshot, 'base64');
  const parsed = parseSnapshot(bytes, request.origin.leafId);
  if (parsed.sha256 !== request.origin.sha256 || parsed.header.id !== request.origin.sessionId) fail('integrity', 'Source snapshot checksum or identity mismatch');
  const dir = requestDir('incoming', request.id);
  return withLock(dir, async () => {
    const requestPath = join(dir, 'request.json');
    let plan;
    if (await exists(requestPath)) {
      const saved = await readJson(requestPath);
      if (canonical(saved.request) !== canonical(request)) fail('request-conflict', 'Request ID already belongs to a different snapshot/intent');
      plan = saved.destination;
    } else {
      plan = await destinationPlan(request);
      // Freeze destination resolution before any Git/Herdr mutation.
      if (plan.makeWorktree && await exists(plan.cwd)) fail('worktree-exists', `Destination already exists: ${plan.cwd}. Use another name or explicit --cwd.`);
      await writeJson(requestPath, { request, destination: plan });
    }
    const expected = materialize(request, bytes, plan);
    const receiptPath = join(dir, 'receipt.json');
    let receipt = await readJson(receiptPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (receipt) await verifyPrefix(receipt.sessionFile, expected);
    else {
      await prepareGit(request, plan, dir, bundle);
      const sessionDir = await sessionDirectory(plan.cwd, request.options.sessionDir);
      const sessionFile = join(sessionDir, `${request.createdAt.replace(/[:.]/g, '-')}_${request.sessionId}.jsonl`);
      try { await atomicWrite(sessionFile, expected); }
      catch (e) { if (e.code !== 'EEXIST') throw e; await verifyPrefix(sessionFile, expected); }
      receipt = { version: VERSION, requestId: request.id, status: 'ready', sessionId: request.sessionId, sessionFile, cwd: plan.cwd, destination: plan,
        origin: request.origin, snapshotSha256: request.origin.sha256, publishedSha256: hash(expected), publishedBytes: expected.length, name: request.name,
        warnings: request.repository?.dirty ? [request.repository.dirtyMode === 'shared' ? 'Working directory is shared with the source; uncommitted files remain present.' : 'Uncommitted source changes were explicitly omitted.'] : [],
        createdAt: request.createdAt };
      receipt.resume = resumeCommand(receipt, request.options.remote);
      await writeJson(receiptPath, receipt);
    }
    if (request.options.herdr) {
      receipt.herdr = await openHerdr(request, receipt, dir);
      receipt.status = receipt.herdr.status === 'ready' && (!request.options.focus || receipt.herdr.focused) ? 'ready' : 'indeterminate';
      await writeJson(receiptPath, receipt, { replace: true });
    }
    return receipt;
  });
}
export async function peer(payload) {
  if (!payload || payload.version !== VERSION) fail('protocol', 'Unsupported peer protocol');
  if (payload.action === 'status') {
    const dir = requestDir('incoming', payload.id);
    if (await exists(join(dir, 'receipt.json'))) {
      const receipt = await readJson(join(dir, 'receipt.json'));
      try { await verifyPrefix(receipt.sessionFile, { length: receipt.publishedBytes, sha256: receipt.publishedSha256 }); }
      catch (e) { return { ...receipt, status: 'conflict', error: { code: e.code, message: e.message } }; }
      const { request } = await readJson(join(dir, 'request.json'));
      if (request.options.herdr) {
        receipt.herdr = await readJson(join(dir, 'herdr.json')).catch(e => { if (e.code === 'ENOENT') return { status: 'not_started' }; throw e; });
        receipt.status = receipt.herdr.status === 'ready' && (!request.options.focus || receipt.herdr.focused) ? 'ready'
          : receipt.herdr.status === 'indeterminate' || receipt.herdr.error ? 'indeterminate' : 'pending';
      }
      return receipt;
    }
    return { requestId: payload.id, status: await exists(join(dir, 'request.json')) ? 'pending' : 'missing', locked: await exists(join(dir, 'lock')) };
  }
  validateRequest(payload.request);
  if (payload.action === 'probe') return { ...await destinationPlan(payload.request), requestId: payload.request.id };
  if (payload.action === 'receive') return receive(payload.request, payload.snapshot, payload.bundle);
  fail('protocol', 'Unknown peer action');
}
async function executeRequest(request, dir) {
  const bytes = await boundedRead(join(dir, 'snapshot.jsonl'));
  if (hash(bytes) !== request.origin.sha256) fail('integrity', 'Saved source snapshot checksum mismatch');
  let bundle = null;
  if (await exists(join(dir, 'git-bundle.json'))) bundle = await readJson(join(dir, 'git-bundle.json'));
  try {
    const result = await peerCall(request.options, { version: VERSION, action: 'receive', request, snapshot: bytes.toString('base64'), bundle });
    await writeJson(join(dir, 'receipt.json'), result, { replace: true });
    return result;
  } catch (e) {
    // A lost SSH response is not evidence that the destination did nothing.
    const failure = { version: VERSION, requestId: request.id, status: 'pending', error: { code: e.code || 'error', message: e.message }, retry: `pi-session retry ${quote(request.id)}` };
    await writeJson(join(dir, 'last-error.json'), failure, { replace: true });
    throw new ForkError(e.code || 'fork', `${e.message}\nRetry the frozen request: ${failure.retry}`, { ...e.details, requestId: request.id });
  }
}
export async function forkSession(options, { sourceCwd = process.cwd(), leafId } = {}) {
  validateOptions(options);
  const id = options.request || randomUUID();
  const dir = requestDir('outgoing', id);
  const { json: _json, dryRun, request: _request, ...intent } = options;
  const make = async () => {
    const source = await findSession(options.session, { cwd: sourceCwd, sourceSessionDir: options.sourceSessionDir });
    const snapshot = await capture(source, { leafId, cwd: sourceCwd });
    // CLI callers without an explicit runtime cwd use the recorded workspace.
    if (!options.runtimeCwd) snapshot.origin.cwd = snapshot.parsed.header.cwd;
    const repo = await repository(snapshot.origin.cwd);
    if (repo?.dirty) {
      const sameDirectory = !options.remote && options.cwd && await realpath(localPath(options.cwd, sourceCwd)).catch(() => null) === await realpath(snapshot.origin.cwd);
      repo.dirtyMode = sameDirectory ? 'shared' : 'omitted';
      if (!sameDirectory && options.dirty !== 'omit') fail('source-dirty', 'Source has uncommitted/untracked changes. Commit them, or explicitly use --dirty omit; nothing was transferred.');
    }
    const name = options.name || snapshot.name || repo?.branch || `fork-${id.slice(0, 8)}`;
    const request = { version: VERSION, id, sessionId: randomUUID(), createdAt: new Date().toISOString(), name, origin: snapshot.origin, repository: repo, invocationCwd: sourceCwd, options: intent };
    const destination = await peerCall(options, { version: VERSION, action: 'probe', request });
    if (dryRun) return { version: VERSION, status: 'planned', requestId: id, name, origin: request.origin, destination, dirty: !!repo?.dirty, transferGitObjects: !!repo && !destination.hasCommit };
    // Persist all immutable transfer inputs before contacting the mutating peer.
    await atomicWrite(join(dir, 'snapshot.jsonl'), snapshot.bytes, { replace: true });
    if (repo && destination.makeWorktree && !destination.hasCommit) await writeJson(join(dir, 'git-bundle.json'), await makeGitBundle(repo), { replace: true });
    await writeJson(join(dir, 'request.json'), { request, intent });
    return executeRequest(request, dir);
  };
  if (dryRun) return make();
  try {
    return await withLock(dir, async () => {
      if (await exists(join(dir, 'request.json'))) {
        const saved = await readJson(join(dir, 'request.json'));
        if (canonical(saved.intent) !== canonical(intent)) fail('request-conflict', 'Request ID already belongs to another intent; use retry or a new ID');
        return executeRequest(saved.request, dir);
      }
      return make();
    });
  } catch (e) {
    throw new ForkError(e.code || 'fork', e.message, { ...e.details, requestId: id });
  }
}
export async function retryFork(id) {
  const dir = requestDir('outgoing', id);
  return withLock(dir, async () => executeRequest((await readJson(join(dir, 'request.json'))).request, dir));
}
export async function forkStatus(id, options = {}) {
  if (options.remote) return peerCall(options, { version: VERSION, action: 'status', id });
  const dir = requestDir('outgoing', id);
  if (await exists(join(dir, 'request.json'))) {
    const { request } = await readJson(join(dir, 'request.json'));
    return peerCall(request.options, { version: VERSION, action: 'status', id });
  }
  return peer({ version: VERSION, action: 'status', id });
}
