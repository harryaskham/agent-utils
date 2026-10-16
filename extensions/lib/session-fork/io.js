import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { access, link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';

export const VERSION = 1;
export const MAX_SESSION = 64 * 1024 * 1024;
export const MAX_BUNDLE = 128 * 1024 * 1024;
export const MAX_WIRE = Math.ceil((MAX_SESSION + MAX_BUNDLE) * 4 / 3) + 1024 * 1024;
export class ForkError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export const fail = (code, message, details) => { throw new ForkError(code, message, details); };
export const hash = data => createHash('sha256').update(data).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const exists = path => access(path).then(() => true, () => false);
export function localPath(value, cwd = process.cwd(), home = homedir()) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) fail('path', 'Expected a nonempty path without NUL/newlines');
  if (value === '~') return home;
  if (value.startsWith('~/')) return resolve(home, value.slice(2));
  if (value.startsWith('~')) fail('path', 'Only ~ and ~/ HOME expansion are supported');
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}
export const agentDir = () => localPath(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'));
export function requestDir(direction, id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(id || '')) fail('request-id', 'Request IDs must be 1–96 letters, digits, dots, underscores or hyphens');
  return join(agentDir(), 'session-forks', direction, id);
}
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export async function privateDir(path) { await mkdir(path, { recursive: true, mode: 0o700 }); }
export async function boundedRead(path, max = MAX_SESSION) {
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > max) fail('size', `Not a regular file within the ${max}-byte limit: ${path}`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail('source-changed', `File changed while reading: ${path}`);
      offset += bytesRead;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) fail('source-changed', `File changed while reading; retry when idle: ${path}`);
    return bytes;
  } finally { await file.close(); }
}
export function utf8(bytes) {
  if (!isUtf8(bytes)) fail('encoding', 'Session must be valid UTF-8');
  return bytes.toString('utf8');
}
export async function readJson(path) { return JSON.parse(utf8(await boundedRead(path, MAX_WIRE))); }
async function syncDir(path) {
  const dir = await open(path, 'r');
  try { await dir.sync(); } catch (e) { if (!['EINVAL', 'ENOTSUP'].includes(e.code)) throw e; }
  finally { await dir.close(); }
}
export async function atomicWrite(path, data, { replace = false } = {}) {
  await privateDir(dirname(path));
  const temp = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data); await handle.sync(); await handle.close();
    if (replace) await rename(temp, path); else await link(temp, path);
    await syncDir(dirname(path));
  } finally { await handle.close().catch(() => {}); await rm(temp, { force: true }); }
}
export const writeJson = (path, value, options) => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, options);
export async function withLock(dir, fn) {
  await privateDir(dir);
  const path = join(dir, 'lock');
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const identity = await stat(path).catch(() => null);
      const owner = await readJson(join(path, 'owner.json')).catch(() => null);
      let dead = false;
      if (owner?.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0 && /^[a-f0-9-]{36}$/.test(owner.nonce || '')) {
        try { process.kill(owner.pid, 0); } catch (probe) { dead = probe.code === 'ESRCH'; }
      }
      if (!dead || attempt >= 3) fail('locked', `Request is locked. Inspect ${path}; never remove a live or unverified owner's lock.`, { owner, path });
      const current = await stat(path).catch(() => null);
      if (!current || current.ino !== identity?.ino || current.dev !== identity?.dev) continue;
      // All recoverers of this owner choose the SAME nonempty quarantine. A
      // losing rename cannot replace it, so it cannot steal a newly acquired
      // live lock after the winner has moved the dead one. Retain the evidence.
      try { await rename(path, join(dir, `stale-lock-${owner.nonce}`)); }
      catch (move) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(move.code)) throw move; }
    }
  }
  try {
    await writeJson(join(path, 'owner.json'), { pid: process.pid, host: hostname(), nonce: randomUUID(), createdAt: new Date().toISOString() });
    return await fn();
  } finally { await rm(path, { recursive: true, force: true }); }
}
export function run(command, args, { cwd, input, timeout = 120000, maxOutput = 1024 * 1024, env = process.env, signal, allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const chunks = [[], []]; let size = 0; let reason;
    const kill = () => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} };
    const abort = () => { reason = new ForkError('cancelled', `${command} cancelled`); kill(); };
    const timer = setTimeout(() => { reason = new ForkError('timeout', `${command} timed out; query/retry the same request`); kill(); }, timeout);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    [child.stdout, child.stderr].forEach((stream, index) => stream.on('data', bytes => {
      size += bytes.length;
      if (size > maxOutput) { reason = new ForkError('output-limit', `${command} output exceeded its limit`); kill(); }
      else chunks[index].push(bytes);
    }));
    child.stdin.on('error', () => {});
    child.on('error', error => { reason = error; });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (reason) return reject(reason);
      const [stdout, stderr] = chunks.map(list => Buffer.concat(list).toString('utf8'));
      if (code !== 0 && !allowFailure) return reject(new ForkError('process', `${command} exited ${code}: ${stderr.trim().slice(0, 4000)}`, { command, code }));
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
export async function sessionDirectory(cwd, explicit) {
  if (explicit) return localPath(explicit, cwd);
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return localPath(process.env.PI_CODING_AGENT_SESSION_DIR, cwd);
  const global = await readJson(join(agentDir(), 'settings.json')).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
  // Do not execute project configuration or load project extensions.
  const project = await readJson(join(cwd, '.pi', 'settings.json')).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
  const configured = project.sessionDir ?? global.sessionDir;
  return configured ? localPath(configured, cwd) : join(agentDir(), 'sessions', `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
}
