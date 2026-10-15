import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { MAX_SESSION, agentDir, boundedRead, exists, fail, hash, localPath, sessionDirectory, utf8 } from './io.js';

export function parseSnapshot(bytes, leaf) {
  if (bytes.length > MAX_SESSION) fail('size', 'Session exceeds 64 MiB');
  const text = utf8(bytes);
  if (!text.endsWith('\n')) fail('partial-session', 'Session ends with an incomplete JSONL record; wait for the writer');
  const firstNewline = text.indexOf('\n');
  let header; const entries = []; const ids = new Set();
  try {
    header = JSON.parse(text.slice(0, firstNewline));
    if (header?.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || !header.id || typeof header.cwd !== 'string') fail('session-version', 'Expected a Pi v3 session header');
    for (const line of text.slice(firstNewline + 1).split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (!entry || typeof entry.type !== 'string' || entry.type === 'session' || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) fail('session-entry', 'Invalid or duplicate session entry');
      if (entry.parentId !== null && !ids.has(entry.parentId)) fail('session-tree', `Entry ${entry.id} must reference an earlier parent or null`);
      if (entry.type === 'message' && (!entry.message || typeof entry.message.role !== 'string' || entry.message.content === undefined && entry.message.role !== 'bashExecution')) fail('session-message', `Entry ${entry.id} has no valid message`);
      if (entry.type === 'compaction' && (typeof entry.summary !== 'string' || typeof entry.tokensBefore !== 'number' || (entry.firstKeptEntryId !== entry.id && !ids.has(entry.firstKeptEntryId)))) fail('session-compaction', `Invalid compaction ${entry.id}`);
      if (['context_edit', 'label'].includes(entry.type) && !ids.has(entry.targetId)) fail('session-reference', `Invalid target on ${entry.id}`);
      ids.add(entry.id); entries.push(entry);
    }
  } catch (e) { if (e.code) throw e; fail('session-json', `Invalid session JSONL: ${e.message}`); }
  const leafId = leaf === undefined ? entries.at(-1)?.id ?? null : leaf;
  if (leafId !== null && !ids.has(leafId)) fail('session-leaf', 'Selected source leaf is not in the saved snapshot; wait until it is persisted');
  return { header, entries, leafId, tail: text.slice(firstNewline + 1), sha256: hash(bytes) };
}

export async function findSession(identifier, { cwd = process.cwd(), sourceSessionDir } = {}) {
  if (!identifier) fail('source', 'Specify --session <path|id> (Pi supplies its current session automatically)');
  const candidate = localPath(identifier, cwd);
  if (await exists(candidate)) return candidate;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(identifier)) fail('source', `Session file does not exist: ${candidate}`);
  const roots = [...new Set([await sessionDirectory(cwd, sourceSessionDir), join(agentDir(), 'sessions')])];
  const files = new Set(); let inspected = 0;
  async function walk(dir, depth) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (++inspected > 20000) fail('discovery-limit', 'Too many session files; provide the exact session path');
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth) await walk(path, depth - 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(`_${identifier}`)) files.add(path);
    }
  }
  for (const root of roots) await walk(root, 1);
  const matches = [];
  for (const path of files) {
    const bytes = await boundedRead(path);
    const { header } = parseSnapshot(bytes);
    if (header.id.startsWith(identifier)) matches.push({ path, id: header.id });
  }
  const exact = matches.filter(m => m.id === identifier);
  const selected = exact.length ? exact : matches;
  if (selected.length !== 1) fail('source', selected.length ? 'Ambiguous session ID; provide its exact path' : `Session not found: ${identifier}`);
  return selected[0].path;
}

export async function capture(source, { leafId, cwd } = {}) {
  const bytes = await boundedRead(source);
  const parsed = parseSnapshot(bytes, leafId);
  return {
    bytes, parsed,
    origin: { host: hostname(), home: homedir(), cwd: cwd || parsed.header.cwd, sessionId: parsed.header.id, sessionFile: source, leafId: parsed.leafId, sha256: parsed.sha256 },
    name: parsed.entries.filter(e => e.type === 'session_info').at(-1)?.name,
  };
}

export function materialize(request, bytes, destination) {
  const parsed = parseSnapshot(bytes, request.origin.leafId);
  if (parsed.sha256 !== request.origin.sha256 || parsed.header.id !== request.origin.sessionId) fail('integrity', 'Snapshot identity/checksum mismatch');
  const { parentSession: _parent, ...oldHeader } = parsed.header;
  const header = { ...oldHeader, id: request.sessionId, cwd: destination.cwd, timestamp: request.createdAt,
    forkOrigin: { version: 1, requestId: request.id, ...request.origin } };
  const occupied = new Set(parsed.entries.map(e => e.id));
  const idFor = suffix => {
    let attempt = 0; let id;
    do { id = hash(`${request.id}:${suffix}:${attempt++}`).slice(0, 16); } while (occupied.has(id));
    occupied.add(id); return id;
  };
  const nameEntry = { type: 'session_info', id: idFor('name'), parentId: parsed.leafId, timestamp: request.createdAt, name: request.name };
  const note = [
    'Session fork / relocation (history above is unchanged).',
    `Origin: host=${request.origin.host}, HOME=${request.origin.home}, cwd=${request.origin.cwd}, session=${request.origin.sessionId}.`,
    `Now: host=${destination.host}, HOME=${destination.home}, cwd=${destination.cwd}, session=${request.sessionId}.`,
    'Historical paths and tool results describe the origin machine. Resolve paths for this destination; do not assume old files, processes, devices, credentials or extension runtime handles still exist.',
    request.repository ? `Git commit: ${request.repository.commit}. ${request.repository.dirty ? request.repository.dirtyMode === 'shared' ? 'The working directory is shared with the source; uncommitted changes are still present. No working files were copied.' : 'WARNING: source working-tree changes were explicitly omitted; they remain on the source.' : 'Source working tree was clean.'}` : 'No Git state was transferred.',
    'The source session was not stopped or modified. Reinspect destination state before making changes.',
  ].join('\n');
  const message = { type: 'custom_message', id: idFor('relocation'), parentId: nameEntry.id, timestamp: request.createdAt, customType: 'agent-utils.session-fork', content: note, display: true,
    details: { requestId: request.id, origin: request.origin, destination } };
  return Buffer.from(`${JSON.stringify(header)}\n${parsed.tail}${JSON.stringify(nameEntry)}\n${JSON.stringify(message)}\n`);
}
