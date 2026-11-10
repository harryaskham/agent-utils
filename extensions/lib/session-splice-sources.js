// Where /splice reads sessions from (phase 1). Dependency-free: Node built-ins and the
// global WebSocket (Node 22+).
//
// - pi-daemon sessions, on this host or any host in Pi's settings.json `client.hosts`, over
//   the host's `/chord` with its bearer token: `sessions.list` and `conversation.history`
//   (whole turns, history before compactions included).
// - TUI Pi sessions on this host: the JSONL session files under the agent directory, read
//   along the branch that ends at the file's last entry.

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve, basename } from "node:path";

const CHORD_PROTOCOL = "pi-daemon.chord.v1";
const HISTORY_PAGE_TURNS = 64;
/** Most turns read from one source; older turns are left out. */
export const MAX_SOURCE_TURNS = 4_000;
const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;

function expandHome(path, home = homedir()) {
  return String(path).replace(/^~(?=$|\/)/, home);
}

/** This machine's node name, as provenance and as the local host's name. */
export function localNodeName(env = process.env) {
  return env.PI_DAEMON_NODE || env.CACO_NODE || hostname().split(".")[0];
}

/** Pi's agent directory. */
export function agentDirOf(env = process.env) {
  return expandHome(env.PI_CODING_AGENT_DIR || env.PI_AGENT_CONFIG_DIR || join(homedir(), ".pi", "agent"));
}

/** `client.hosts` and `client.tokenFile` from Pi's settings.json; empty when unreadable. */
export function readClientSettings(agentDir = agentDirOf()) {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    const client = settings?.client ?? {};
    return {
      hosts: Array.isArray(client.hosts) ? client.hosts.filter((host) => host && typeof host.name === "string" && typeof host.url === "string") : [],
      ...(typeof client.tokenFile === "string" ? { tokenFile: client.tokenFile } : {}),
    };
  } catch {
    return { hosts: [] };
  }
}

/**
 * A pi-daemon host by name: this host (`local`, empty, or this node's name) from
 * PI_DAEMON_URL/PI_DAEMON_TOKEN_FILE, otherwise a `client.hosts` entry.
 */
export function resolveDaemonHost(name, { settings = readClientSettings(), env = process.env } = {}) {
  const local = localNodeName(env);
  const tokenFile = env.PI_DAEMON_TOKEN_FILE || settings.tokenFile || "~/.config/pi-daemon/daemon-main.token";
  const wanted = String(name ?? "").trim();
  if (wanted === "" || wanted === "local" || wanted === local) {
    return { name: local, url: env.PI_DAEMON_URL || "http://127.0.0.1:7463", tokenFile, local: true };
  }
  const host = settings.hosts.find((candidate) => candidate.name === wanted);
  if (!host) {
    const known = settings.hosts.map((candidate) => candidate.name);
    throw new Error(`unknown host ${wanted}; settings.json client.hosts has ${known.length ? known.join(", ") : "none"}`);
  }
  return { name: host.name, url: host.url, tokenFile: host.tokenFile || tokenFile, local: false };
}

function chordUrl(url) {
  const parsed = new URL(url);
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) throw new Error(`unsupported URL ${url}`);
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const target = /\/chord\/?$/.test(parsed.pathname) ? parsed : new URL("/chord", parsed);
  target.protocol = secure ? "wss:" : "ws:";
  return target;
}

/** A minimal `/chord` client: calls only. */
export async function connectChord({ url, token, timeoutMs = CONNECT_TIMEOUT_MS, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== "function") throw new Error("this runtime has no WebSocket (Node 22 or later is needed)");
  const socket = new WebSocketImpl(chordUrl(url), { protocols: [CHORD_PROTOCOL], headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => {
      rejectOpen(new Error(`timed out connecting to ${url}`));
      try { socket.close(); } catch {}
    }, timeoutMs);
    const fail = () => {
      clearTimeout(timer);
      rejectOpen(new Error(`could not connect to ${url}`));
    };
    socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  let next = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const waiter = message && pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("the /chord connection closed"));
    }
    pending.clear();
  });
  return {
    call(method, params = {}) {
      return new Promise((resolveCall, rejectCall) => {
        const id = next++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error(`${method} timed out`));
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try { socket.close(); } catch {}
    },
  };
}

/** Connect to a resolved host with its token file. */
export async function connectHost(host, { connect = connectChord } = {}) {
  let token;
  try {
    token = readFileSync(expandHome(host.tokenFile), "utf8").trim();
  } catch (error) {
    throw new Error(`cannot read ${host.name}'s token file ${host.tokenFile}: ${error.message}`);
  }
  return connect({ url: host.url, token });
}

