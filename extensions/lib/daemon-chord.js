// A minimal pi-daemon `/chord` client for agent-utils modules and extensions, and where to find
// hosts: this host from PI_DAEMON_URL / PI_DAEMON_TOKEN_FILE, others from Pi's settings.json
// `client.hosts` (bearer from `client.tokenFile` or the host's own `tokenFile`). Node built-ins
// and the global WebSocket (Node 22+) only. Used by /splice and /git wt fork.

import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const CHORD_PROTOCOL = "pi-daemon.chord.v1";
const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;

export function expandHome(path, home = homedir()) {
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

/** A minimal `/chord` client: calls only, each within `timeoutMs` (30 s unless the call says). */
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
    if (message.error) waiter.reject(Object.assign(new Error(`${message.error.code}: ${message.error.message}`), { code: message.error.code }));
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
    call(method, params = {}, { timeoutMs: callTimeoutMs = CALL_TIMEOUT_MS } = {}) {
      return new Promise((resolveCall, rejectCall) => {
        const id = next++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCall(Object.assign(new Error(`${method} timed out`), { code: "timeout" }));
        }, callTimeoutMs);
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
