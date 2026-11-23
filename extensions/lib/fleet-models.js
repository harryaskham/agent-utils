// /fleet models (bd-1da117): which sessions across the fleet use a model, and moving them to
// another. Shared by TUI Pi and pi-client (extensions/fleet.js), pi-daemon (extensions/durable/
// fleet.mjs) and the pi-fleet CLI (scripts/pi-fleet.mjs). Dependency-free: Node built-ins and the
// global WebSocket (Node 22+).
//
// - Sessions: every host in Pi's settings.json `client.hosts` (and this machine), over its
//   pi-daemon's `/chord` (`sessions.list` with `withModel`, root conversations) and its bridge's
//   `/chord` (the node's TUI Pis), with the daemon's bearer token.
// - Switching: `conversation.configure` over the same `/chord`. A Cacophony agent's session goes
//   through `caco agent set-model` first, so Cacophony's record of its model follows.
// - Config defaults: this machine's Pi settings.json, each host's pi-daemon profiles
//   (`profiles.list`) and Cacophony's derived config (`caco config show --json`). They are flagged,
//   never edited: their sources are Collective and cacophony-config.

import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { agentDirOf, connectChord, localNodeName, readClientSettings } from "./session-splice-sources.js";

export const FLEET_USAGE = `/fleet models [PATTERN…] [options]: which sessions across the fleet use which model.

  /fleet models                      every model in use, with counts per host
  /fleet models '*astra*'            the sessions on any Astra model, and config defaults naming one
  /fleet models gpt-6-astra --switch github-copilot/claude-fable-5.2
                                     move every gpt-6-astra session to Fable 5.2

Patterns are globs (* ? [..]) or /regex/, ignoring case. A pattern without "/" matches the model id
(gpt-6-astra, *astra*); one with "/" matches provider/model (github-copilot/*, astra/*).

Options:
  --switch provider/model   move the matching sessions to this model (checked against each host's catalog)
  --thinking LEVEL          with --switch, also set the thinking level
  --dry-run                 with --switch, say what would move and how, change nothing
  --direct                  with --switch, move Cacophony agents over /chord too (not caco agent set-model)
  --since 30d|7d|12h|all    sessions active within this long (default 30d)
  --host GLOB               only these hosts (repeatable; name, name-tui for TUI Pis)
  --profile GLOB            only sessions of these profiles (cacophony, personal, tui)
  --archived                include archived sessions
  --no-config               skip the config-default checks
  --json                    the result as JSON`;

const DEFAULT_SINCE_MS = 30 * 24 * 3600 * 1000;
/** Sessions listed per sessions.list page when asking for models (pi-daemon's limit). */
const MODEL_PAGE = 100;
/** A bound that protects against a looping cursor, far beyond any real catalog; reported when hit. */
const MAX_PAGES = 2_000;
const CONNECT_TIMEOUT_MS = 8_000;
const CACO_CONFIG_TIMEOUT_MS = 30_000;
const CACO_SET_MODEL_TIMEOUT_MS = 130_000;
const CACO_CONCURRENCY = 4;
/** Cacophony refusals after which the runtime is switched over /chord instead (Cacophony cannot reach it). */
const CACO_FALLBACK_CODES = new Set(["model_runtime_not_resident", "model_runtime_unsupported", "agent_not_found", "pi_daemon_status_unavailable", "pi_daemon_config_unavailable", "agent_directory_unavailable"]);
/** What to do about a Cacophony refusal that fails the session. */
const CACO_HINTS = {
  agent_model_control_forbidden: " (an agent's caco may switch only itself; --direct switches its runtime over /chord instead)",
  model_not_available: " (Cacophony's model catalog lacks it: add it in cacophony-config, or --direct switches the runtime only)",
};
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "adaptive"];

// ---------------------------------------------------------------------------------------------
// Arguments