/** Every session a host's catalog lists, newest activity first. */
export async function listDaemonSessions(client) {
  const sessions = [];
  let after;
  for (let page = 0; page < 50; page += 1) {
    const result = await client.call("sessions.list", { limit: 500, ...(after === undefined ? {} : { after }) });
    const items = Array.isArray(result?.items) ? result.items : [];
    sessions.push(...items);
    after = result?.next ?? result?.after;
    if (!after || !items.length) break;
  }
  return sessions
    .filter((session) => typeof session?.id === "string")
    .map((session) => ({
      id: session.id,
      ...(session.name ? { name: session.name } : {}),
      title: session.title || session.name || session.id,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.profile ? { profile: session.profile } : {}),
      activeAt: session.activeAt ?? session.active_at ?? session.createdAt ?? 0,
    }))
    .sort((a, b) => b.activeAt - a.activeAt);
}

/** The one session `ref` names: id, name or title exactly, else a unique id prefix or title part. */
export function matchSession(sessions, ref) {
  const wanted = String(ref).trim();
  const lower = wanted.toLowerCase();
  const exact = sessions.filter((session) => session.id === wanted || session.name === wanted || session.title?.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const loose = exact.length ? exact : sessions.filter((session) => session.id.startsWith(wanted) || session.title?.toLowerCase().includes(lower));
  if (loose.length === 1) return loose[0];
  if (!loose.length) throw new Error(`no session matches ${wanted}`);
  throw new Error(`${loose.length} sessions match ${wanted}: ${loose.slice(0, 8).map((session) => `${session.id} (${session.title})`).join(", ")}${loose.length > 8 ? ", …" : ""}`);
}

const MODEL_KINDS = new Set(["pi.user", "pi.assistant", "pi.tool-result"]);

/** The model messages of Durable transcript entries: user, assistant and tool results, in order. */
export function messagesOfEntries(entries) {
  const messages = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!MODEL_KINDS.has(entry?.kind) || !Array.isArray(entry.model)) continue;
    for (const message of entry.model) if (message && ["user", "assistant", "toolResult"].includes(message.role)) messages.push(message);
  }
  return messages;
}

/** Read a pi-daemon session's transcript: whole turns, oldest first, back to MAX_SOURCE_TURNS. */
export async function readDaemonTranscript(client, sessionId, { conversation, maxTurns = MAX_SOURCE_TURNS } = {}) {
  const pages = [];
  let before;
  let turns = 0;
  for (;;) {
    const page = await client.call("conversation.history", {
      sessionId,
      turns: HISTORY_PAGE_TURNS,
      ...(conversation === undefined ? {} : { conversationId: conversation }),
      ...(before === undefined ? {} : { before }),
    });
    const entries = Array.isArray(page?.entries) ? page.entries : [];
    pages.unshift(entries);
    turns += entries.filter((entry) => entry?.kind === "pi.user").length;
    before = page?.before ?? page?.cursor;
    if (before === undefined || before === null || !entries.length || turns >= maxTurns) break;
  }
  return messagesOfEntries(pages.flat());
}

function firstLine(path) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8").split("\n")[0];
  } finally {
    closeSync(fd);
  }
}

function walkJsonl(dir, out, depth = 0) {
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of names) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth < 2) walkJsonl(path, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
  }
}

/** This host's TUI Pi sessions, most recently changed first. */
export function listPiSessions(agentDir = agentDirOf(), { limit = 50 } = {}) {
  const files = [];
  walkJsonl(join(agentDir, "sessions"), files);
  return files
    .map((path) => {
      try { return { path, mtime: statSync(path).mtimeMs }; } catch { return undefined; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ path, mtime }) => {
      let header = {};
      try { header = JSON.parse(firstLine(path)); } catch {}
      return { id: typeof header.id === "string" ? header.id : basename(path, ".jsonl"), path, ...(header.cwd ? { cwd: header.cwd } : {}), activeAt: mtime };
    });
}

/**
 * A TUI Pi session file's messages along the branch ending at its last entry, with its id,
 * name and cwd. Shell runs (`!cmd`) become user text; custom and system messages are left out.
 */
