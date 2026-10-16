import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VERSION, MAX_SESSION, MAX_BUNDLE, ForkError, atomicWrite, boundedRead, canonical, exists, fail, hash, localPath, quote, readJson, requestDir, run, sessionDirectory, withLock, writeJson } from './io.js';
import { decodeSnapshot, materialize } from './snapshot.js';
import { decodeGitBundle, destinationPlan, makeGitBundle, prepareGit } from './git.js';
import { openHerdr } from './herdr.js';
import { captureSource, sourcePeer } from './source.js';

export { canonical } from './io.js';
export function validateOptions(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail('options', 'Expected a fork options object');
  const strings = new Set(['session', 'remote', 'from', 'name', 'worktree', 'repo', 'worktreeRoot', 'cwd', 'dirty', 'herdrSession', 'request', 'sessionDir', 'sourceSessionDir', 'remoteCommand']);
  const booleans = new Set(['clone', 'herdr', 'focus', 'dryRun', 'json', 'help', 'runtimeCwd']);
  for (const [key, value] of Object.entries(o)) {
    if (strings.has(key)) { if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) fail('options', `Invalid string option: ${key}`); }
    else if (booleans.has(key)) { if (typeof value !== 'boolean') fail('options', `Invalid boolean option: ${key}`); }
    else fail('options', `Unknown fork option: ${key}`);
  }
  for (const host of [o.remote, o.from]) if (host && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:%\[\]-]*$/.test(host)) fail('remote', 'Use an SSH host alias or user@host, without options or whitespace');
  if (o.from && o.remote) fail('options', '--from pulls here; it cannot be combined with --remote');
  if (o.from && !o.session) fail('source', 'Pull requires --session <path|id> on the source host');
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
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value);
  if (!r.origin || !/^[a-f0-9]{64}$/.test(r.origin.sha256 || '') || !['host', 'home', 'cwd', 'sessionId'].every(k => text(r.origin[k])) || !isAbsolute(r.origin.home) || !isAbsolute(r.origin.cwd) || (r.origin.leafId !== null && !text(r.origin.leafId))) fail('protocol', 'Invalid source provenance');
  if (r.repository) {
    const repo = r.repository;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(repo.commit || '')) fail('protocol', 'Invalid Git commit identity');
    if (!text(repo.root) || !isAbsolute(repo.root) || typeof repo.dirty !== 'boolean' || (repo.remote !== null && !text(repo.remote))) fail('protocol', 'Invalid Git source metadata');
    const path = repo.homeRelativeRoot;
    if (path !== null && (typeof path !== 'string' || path.length > 4096 || /[\0\r\n]/.test(path) || isAbsolute(path) || path.split(/[\\/]/).includes('..'))) fail('protocol', 'Source repo HOME-relative path must not escape HOME');
  }
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
    maxOutput: payload.action === 'snapshot' ? Math.ceil(MAX_SESSION * 4 / 3) + 1024 * 1024
      : payload.action === 'objects' ? Math.ceil(MAX_BUNDLE * 4 / 3) + 1024 * 1024 : 1024 * 1024,
  });
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { fail('peer-output', 'Remote pi-session did not return JSON; verify its installation and noninteractive shell startup'); }
  if (envelope.version !== VERSION) fail('protocol', 'Remote pi-session protocol mismatch');
  if (!envelope.ok) throw new ForkError(envelope.error?.code || 'peer', envelope.error?.message || 'Remote fork failed', envelope.error?.details);
  if (envelope.result?.requestId !== (payload.request?.id ?? payload.id)) fail('peer-correlation', 'Remote receipt belongs to a different request');
  if (payload.action === 'receive' && (envelope.result.sessionId !== payload.request.sessionId || envelope.result.snapshotSha256 !== payload.request.origin.sha256)) fail('peer-correlation', 'Remote receipt does not match the transferred snapshot/session');
  if (['inspect', 'snapshot', 'objects'].includes(payload.action) && envelope.result.sessionId !== payload.sessionId) fail('peer-correlation', 'Source snapshot belongs to another destination session');
  if (payload.action === 'objects' && envelope.result.snapshotSha256 !== payload.snapshotSha256) fail('peer-correlation', 'Source Git bundle belongs to another snapshot');
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
  const fromInitiator = remote ? `ssh -t -- ${quote(remote)} ${quote(command)}` : command;
  return { onDestination: command, fromInitiator, ...(receipt.direction === 'pull' ? {} : { fromSource: fromInitiator }) };
}
export async function receive(request, snapshot, bundle) {
  validateRequest(request);
  const bytes = decodeSnapshot(snapshot, request.origin);
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
      receipt = { version: VERSION, requestId: request.id, status: 'ready', direction: request.options.from ? 'pull' : 'push', sourceHost: request.options.from || request.origin.host, sessionId: request.sessionId, sessionFile, cwd: plan.cwd, destination: plan,
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
  if (['inspect', 'snapshot', 'objects'].includes(payload.action)) return sourcePeer(payload);
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
  if (await exists(join(dir, 'git-bundle.json'))) {
    bundle = await readJson(join(dir, 'git-bundle.json'));
    if (request.options.from && (bundle.snapshotSha256 !== request.origin.sha256 || bundle.sessionId !== request.sessionId)) fail('integrity', 'Cached Git bundle belongs to another pull snapshot');
  }
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
function sourceTransport(options) {
  return { remote: options.from, ...(options.remoteCommand ? { remoteCommand: options.remoteCommand } : {}) };
}
async function pullSnapshot(initiation, dir, dryRun) {
  const { intent: options, id, sessionId } = initiation;
  const path = join(dir, 'source.json');
  if (!dryRun && await exists(path)) {
    const metadata = await readJson(path);
    const bytes = await boundedRead(join(dir, 'snapshot.jsonl'));
    if (metadata.sessionId !== sessionId || hash(bytes) !== metadata.origin.sha256) fail('integrity', 'Cached pull snapshot was modified');
    return { ...metadata, bytes };
  }
  const source = { session: options.session, ...(options.sourceSessionDir ? { sourceSessionDir: options.sourceSessionDir } : {}) };
  const { snapshot, ...metadata } = await peerCall(sourceTransport(options), {
    version: VERSION, action: dryRun ? 'inspect' : 'snapshot', id, sessionId, source,
  });
  if (dryRun) return metadata;
  const bytes = decodeSnapshot(snapshot, metadata.origin);
  await atomicWrite(join(dir, 'snapshot.jsonl'), bytes, { replace: true });
  await writeJson(path, metadata);
  return { ...metadata, bytes };
}
async function prepareRequest(initiation, dir, dryRun = false) {
  const { id, sessionId, createdAt, sourceCwd, intent: options, leafId } = initiation;
  validateOptions(options);
  const snapshot = options.from ? await pullSnapshot(initiation, dir, dryRun) : await captureSource(options, { sourceCwd, leafId });
  const repo = snapshot.repository;
  if (repo?.dirty) {
    const sameDirectory = !options.remote && !options.from && options.cwd && await realpath(localPath(options.cwd, sourceCwd)).catch(() => null) === await realpath(snapshot.origin.cwd);
    repo.dirtyMode = sameDirectory ? 'shared' : 'omitted';
    if (!sameDirectory && options.dirty !== 'omit') fail('source-dirty', 'Source snapshot has uncommitted/untracked changes. Use a new request after committing, or explicitly choose --dirty omit; no destination session was published.');
  }
  const name = options.name || snapshot.name || repo?.branch || `fork-${id.slice(0, 8)}`;
  const request = { version: VERSION, id, sessionId, createdAt, name, origin: snapshot.origin, repository: repo, invocationCwd: sourceCwd, options };
  validateRequest(request);
  const destination = await peerCall(options, { version: VERSION, action: 'probe', request });
  if (dryRun) return { version: VERSION, status: 'planned', direction: options.from ? 'pull' : 'push', requestId: id, name, origin: request.origin, destination, dirty: !!repo?.dirty, transferGitObjects: !!repo && !destination.hasCommit };
  await atomicWrite(join(dir, 'snapshot.jsonl'), snapshot.bytes, { replace: true });
  if (repo && destination.makeWorktree && !destination.hasCommit) {
    const path = join(dir, 'git-bundle.json');
    let bundle;
    if (options.from) {
      if (await exists(path)) {
        bundle = await readJson(path);
        if (bundle.snapshotSha256 !== request.origin.sha256 || bundle.sessionId !== sessionId) fail('integrity', 'Cached Git bundle belongs to another pull snapshot');
      } else {
        const result = await peerCall(sourceTransport(options), { version: VERSION, action: 'objects', id, sessionId, snapshotSha256: request.origin.sha256 });
        bundle = { ...result.bundle, snapshotSha256: request.origin.sha256, sessionId };
      }
    } else bundle = await makeGitBundle(repo);
    decodeGitBundle(bundle);
    await writeJson(path, bundle, { replace: true });
  }
  await writeJson(join(dir, 'request.json'), { request, intent: options });
  return request;
}
async function prepareAndExecute(initiation, dir) {
  let request;
  try { request = await prepareRequest(initiation, dir); }
  catch (e) {
    if (!initiation.intent.from) throw e;
    const retry = `pi-session retry ${quote(initiation.id)}`;
    await writeJson(join(dir, 'last-error.json'), { requestId: initiation.id, status: 'pending', phase: 'preparing', error: { code: e.code || 'error', message: e.message }, retry }, { replace: true });
    throw new ForkError(e.code || 'fork', `${e.message}\nRetry the saved pull request: ${retry}`, { ...e.details, requestId: initiation.id });
  }
  return executeRequest(request, dir);
}
export async function forkSession(options, { sourceCwd = process.cwd(), leafId } = {}) {
  validateOptions(options);
  const id = options.request || randomUUID();
  const dir = requestDir('outgoing', id);
  const { json: _json, dryRun, request: _request, ...intent } = options;
  let initiation = { version: VERSION, id, sessionId: randomUUID(), createdAt: new Date().toISOString(), sourceCwd, intent, ...(leafId !== undefined ? { leafId } : {}) };
  if (dryRun) return prepareRequest(initiation, dir, true);
  try {
    return await withLock(dir, async () => {
      if (await exists(join(dir, 'request.json'))) {
        const saved = await readJson(join(dir, 'request.json'));
        if (canonical(saved.intent) !== canonical(intent)) fail('request-conflict', 'Request ID already belongs to another intent; use retry or a new ID');
        return executeRequest(saved.request, dir);
      }
      const path = join(dir, 'initiation.json');
      if (await exists(path)) {
        initiation = await readJson(path);
        if (initiation.version !== VERSION || canonical(initiation.intent) !== canonical(intent)) fail('request-conflict', 'Request ID already belongs to another intent; use retry or a new ID');
      } else if (options.from) {
        // Admit before SSH. Even a lost first snapshot response can be retried
        // with the same source cache key and allocated destination session ID.
        await writeJson(path, initiation);
      }
      return prepareAndExecute(initiation, dir);
    });
  } catch (e) {
    throw new ForkError(e.code || 'fork', e.message, { ...e.details, requestId: id });
  }
}
export async function retryFork(id) {
  const dir = requestDir('outgoing', id);
  return withLock(dir, async () => {
    if (await exists(join(dir, 'request.json'))) return executeRequest((await readJson(join(dir, 'request.json'))).request, dir);
    if (await exists(join(dir, 'initiation.json'))) return prepareAndExecute(await readJson(join(dir, 'initiation.json')), dir);
    fail('no-request', 'No resumable request was admitted; rerun the original fork command');
  });
}
export async function forkStatus(id, options = {}) {
  if (options.remote) return peerCall(options, { version: VERSION, action: 'status', id });
  const dir = requestDir('outgoing', id);
  if (await exists(join(dir, 'request.json'))) {
    const { request } = await readJson(join(dir, 'request.json'));
    return peerCall(request.options, { version: VERSION, action: 'status', id });
  }
  if (await exists(join(dir, 'initiation.json'))) {
    const { intent } = await readJson(join(dir, 'initiation.json'));
    const failure = await readJson(join(dir, 'last-error.json')).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
    return { version: VERSION, requestId: id, status: 'pending', phase: 'preparing', direction: 'pull', sourceHost: intent.from, error: failure.error, locked: await exists(join(dir, 'lock')) };
  }
  return peer({ version: VERSION, action: 'status', id });
}