/** Words of a command line: whitespace-separated, with '…' and "…" quoting and \ escapes. */
export function tokenize(text) {
  const words = [];
  let word = "";
  let quote;
  let started = false;
  const input = String(text ?? "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && index + 1 < input.length) word += input[++index];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < input.length) {
      word += input[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error(`unclosed ${quote}`);
  if (started) words.push(word);
  return words;
}

/** `30d`, `12h`, `90m`, `all` → milliseconds (null for all). */
export function parseSince(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (value === "all" || value === "any" || value === "0") return null;
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/.exec(value);
  if (!match) throw new Error(`--since takes a duration such as 30d, 12h or all, not ${text}`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
  return Math.round(Number(match[1]) * unit);
}

/** `/fleet` arguments → what to do. Throws with a message for bad input. */
export function parseFleetArgs(args) {
  const words = Array.isArray(args) ? [...args] : tokenize(args);
  const options = { action: "models", patterns: [], hosts: [], profiles: [], sinceMs: DEFAULT_SINCE_MS, archived: false, dryRun: false, direct: false, json: false, config: true };
  const first = words[0];
  if (first === undefined || ["help", "--help", "-h"].includes(first)) return { ...options, action: "help" };
  if (first !== "models") throw new Error(`unknown /fleet command ${first}; /fleet models is the one there is`);
  words.shift();
  const value = (flag, inline) => {
    if (inline !== undefined) return inline;
    const next = words.shift();
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
    return next;
  };
  while (words.length) {
    const word = words.shift();
    const [flag, inline] = word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined];
    switch (flag) {
      case "--switch":
      case "--to":
        options.switchTo = value(flag, inline);
        break;
      case "--thinking":
        options.thinking = value(flag, inline).toLowerCase();
        if (!THINKING_LEVELS.includes(options.thinking)) throw new Error(`--thinking is one of ${THINKING_LEVELS.join(", ")}`);
        break;
      case "--since":
        options.sinceMs = parseSince(value(flag, inline));
        break;
      case "--host":
        options.hosts.push(...value(flag, inline).split(",").filter(Boolean));
        break;
      case "--profile":
        options.profiles.push(...value(flag, inline).split(",").filter(Boolean));
        break;
      case "--archived":
        options.archived = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--direct":
        options.direct = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--no-config":
        options.config = false;
        break;
      default:
        if (word.startsWith("--")) throw new Error(`unknown option ${word}`);
        options.patterns.push(word);
    }
  }
  if (options.switchTo !== undefined && options.patterns.length === 0) throw new Error("--switch needs a pattern: the models to move away from");
  if ((options.dryRun || options.direct || options.thinking) && options.switchTo === undefined) throw new Error("--dry-run, --direct and --thinking go with --switch");
  return options;
}

// ---------------------------------------------------------------------------------------------
// Models and patterns

/** `provider/modelId` → `{ provider, modelId }`; a bare id gets `provider` when given. */
export function parseModelRef(text, provider) {
  const value = String(text ?? "").trim();
  if (value === "") return undefined;
  const slash = value.indexOf("/");
  if (slash > 0 && slash < value.length - 1) return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
  if (slash >= 0) return undefined;
  return provider ? { provider, modelId: value } : { modelId: value };
}

export function modelName(model) {
  if (!model?.modelId) return "(unknown)";
  return model.provider ? `${model.provider}/${model.modelId}` : model.modelId;
}

function globSource(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end < 0) source += "\\[";
      else {
        const body = glob.slice(index + 1, end).replace(/\\/g, "\\\\");
        source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        index = end;
      }
    } else source += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return source;
}

/**
 * One pattern as a predicate on `{ provider, modelId }`: `/re/` tests `provider/modelId`; a glob
 * with "/" matches the whole `provider/modelId`; one without matches the whole model id, so
 * `*astra*` finds gpt-6-astra but not the astra provider's own models (astra/*).
 */
export function compilePattern(pattern) {
  const text = String(pattern).trim();
  if (text === "") throw new Error("empty pattern");
  const regex = /^\/(.+)\/([a-z]*)$/.exec(text);
  if (regex) {
    let compiled;
    try {
      compiled = new RegExp(regex[1], regex[2].includes("i") ? regex[2] : `${regex[2]}i`);
    } catch (error) {
      throw new Error(`bad pattern ${text}: ${error.message}`);
    }
    return (model) => Boolean(model?.modelId) && compiled.test(modelName(model));
  }
  const whole = new RegExp(`^${globSource(text)}$`, "i");
  if (text.includes("/")) return (model) => Boolean(model?.provider && model?.modelId) && whole.test(`${model.provider}/${model.modelId}`);
  return (model) => Boolean(model?.modelId) && whole.test(model.modelId);
}

/** Any of the patterns (none: every model). */
export function modelMatcher(patterns) {
  const tests = (patterns ?? []).map(compilePattern);
  if (!tests.length) return () => true;
  return (model) => tests.some((test) => test(model));
}

function globTest(globs) {
  const tests = (globs ?? []).map((glob) => new RegExp(`^${globSource(glob)}$`, "i"));
  return (text) => !tests.length || tests.some((test) => test.test(String(text ?? "")));
}

// ---------------------------------------------------------------------------------------------
// Hosts

function expandHome(path, home = homedir()) {
  return String(path).replace(/^~(?=$|\/)/, home);
}

/**
 * The fleet's hosts: Pi settings.json `client.hosts` (`{ name, url, bridge?, tokenFile? }`), and
 * this machine, reached over loopback as pi-client reaches it.
 */
export function fleetHosts({ env = process.env, settings = readClientSettings(agentDirOf(env)) } = {}) {
  const local = localNodeName(env);
  const tokenFile = env.PI_DAEMON_TOKEN_FILE || settings.tokenFile || "~/.config/pi-daemon/daemon-main.token";
  const hosts = [];
  const seen = new Set();
  for (const host of settings.hosts ?? []) {
    if (!host?.name || seen.has(host.name)) continue;
    seen.add(host.name);
    const isLocal = host.name === local;
    hosts.push({
      name: host.name,
      url: isLocal ? env.PI_DAEMON_URL || "http://127.0.0.1:7463" : host.url,
      ...(isLocal ? { bridge: env.PI_DAEMON_BRIDGE_URL || "ws://127.0.0.1:7464" } : host.bridge ? { bridge: host.bridge } : {}),
      tokenFile: host.tokenFile || tokenFile,
      local: isLocal,
    });
  }
  if (!seen.has(local)) hosts.unshift({ name: local, url: env.PI_DAEMON_URL || "http://127.0.0.1:7463", bridge: env.PI_DAEMON_BRIDGE_URL || "ws://127.0.0.1:7464", tokenFile, local: true });
  return hosts;
}

function readToken(tokenFile) {
  return readFileSync(expandHome(tokenFile), "utf8").trim();
}

