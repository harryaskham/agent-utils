// Source-side pull protocol. Reads session/Git state and retains private retry
// snapshots; never creates a destination worktree, starts Pi or calls back over SSH.
import { join } from 'node:path';
import { VERSION, atomicWrite, boundedRead, canonical, exists, fail, hash, readJson, requestDir, withLock, writeJson } from './io.js';
import { capture, findSession, parseSnapshot } from './snapshot.js';
import { decodeGitBundle, makeGitBundle, repository } from './git.js';

export async function captureSource(options, { sourceCwd = process.cwd(), leafId } = {}) {
  const path = await findSession(options.session, { cwd: sourceCwd, sourceSessionDir: options.sourceSessionDir });
  const snapshot = await capture(path, { leafId, cwd: options.runtimeCwd ? sourceCwd : undefined });
  return { bytes: snapshot.bytes, origin: snapshot.origin, name: snapshot.name, repository: await repository(snapshot.origin.cwd) };
}
function sourceIntent(payload) {
  requestDir('exports', payload.id);
  if (!/^[a-f0-9-]{36}$/.test(payload.sessionId || '')) fail('protocol', 'Pull requires its destination session identity');
  if (payload.action === 'objects') {
    if (!/^[a-f0-9]{64}$/.test(payload.snapshotSha256 || '')) fail('protocol', 'Git object request requires a snapshot checksum');
    return null;
  }
  const source = payload.source;
  if (!source || typeof source !== 'object' || Array.isArray(source) || !source.session) fail('protocol', 'Pull requires a source session path or ID');
  for (const [key, value] of Object.entries(source)) {
    if (!['session', 'sourceSessionDir'].includes(key) || typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) fail('protocol', 'Invalid pull source selector');
  }
  // Explicit request IDs cannot accidentally bind two destination initiators to
  // the same source snapshot: the allocated destination UUID is also the key.
  return { sessionId: payload.sessionId, source };
}
async function inspect(payload) {
  const snapshot = await captureSource(payload.source);
  const { bytes, ...metadata } = snapshot;
  return { bytes, metadata: { requestId: payload.id, sessionId: payload.sessionId, ...metadata } };
}
export async function sourcePeer(payload) {
  const intent = sourceIntent(payload);
  if (payload.action === 'inspect') return (await inspect(payload)).metadata;
  const dir = requestDir('exports', payload.id);
  return withLock(dir, async () => {
    const manifestPath = join(dir, 'manifest.json');
    if (payload.action === 'objects') {
      const saved = await readJson(manifestPath);
      if (saved.version !== VERSION) fail('protocol', 'Unsupported source pull journal version');
      if (saved.metadata.sessionId !== payload.sessionId || saved.metadata.origin.sha256 !== payload.snapshotSha256) fail('request-conflict', 'Git objects belong to another pull snapshot');
      if (!saved.metadata.repository) fail('git-objects', 'This source snapshot has no Git repository');
      const path = join(dir, 'git-bundle.json');
      if (!(await exists(path))) await writeJson(path, { ...await makeGitBundle(saved.metadata.repository), sessionId: payload.sessionId, snapshotSha256: payload.snapshotSha256 });
      const bundle = await readJson(path); decodeGitBundle(bundle);
      if (bundle.sessionId !== payload.sessionId || bundle.snapshotSha256 !== payload.snapshotSha256) fail('integrity', 'Cached source Git bundle belongs to another pull snapshot');
      return { requestId: payload.id, sessionId: payload.sessionId, snapshotSha256: payload.snapshotSha256, bundle };
    }
    let saved;
    if (await exists(manifestPath)) {
      saved = await readJson(manifestPath);
      if (saved.version !== VERSION || canonical(saved.intent) !== canonical(intent)) fail('request-conflict', 'Pull request ID already belongs to another source/initiator');
    } else {
      const snapshot = await inspect(payload);
      await atomicWrite(join(dir, 'snapshot.jsonl'), snapshot.bytes, { replace: true });
      saved = { version: VERSION, intent, metadata: snapshot.metadata };
      await writeJson(manifestPath, saved);
    }
    const bytes = await boundedRead(join(dir, 'snapshot.jsonl'));
    const parsed = parseSnapshot(bytes, saved.metadata.origin.leafId);
    if (hash(bytes) !== saved.metadata.origin.sha256 || parsed.header.id !== saved.metadata.origin.sessionId) fail('integrity', 'Saved source pull snapshot was modified');
    return { ...saved.metadata, snapshot: bytes.toString('base64') };
  });
}