export function readPiSessionFile(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  let header = {};
  const byId = new Map();
  let leaf;
  let name;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session") { header = entry; continue; }
    if (typeof entry.id !== "string") continue;
    byId.set(entry.id, entry);
    leaf = entry.id;
  }
  const branch = [];
  const seen = new Set();
  for (let id = leaf; id && byId.has(id) && !seen.has(id); id = byId.get(id).parentId) {
    seen.add(id);
    branch.push(byId.get(id));
  }
  branch.reverse();
  const messages = [];
  for (const entry of branch) {
    if (entry.type === "session_info" && entry.name) name = entry.name;
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (["user", "assistant", "toolResult"].includes(message.role)) messages.push(message);
    else if (message.role === "bashExecution") {
      messages.push({ role: "user", content: [{ type: "text", text: `[ran \`${message.command}\`]\n${message.output ?? ""}` }], timestamp: message.timestamp });
    }
  }
  return { id: header.id || basename(path, ".jsonl"), ...(name ? { name } : {}), ...(header.cwd ? { cwd: header.cwd } : {}), messages };
}

/** Parse a source reference: `pi:ID`, a `.jsonl` path, `HOST/SESSION`, or `SESSION` on this host. */
export function parseSourceRef(src) {
  const value = String(src ?? "").trim();
  if (!value) throw new Error("no source session: give SRC (see /splice list)");
  if (value.startsWith("pi:")) return { kind: "pi", ref: value.slice(3) };
  if (value.endsWith(".jsonl") || value.startsWith("/") || value.startsWith("~/") || value.startsWith("./")) return { kind: "file", path: value };
  const slash = value.indexOf("/");
  if (slash > 0) return { kind: "daemon", host: value.slice(0, slash), ref: value.slice(slash + 1) };
  return { kind: "daemon", host: "", ref: value };
}

/**
 * Load a source session's transcript. Returns `{ host, sessionId, title, cwd, conversationId,
 * messages }`; `conversation` picks a pi-daemon conversation (the root by default).
 */
export async function loadSource(src, { conversation, env = process.env, agentDir = agentDirOf(env), settings = readClientSettings(agentDir), connect } = {}) {
  const parsed = parseSourceRef(src);
  const node = localNodeName(env);
  if (parsed.kind === "file" || parsed.kind === "pi") {
    let path = parsed.kind === "file" ? resolve(expandHome(parsed.path)) : undefined;
    if (parsed.kind === "pi") {
      const sessions = listPiSessions(agentDir, { limit: Number.MAX_SAFE_INTEGER });
      path = matchSession(sessions.map((session) => ({ ...session, title: session.cwd ? basename(session.cwd) : session.id })), parsed.ref).path;
    }
    const file = readPiSessionFile(path);
    return { host: `${node}·pi`, sessionId: file.id, title: file.name || (file.cwd ? basename(file.cwd) : file.id), ...(file.cwd ? { cwd: file.cwd } : {}), messages: file.messages };
  }
  const host = resolveDaemonHost(parsed.host, { settings, env });
  const client = await connectHost(host, connect ? { connect } : {});
  try {
    const session = matchSession(await listDaemonSessions(client), parsed.ref);
    const messages = await readDaemonTranscript(client, session.id, { conversation });
    return { host: host.name, sessionId: session.id, title: session.title, ...(session.cwd ? { cwd: session.cwd } : {}), ...(conversation === undefined ? {} : { conversationId: conversation }), messages };
  } finally {
    client.close();
  }
}

function age(ms, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * Sources to choose from: a host's pi-daemon sessions (`HOST/ID`) and, for this host, its
 * TUI Pi sessions (`pi:ID`). Each has `src` (what /splice takes) and a one-line `label`.
 */
export async function listSources({ host: hostName, env = process.env, agentDir = agentDirOf(env), settings = readClientSettings(agentDir), connect, limit = 30, now = Date.now() } = {}) {
  const host = resolveDaemonHost(hostName, { settings, env });
  const sources = [];
  const errors = [];
  try {
    const client = await connectHost(host, connect ? { connect } : {});
    try {
      for (const session of (await listDaemonSessions(client)).slice(0, limit)) {
        sources.push({ src: `${host.name}/${session.id}`, label: `${host.name} · ${session.title}${session.cwd ? ` · ${session.cwd}` : ""} · ${age(session.activeAt, now)}`, activeAt: session.activeAt });
      }
    } finally {
      client.close();
    }
  } catch (error) {
    errors.push(`${host.name} pi-daemon: ${error.message}`);
  }
  if (host.local) {
    for (const session of listPiSessions(agentDir, { limit })) {
      sources.push({ src: `pi:${session.id}`, label: `${host.name} · TUI Pi · ${session.cwd ?? session.path} · ${age(session.activeAt, now)}`, activeAt: session.activeAt });
    }
  }
  sources.sort((a, b) => b.activeAt - a.activeAt);
  return { host: host.name, sources: sources.slice(0, limit * 2), errors };
}