/** Connect to a host's daemon (`which: "daemon"`) or bridge `/chord`. */
export async function connectFleetHost(host, which, { connect = connectChord, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const url = which === "bridge" ? host.bridge : host.url;
  if (!url) throw new Error("not configured");
  let token;
  try {
    token = readToken(host.tokenFile);
  } catch (error) {
    throw new Error(`cannot read the token file ${host.tokenFile}: ${error.message}`);
  }
  return connect({ url, token, timeoutMs });
}

// ---------------------------------------------------------------------------------------------
// Sessions

/**
 * The Cacophony agent a pi-daemon session is: Cacophony runs each agent as the session named
 * by its id, in `…/.cacophony/agents/PROJECT/ID/checkout`. Both must agree. Any other session in
 * an agent's checkout (a person's own, a TUI Pi) is not that agent, and caco must not switch the
 * agent for it.
 */
export function cacophonyAgentOf(cwd, sessionId) {
  const match = /\/\.cacophony\/agents\/([^/]+)\/([^/]+)\/checkout\/?$/.exec(String(cwd ?? ""));
  if (!match || (sessionId !== undefined && sessionId !== match[2])) return undefined;
  return { project: match[1], agentId: match[2] };
}

function sessionRow(row, host, source) {
  const model = typeof row.model === "string" ? parseModelRef(row.model) : row.model && typeof row.model === "object" ? { provider: row.model.provider, modelId: row.model.modelId } : undefined;
  const caco = source === "daemon" ? cacophonyAgentOf(row.cwd, row.id) : undefined;
  return {
    host: host.name,
    source,
    hostLabel: source === "tui" ? `${host.name}-tui` : host.name,
    id: row.id,
    title: row.title || row.name || row.id,
    cwd: row.cwd ?? "",
    profile: row.profile ?? (source === "tui" ? "tui" : ""),
    ...(model?.modelId ? { model } : {}),
    ...(typeof row.thinkingLevel === "string" ? { thinkingLevel: row.thinkingLevel } : {}),
    activeAt: Number(row.activeAt ?? row.createdAt ?? 0) || 0,
    working: row.liveWork === true,
    archived: row.isArchived === true,
    ...(caco ? { caco } : {}),
  };
}

/** One daemon's sessions within the window, with their root conversation's model; and its profiles. */
async function readDaemon(client, host, { sinceMs, now }) {
  const sessions = [];
  let after;
  let pages = 0;
  let truncated = false;
  for (;;) {
    const page = await client.call("sessions.list", { limit: MODEL_PAGE, withModel: true, ...(after === undefined ? {} : { after }) });
    const items = Array.isArray(page?.items) ? page.items : [];
    let pastWindow = false;
    for (const item of items) {
      if (typeof item?.id !== "string") continue;
      const row = sessionRow(item, host, "daemon");
      if (sinceMs !== null && now - row.activeAt > sinceMs) {
        pastWindow = true;
        continue;
      }
      sessions.push(row);
    }
    pages += 1;
    after = page?.next;
    if (!after || !items.length || pastWindow) break;
    if (pages >= MAX_PAGES) {
      truncated = true;
      break;
    }
  }
  let profiles = [];
  try {
    const listed = await client.call("profiles.list", {});
    profiles = (Array.isArray(listed?.items) ? listed.items : []).filter((profile) => typeof profile?.name === "string").map((profile) => ({ name: profile.name, ...(typeof profile.model === "string" ? { model: parseModelRef(profile.model) } : {}) }));
  } catch {
    // An older host, or one that creates no sessions.
  }
  return { sessions, profiles, ...(truncated ? { truncated: true } : {}) };
}

async function readBridge(client, host, { sinceMs, now }) {
  const page = await client.call("sessions.list", {});
  const sessions = (Array.isArray(page?.items) ? page.items : [])
    .filter((item) => typeof item?.id === "string")
    .map((item) => sessionRow(item, host, "tui"))
    .filter((row) => sinceMs === null || now - row.activeAt <= sinceMs);
  return { sessions };
}

function offlineReason(error) {
  const message = String(error?.message ?? error);
  return /timed out|could not connect|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|closed/i.test(message) ? "offline" : "error";
}

/**
 * Read every selected host's daemon and bridge, concurrently. Each source's failure is its state
 * (`offline` quietly, `error` otherwise), never an exception.
 */
export async function readFleet({ hosts, sinceMs = DEFAULT_SINCE_MS, now = Date.now(), connect } = {}) {
  const read = async (host, which) => {
    if (which === "bridge" && !host.bridge) return { state: "none", sessions: [] };
    let client;
    try {
      client = await connectFleetHost(host, which, { ...(connect ? { connect } : {}) });
    } catch (error) {
      return { state: offlineReason(error), error: String(error?.message ?? error), sessions: [] };
    }
    try {
      const result = which === "bridge" ? await readBridge(client, host, { sinceMs, now }) : await readDaemon(client, host, { sinceMs, now });
      return { state: "ok", ...result };
    } catch (error) {
      return { state: offlineReason(error), error: String(error?.message ?? error), sessions: [] };
    } finally {
      client.close();
    }
  };
  const nodes = await Promise.all(hosts.map(async (host) => {
    const [daemon, bridge] = await Promise.all([read(host, "daemon"), read(host, "bridge")]);
    return { name: host.name, local: host.local === true, daemon, bridge };
  }));
  return { nodes, observedAt: new Date(now).toISOString() };
}

/** The sessions of a fleet read, filtered. */
export function selectSessions(fleet, { matcher = () => true, profiles = [], archived = false } = {}) {
  const profileOk = globTest(profiles);
  const rows = [];
  for (const node of fleet.nodes) {
    for (const source of [node.daemon, node.bridge]) {
      for (const row of source.sessions ?? []) {
        if (!archived && row.archived) continue;
        if (!profileOk(row.profile)) continue;
        if (!matcher(row.model)) continue;
        rows.push(row);
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Config defaults

function modelKey(key) {
  return /model/i.test(String(key));
}

/**
 * The model references in a settings-like object: strings under keys naming a model (model,
 * defaultModel, describeModel, enabledModels, models, …), and the keys of `modelOverrides`-style
 * objects. A bare id takes its object's `provider` or `defaultProvider`.
 */
export function modelReferences(value, { path = [], refs = [] } = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const label = item && typeof item === "object" && typeof item.name === "string" ? item.name : String(index);
      modelReferences(item, { path: [...path, `[${label}]`], refs });
    });
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  const provider = typeof value.provider === "string" ? value.provider : typeof value.defaultProvider === "string" ? value.defaultProvider : undefined;
  for (const [key, child] of Object.entries(value)) {
    const here = [...path, key];
    if (modelKey(key)) {
      if (typeof child === "string") refs.push({ path: here, text: child, model: parseModelRef(child, provider) });
      else if (Array.isArray(child)) {
        // ["gpt-6-astra", …], or [{ name: "gpt-6.2-astra", … }, …] (Cacophony's providers.pi).
        child.forEach((item, index) => {
          const name = typeof item === "string" ? item : typeof item?.name === "string" ? item.name : typeof item?.id === "string" ? item.id : undefined;
          if (name !== undefined) refs.push({ path: [...here, `[${typeof item === "string" ? index : name}]`], text: name, model: parseModelRef(name, typeof item?.provider === "string" ? item.provider : provider) });
        });
        if (child.every((item) => typeof item === "string")) continue;
      } else if (child && typeof child === "object" && !Array.isArray(child) && /overrides$|^models$/i.test(key)) {
        for (const name of Object.keys(child)) refs.push({ path: [...here, name], text: name, model: parseModelRef(name, provider) });
      }
    }
    if (child && typeof child === "object") modelReferences(child, { path: here, refs });
  }
  return refs;
}

function pathText(path) {
  return path.reduce((text, part) => (part.startsWith("[") ? `${text}${part}` : text ? `${text}.${part}` : part), "");
}

/** Flags: `{ source, where, path, value }`, for the references the matcher matches. */
export function flagReferences(value, matcher, { source, where }) {
  return modelReferences(value)
    .filter((ref) => ref.model && matcher(ref.model))
    .map((ref) => ({ source, ...(where ? { where } : {}), path: pathText(ref.path), value: ref.text }));
}

/** This machine's Pi settings.json, flagged. */
export function settingsDefaults(matcher, { env = process.env, read = readFileSync } = {}) {
  const file = join(agentDirOf(env), "settings.json");
  let settings;
  try {
    settings = JSON.parse(read(file, "utf8"));
  } catch (error) {
    return { flags: [], error: `settings.json: ${error.message}` };
  }
  let where = file;
  try {
    const real = realpathSync(file);
    if (real !== file) where = `${file} → ${real}`;
  } catch {}
  // client.* names hosts and layouts, not models.
  const { client: _client, ...rest } = settings ?? {};
  return { flags: flagReferences(rest, matcher, { source: "settings.json", where }) };
}

/** Each host's pi-daemon profile defaults that match, one flag per profile and model. */
export function profileDefaults(fleet, matcher) {
  const byKey = new Map();
  for (const node of fleet.nodes) {
    for (const profile of node.daemon.profiles ?? []) {
      if (!profile.model || !matcher(profile.model)) continue;
      const key = `${profile.name} ${modelName(profile.model)}`;
      const entry = byKey.get(key) ?? { source: "pi-daemon profile", path: profile.name, value: modelName(profile.model), hosts: [] };
      entry.hosts.push(node.name);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

function runFile(file, args, { env, timeoutMs, maxBuffer = 64 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: timeoutMs, maxBuffer, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...(error && typeof error.code === "string" ? { spawnError: error.code } : {}), ...(error?.killed ? { timedOut: true } : {}) });
    });
  });
}

function cacoBin(env) {
  return env.CACO_BIN || "caco";
}

/** Cacophony's derived config (as the local Cacophony daemon resolves it), flagged; none without caco. */
export async function cacophonyDefaults(matcher, { env = process.env, exec = runFile } = {}) {
  const result = await exec(cacoBin(env), ["config", "show", "--json"], { env, timeoutMs: CACO_CONFIG_TIMEOUT_MS });
  if (result.spawnError === "ENOENT") return { flags: [], skipped: "caco is not installed here" };
  if (result.code !== 0) return { flags: [], error: `caco config show: ${(result.stderr || result.stdout).trim().split("\n").at(-1) || `exit ${result.code}`}` };
  let config;
  try {
    config = JSON.parse(result.stdout);
  } catch (error) {
    return { flags: [], error: `caco config show: ${error.message}` };
  }
  return { flags: flagReferences(config, matcher, { source: "cacophony config" }) };
}

// ---------------------------------------------------------------------------------------------
// Switching

async function limit(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

/** `caco agent set-model` for one agent: `{ ok, effective?, code?, message? }`. */
export async function cacoSetModel(agentId, target, { env = process.env, exec = runFile } = {}) {
  const result = await exec(cacoBin(env), ["agent", "set-model", "--id", agentId, "--model", modelName(target), "--json"], { env, timeoutMs: CACO_SET_MODEL_TIMEOUT_MS });
  if (result.spawnError === "ENOENT") return { ok: false, code: "caco_unavailable", message: "caco is not installed here" };
  if (result.timedOut) return { ok: false, code: "timeout", message: "caco agent set-model timed out; its outcome is unknown" };
  let reply;
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    return { ok: false, code: "caco_failed", message: (result.stderr || result.stdout).trim().split("\n").at(-1) || `exit ${result.code}` };
  }
  const error = reply?.error;
  if (error) return { ok: false, code: String(error.code ?? "caco_failed"), message: String(error.message ?? "refused") };
  const data = reply?.data ?? reply;
  return { ok: true, ...(typeof data?.effective_model === "string" ? { effective: data.effective_model } : {}), metadata: data?.metadata_updated === true };
}

function catalogHas(items, target) {
  return (Array.isArray(items) ? items : []).find((item) => item?.provider === target.provider && item?.modelId === target.modelId);
}

/**
 * Move `sessions` to `target`. Each host's connection is opened once; the target is checked against
 * the session's own catalog (`session.models`: per profile on a daemon, per TUI Pi) first, so a
 * typo never reaches a session. Returns one outcome per session, in order.
 */
export async function switchSessions(sessions, target, { hosts, thinking, dryRun = false, direct = false, connect, env = process.env, exec = runFile, setModel = cacoSetModel } = {}) {
  const outcomes = new Array(sessions.length);
  const hostByName = new Map(hosts.map((host) => [host.name, host]));
  const groups = new Map();
  sessions.forEach((session, index) => {
    const key = `${session.host} ${session.source}`;
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });
  // Cacophony agents, switched through caco after the catalog check: index → session.
  const viaCaco = [];
  await Promise.all([...groups.entries()].map(async ([key, indexes]) => {
    const [hostName, source] = key.split(" ");
    const host = hostByName.get(hostName);
    let client;
    try {
      client = await connectFleetHost(host, source === "tui" ? "bridge" : "daemon", { ...(connect ? { connect } : {}) });
    } catch (error) {
      for (const index of indexes) outcomes[index] = { outcome: "failed", reason: `cannot reach ${hostName}: ${error.message}` };
      return;
    }
    try {
      const catalogs = new Map();
      for (const index of indexes) {
        const session = sessions[index];
        const catalogKey = source === "tui" ? session.id : session.profile;
        let catalog = catalogs.get(catalogKey);
        if (catalog === undefined) {
          try {
            catalog = (await client.call("session.models", { sessionId: session.id }))?.items ?? [];
          } catch (error) {
            catalog = new Error(error.message);
          }
          catalogs.set(catalogKey, catalog);
        }
        if (catalog instanceof Error) {
          outcomes[index] = { outcome: "failed", reason: `cannot read its model list: ${catalog.message}` };
          continue;
        }
        const entry = catalogHas(catalog, target);
        if (!entry) {
          outcomes[index] = { outcome: "failed", reason: `${modelName(target)} is not in ${session.hostLabel}'s ${source === "tui" ? "" : `${session.profile} `}model list` };
          continue;
        }
        if (thinking && Array.isArray(entry.thinkingLevels) && !entry.thinkingLevels.includes(thinking)) {
          outcomes[index] = { outcome: "failed", reason: `${modelName(target)} has no thinking level ${thinking} (${entry.thinkingLevels.join(", ")})` };
          continue;
        }
        if (modelName(session.model) === modelName(target) && (!thinking || session.thinkingLevel === thinking)) {
          outcomes[index] = { outcome: "already on it" };
          continue;
        }
        const route = session.caco && !direct ? "caco" : "chord";
        if (dryRun) {
          outcomes[index] = { outcome: "would switch", route };
          continue;
        }
        if (route === "caco") {
          viaCaco.push(index);
          continue;
        }
        try {
          await client.call("conversation.configure", { sessionId: session.id, model: { provider: target.provider, modelId: target.modelId }, ...(thinking ? { thinkingLevel: thinking } : {}) });
          outcomes[index] = { outcome: "switched", route: "chord" };
        } catch (error) {
          outcomes[index] = { outcome: "failed", route: "chord", reason: error.message };
        }
      }
    } finally {
      client.close();
    }
  }));
  // Cacophony agents: caco agent set-model switches the live runtime and records it; where
  // Cacophony cannot reach the runtime (a finished agent, another runtime mode), /chord does.
  const fallbacks = [];
  await limit(viaCaco, CACO_CONCURRENCY, async (index) => {
    const session = sessions[index];
    const result = await setModel(session.caco.agentId, target, { env, exec });
    if (result.ok) {
      outcomes[index] = { outcome: "switched", route: "caco", ...(result.effective ? { effective: result.effective } : {}) };
      if (thinking) fallbacks.push({ index, thinkingOnly: true });
    } else if (CACO_FALLBACK_CODES.has(result.code)) fallbacks.push({ index, note: `Cacophony: ${result.code}` });
    else outcomes[index] = { outcome: "failed", route: "caco", reason: `caco agent set-model: ${result.code}: ${result.message}${CACO_HINTS[result.code] ?? ""}` };
  });
  if (fallbacks.length) {
    const byHost = new Map();
    for (const fallback of fallbacks) {
      const session = sessions[fallback.index];
      const key = `${session.host} ${session.source}`;
      byHost.set(key, [...(byHost.get(key) ?? []), fallback]);
    }
    await Promise.all([...byHost.entries()].map(async ([key, items]) => {
      const [hostName, source] = key.split(" ");
      let client;
      try {
        client = await connectFleetHost(hostByName.get(hostName), source === "tui" ? "bridge" : "daemon", { ...(connect ? { connect } : {}) });
      } catch (error) {
        for (const item of items) {
          if (item.thinkingOnly) outcomes[item.index] = { ...outcomes[item.index], note: `thinking level not set: cannot reach ${hostName}: ${error.message}` };
          else outcomes[item.index] = { outcome: "failed", route: "chord", reason: `${item.note}; cannot reach ${hostName}: ${error.message}` };
        }
        return;
      }
      try {
        for (const item of items) {
          const session = sessions[item.index];
          const change = item.thinkingOnly ? { thinkingLevel: thinking } : { model: { provider: target.provider, modelId: target.modelId }, ...(thinking ? { thinkingLevel: thinking } : {}) };
          try {
            await client.call("conversation.configure", { sessionId: session.id, ...change });
            if (!item.thinkingOnly) outcomes[item.index] = { outcome: "switched", route: "chord", note: `${item.note}: its Cacophony record still names the old model` };
          } catch (error) {
            if (item.thinkingOnly) outcomes[item.index] = { ...outcomes[item.index], note: `thinking level not set: ${error.message}` };
            else outcomes[item.index] = { outcome: "failed", route: "chord", reason: `${item.note}; ${error.message}` };
          }
        }
      } finally {
        client.close();
      }
    }));
  }
  return outcomes;
}

/** Resolve `--switch` against the hosts' catalogs: `provider/model` as given, a bare id when exactly one provider has it. */
export async function resolveTarget(text, { sessions, hosts, connect } = {}) {
  const parsed = parseModelRef(text);
  if (!parsed) throw new Error(`--switch takes provider/model, not ${text}`);
  if (parsed.provider) return parsed;
  const sample = sessions.find((session) => session.source === "daemon") ?? sessions[0];
  if (!sample) throw new Error(`--switch ${text}: give provider/model`);
  const host = hosts.find((candidate) => candidate.name === sample.host);
  const client = await connectFleetHost(host, sample.source === "tui" ? "bridge" : "daemon", { ...(connect ? { connect } : {}) });
  try {
    const items = (await client.call("session.models", { sessionId: sample.id }))?.items ?? [];
    const providers = [...new Set(items.filter((item) => item?.modelId === parsed.modelId).map((item) => item.provider))];
    if (providers.length === 1) return { provider: providers[0], modelId: parsed.modelId };
    if (!providers.length) throw new Error(`--switch ${text}: no provider on ${sample.hostLabel} has that model`);
    throw new Error(`--switch ${text}: ${providers.map((provider) => `${provider}/${parsed.modelId}`).join(", ")} all have it; say which`);
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Report

export function ago(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function shortCwd(cwd) {
  return String(cwd ?? "").replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}

function sessionLine(row, now) {
  const state = row.working ? " · working" : row.archived ? " · archived" : "";
  const who = row.caco
    ? `Cacophony ${row.caco.project}/${row.caco.agentId}${row.title && row.title !== row.caco.agentId ? ` (${row.title})` : ""}`
    : `${row.title}${row.title !== row.id ? ` · ${row.id}` : ""}${row.cwd ? ` · ${shortCwd(row.cwd)}` : ""}${row.profile ? ` · ${row.profile}` : ""}`;
  return `${modelName(row.model)} · ${ago(now - row.activeAt)}${state} · ${who}`;
}

function windowText(options) {
  return `${options.sinceMs === null ? "any time" : `active within ${ago(options.sinceMs)}`}${options.archived ? "" : ", archived left out"}`;
}

function unreachedText(fleet) {
  const lines = [];
  for (const node of fleet.nodes) {
    if (node.daemon.state !== "ok") lines.push(`${node.name}: ${node.daemon.state}${node.daemon.error ? ` (${node.daemon.error})` : ""}`);
    if (node.bridge.state === "error") lines.push(`${node.name}-tui: error (${node.bridge.error})`);
    if (node.daemon.truncated) lines.push(`${node.name}: stopped after ${MAX_PAGES} pages of sessions; narrow --since`);
  }
  return lines;
}

/** What one `/fleet models` run found, as text. */
export function formatReport(result, { now = Date.now() } = {}) {
  const { options, fleet, sessions, defaults, switched } = result;
  const reached = fleet.nodes.filter((node) => node.daemon.state === "ok").length;
  const unreached = unreachedText(fleet);
  const lines = [];
  if (!options.patterns.length) {
    const byModel = new Map();
    for (const row of sessions) {
      const key = modelName(row.model);
      const entry = byModel.get(key) ?? { count: 0, working: 0, hosts: new Set() };
      entry.count += 1;
      if (row.working) entry.working += 1;
      entry.hosts.add(row.hostLabel);
      byModel.set(key, entry);
    }
    lines.push(`Models in use: ${sessions.length} sessions, ${reached} of ${fleet.nodes.length} hosts read (${windowText(options)})`);
    const width = Math.max(0, ...[...byModel.keys()].map((key) => key.length));
    for (const [key, entry] of [...byModel.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))) {
      const hosts = [...entry.hosts].sort();
      lines.push(`  ${key.padEnd(width)}  ${String(entry.count).padStart(4)}${entry.working ? ` · ${entry.working} working` : ""} · ${hosts.length > 6 ? `${hosts.length} hosts` : hosts.join(", ")}`);
    }
    if (unreached.length) lines.push("", "Not read:", ...unreached.map((line) => `  ${line}`));
    lines.push("", "/fleet models PATTERN lists a model's sessions and the config defaults naming it; --switch provider/model moves them.");
    return lines.join("\n");
  }
  const label = options.patterns.join(" ");
  const hostsWith = new Set(sessions.map((row) => row.hostLabel));
  lines.push(`${label}: ${sessions.length} session${sessions.length === 1 ? "" : "s"} on ${hostsWith.size} host${hostsWith.size === 1 ? "" : "s"}, ${reached} of ${fleet.nodes.length} hosts read (${windowText(options)})`);
  const byHost = new Map();
  sessions.forEach((row, index) => byHost.set(row.hostLabel, [...(byHost.get(row.hostLabel) ?? []), index]));
  for (const [hostLabel, indexes] of [...byHost.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push("", `${hostLabel} (${indexes.length})`);
    for (const index of indexes) {
      const row = sessions[index];
      const outcome = switched?.outcomes?.[index];
      const tail = outcome ? `  → ${outcome.outcome}${outcome.route ? ` (${outcome.route})` : ""}${outcome.reason ? `: ${outcome.reason}` : ""}${outcome.note ? `; ${outcome.note}` : ""}` : "";
      lines.push(`  ${sessionLine(row, now)}${tail}`);
    }
  }
  if (switched) {
    const counts = {};
    for (const outcome of switched.outcomes) counts[outcome.outcome] = (counts[outcome.outcome] ?? 0) + 1;
    const parts = Object.entries(counts).map(([name, count]) => `${count} ${name}`);
    lines.push("", `${switched.dryRun ? "Dry run" : "Switch"} to ${modelName(switched.target)}${switched.thinking ? ` (thinking ${switched.thinking})` : ""}: ${parts.join(", ") || "nothing to do"}.`);
    if (switched.remaining) {
      const left = switched.remaining;
      lines.push(left.length ? `Still on ${label} after the switch: ${left.length} (${left.map((row) => `${row.hostLabel}/${row.id}`).join(", ")}).` : `Read again: no session in the window is on ${label} now.`);
    }
  }
  if (defaults) {
    const flags = defaults.flags;
    lines.push("", flags.length ? `Config defaults naming ${label}:` : `No config default names ${label}.`);
    for (const flag of flags) {
      lines.push(`  ${flag.source}${flag.hosts ? ` on ${flag.hosts.join(", ")}` : ""}: ${flag.path} = ${flag.value}${flag.where ? `  (${flag.where})` : ""}`);
    }
    for (const note of defaults.notes) lines.push(`  ${note}`);
    if (flags.length) lines.push("  These are flagged, not changed: settings.json and pi-daemon profiles come from Collective, Cacophony's from cacophony-config.");
  }
  if (unreached.length) lines.push("", "Not read:", ...unreached.map((line) => `  ${line}`));
  if (!switched && sessions.length) lines.push("", `Move them: /fleet models ${options.patterns.map(quoteWord).join(" ")} --switch provider/model (--dry-run first to see how).`);
  return lines.join("\n");
}

function quoteWord(word) {
  return /^[\w./:@-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** The JSON form of a run (no tokens; session rows, flags and outcomes). */
export function reportJson(result) {
  const { options, fleet, sessions, defaults, switched } = result;
  return {
    patterns: options.patterns,
    sinceMs: options.sinceMs,
    observedAt: fleet.observedAt,
    hosts: fleet.nodes.map((node) => ({ name: node.name, daemon: node.daemon.state, bridge: node.bridge.state, ...(node.daemon.error ? { error: node.daemon.error } : {}) })),
    sessions: sessions.map((row, index) => ({ host: row.hostLabel, id: row.id, title: row.title, cwd: row.cwd, profile: row.profile, model: row.model ? modelName(row.model) : null, thinkingLevel: row.thinkingLevel ?? null, activeAt: row.activeAt, working: row.working, archived: row.archived, ...(row.caco ? { cacophony: row.caco } : {}), ...(switched ? { switch: switched.outcomes[index] } : {}) })),
    ...(defaults ? { configDefaults: defaults.flags, configNotes: defaults.notes } : {}),
    ...(switched ? { target: modelName(switched.target), dryRun: switched.dryRun, ...(switched.remaining ? { remaining: switched.remaining.map((row) => `${row.hostLabel}/${row.id}`) } : {}) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The command

/**
 * One `/fleet` run: `{ text, json, output, failed }`, `output` being the text (the JSON with
 * --json). `deps` injects the effects (connect, exec, settings, env, now, setModel) for tests;
 * `progress` gets a line as each phase starts.
 */
export async function runFleet(args, deps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const progress = deps.progress ?? (() => {});
  const options = parseFleetArgs(args);
  if (options.action === "help") return { text: FLEET_USAGE, json: { usage: FLEET_USAGE }, output: FLEET_USAGE, failed: false };
  const matcher = modelMatcher(options.patterns);
  const hostOk = globTest(options.hosts);
  const hosts = fleetHosts({ env, ...(deps.settings ? { settings: deps.settings } : {}) }).filter((host) => hostOk(host.name) || hostOk(`${host.name}-tui`));
  if (!hosts.length) throw new Error(`no host matches ${options.hosts.join(", ")}`);
  const connect = deps.connect;
  const exec = deps.exec ?? runFile;
  progress(`Reading ${hosts.length} host${hosts.length === 1 ? "" : "s"}…`);
  const wantsDefaults = options.config && options.patterns.length > 0;
  const [fleet, cacoDefaults] = await Promise.all([
    readFleet({ hosts, sinceMs: options.sinceMs, now: now(), ...(connect ? { connect } : {}) }),
    wantsDefaults ? cacophonyDefaults(matcher, { env, exec }) : undefined,
  ]);
  // A host glob may name the TUI side only (ms-mac-tui).
  const sourceOk = (row) => !options.hosts.length || hostOk(row.hostLabel) || (row.source === "daemon" && hostOk(row.host));
  const sessions = selectSessions(fleet, { matcher, profiles: options.profiles, archived: options.archived }).filter(sourceOk).sort((a, b) => a.hostLabel.localeCompare(b.hostLabel) || b.activeAt - a.activeAt);
  const result = { options, fleet, sessions };
  if (wantsDefaults) {
    const local = settingsDefaults(matcher, { env, ...(deps.readFile ? { read: deps.readFile } : {}) });
    const notes = [local.error, cacoDefaults?.error, cacoDefaults?.skipped && `Cacophony config not checked: ${cacoDefaults.skipped}`].filter(Boolean);
    result.defaults = { flags: [...local.flags, ...profileDefaults(fleet, matcher), ...(cacoDefaults?.flags ?? [])], notes };
  }
  let failed = false;
  if (options.switchTo !== undefined && sessions.length) {
    const target = await resolveTarget(options.switchTo, { sessions, hosts, ...(connect ? { connect } : {}) });
    progress(`${options.dryRun ? "Checking" : "Switching"} ${sessions.length} session${sessions.length === 1 ? "" : "s"} to ${modelName(target)}…`);
    const outcomes = await switchSessions(sessions, target, { hosts, thinking: options.thinking, dryRun: options.dryRun, direct: options.direct, env, exec, ...(connect ? { connect } : {}), ...(deps.setModel ? { setModel: deps.setModel } : {}) });
    result.switched = { target, thinking: options.thinking, dryRun: options.dryRun, outcomes };
    failed = outcomes.some((outcome) => outcome.outcome === "failed");
    if (!options.dryRun && outcomes.some((outcome) => outcome.outcome === "switched")) {
      // Read the hosts again: what is still on the old model is the proof.
      const touched = new Set(sessions.map((row) => row.host));
      const again = await readFleet({ hosts: hosts.filter((host) => touched.has(host.name)), sinceMs: options.sinceMs, now: now(), ...(connect ? { connect } : {}) });
      result.switched.remaining = selectSessions(again, { matcher, profiles: options.profiles, archived: options.archived }).filter(sourceOk);
    }
  } else if (options.switchTo !== undefined) {
    result.switched = { target: parseModelRef(options.switchTo) ?? { modelId: options.switchTo }, thinking: options.thinking, dryRun: options.dryRun, outcomes: [] };
  }
  const text = formatReport(result, { now: now() });
  const json = reportJson(result);
  return { text, json, output: options.json ? JSON.stringify(json, null, 2) : text, failed };
}

/** Argument completions for `/fleet`: the subcommand, options, and models from settings.json. */
export function fleetCompletions(prefix, { models = [] } = {}) {
  const text = String(prefix ?? "");
  const words = text.split(/\s+/);
  const last = words.at(-1) ?? "";
  const head = text.slice(0, text.length - last.length);
  const previous = words.at(-2);
  let candidates;
  if (words.length <= 1) candidates = ["models", "help"];
  else if (previous === "--switch" || previous === "--to") candidates = models;
  else if (previous === "--since") candidates = ["7d", "30d", "90d", "all"];
  else if (previous === "--thinking") candidates = THINKING_LEVELS;
  else if (previous === "--profile") candidates = ["cacophony", "personal", "tui"];
  else candidates = ["--switch ", "--dry-run", "--direct", "--thinking ", "--since ", "--host ", "--profile ", "--archived", "--no-config", "--json", ...models.map((model) => model.split("/").pop())];
  const matches = [...new Set(candidates)].filter((word) => word.startsWith(last)).map((word) => ({ value: `${head}${word}`, label: word.trim() }));
  return matches.length ? matches : null;
}

/** settings.json `enabledModels`, for completions; none when unreadable. */
export function enabledModels(env = process.env) {
  try {
    const settings = JSON.parse(readFileSync(join(agentDirOf(env), "settings.json"), "utf8"));
    return Array.isArray(settings?.enabledModels) ? settings.enabledModels.filter((model) => typeof model === "string") : [];
  } catch {
    return [];
  }
}

/** Split text into notices of at most `max` characters, at line ends. */
export function chunkText(text, max = 15_000) {
  const chunks = [];
  let current = "";
  for (const line of String(text).split("\n")) {
    const piece = line.length > max ? `${line.slice(0, max - 1)}…` : line;
    if (current && current.length + 1 + piece.length > max) {
      chunks.push(current);
      current = piece;
    } else current = current ? `${current}\n${piece}` : piece;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}
