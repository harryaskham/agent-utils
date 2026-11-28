// The session of a /git wt fork, made by the module at once (not by a client part later): on
// this host, pi-daemon's own `sessions.create` with `fork` copies the conversation (1.14+); on
// another node, a session made there over its `/chord` and filled with this conversation's model
// context by `conversation.import`, as pi-client's and the web view's cross-host clone do. Every
// client of either host then lists it (pi-client, the web view, Culture, ag), whether or not it
// runs pi-git's client part. Node built-ins and the global WebSocket only.

import { createHash } from "node:crypto";
import { connectHost, localNodeName, readClientSettings, agentDirOf, resolveDaemonHost } from "./daemon-chord.js";
import { forkRoleNote, qaToolNames } from "./fork-lane.js";

/** pi-daemon's host.info capability for `sessions.create`'s `fork` (1.14+). */
export const SESSION_FORK_META = "pi-daemon/sessionFork";
/** pi-daemon's host.info capability for a session's own configuration (its `tools`, bd-a171a8). */
export const SESSION_PROFILE_META = "pi-daemon/sessionProfile";
/** Applying a fork's lane there (pi-git's own command in that session) takes no longer. */
export const LANE_APPLY_TIMEOUT_MS = 60_000;
/** Copying a long conversation takes a while. */
export const FORK_CREATE_TIMEOUT_MS = 5 * 60_000;
const MAX_CONTEXT_PAGES = 1_000;
const MAX_LIST_PAGES = 50;
const COPY_BATCH_MESSAGES = 500;
const COPY_BATCH_BYTES = 8 * 1024 * 1024;

/** Why no session was made: `code` says whether the client part may still make one. */
export class ForkSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The request id of a fork's session: the same fork asked again makes no second session. */
export function forkRequestId(parts) {
  return `pi-git-fork-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

/** A session's model context over /chord, page by page (`conversation.context`), as of one entry. */
export async function readConversationContext(client, sessionId, conversationId) {
  const messages = [];
  let compacted = false;
  let at;
  let cursor;
  for (let page = 0; page < MAX_CONTEXT_PAGES; page += 1) {
    const read = await client.call("conversation.context", {
      sessionId,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(at === undefined ? {} : { at }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!read || !Array.isArray(read.messages)) throw new Error("the host did not return the conversation's context");
    if (page === 0) {
      compacted = read.compacted === true;
      if (typeof read.at === "number") at = read.at;
    }
    messages.push(...read.messages);
    if (typeof read.next !== "string") return { messages, compacted, ...(at === undefined ? {} : { at }) };
    cursor = read.next;
  }
  throw new Error("the conversation's context has too many pages");
}

/** The note after a conversation copied to another host (pi-daemon's cross-host clone's words). */
export function relocationNote(from, to) {
  return {
    role: "user",
    content: [{ type: "text", text: `[Copied from host ${from.host} (cwd ${from.cwd}) to host ${to.host} (cwd ${to.cwd}). Paths, processes, terminals and machine state in the conversation describe ${from.host}; its shared images and audio stay there. Files, commands and project instructions now refer to ${to.host}'s ${to.cwd}.]` }],
    timestamp: Date.now(),
  };
}

/** Messages in `conversation.import` batches: whole messages, within /chord's frame size. */
export function copyBatches(messages) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const message of messages) {
    const size = Buffer.byteLength(JSON.stringify(message));
    if (batch.length > 0 && (batch.length >= COPY_BATCH_MESSAGES || bytes + size > COPY_BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(message);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** A session's catalog row (its profile), paging `sessions.list`; undefined when not found. */
export async function findSessionRow(client, sessionId) {
  let after;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const listed = await client.call("sessions.list", { limit: 200, ...(after === undefined ? {} : { after }) });
    const items = Array.isArray(listed?.items) ? listed.items : [];
    const row = items.find((item) => item?.id === sessionId);
    if (row) return row;
    const next = listed?.next ?? listed?.after;
    if (typeof next !== "string" || next === "" || items.length === 0) return undefined;
    after = next;
  }
  return undefined;
}

const recordOf = (created) => (created && typeof created === "object" && created.session && typeof created.session === "object" ? created.session : created);
const refusedModel = (error) => error?.code === "invalid_argument" && /model|thinking/i.test(String(error.message));
const refusedTools = (error) => /invalid/.test(String(error?.code ?? "")) && /tools/i.test(String(error?.message));
/** Whether a host's sessions.create takes a session's own `tools` (host.info's `_meta`). */
const takesTools = (info) => Array.isArray(info?._meta?.[SESSION_PROFILE_META]?.config) && info._meta[SESSION_PROFILE_META].config.includes("tools");

/** The fork's role note, as a message of its model context (a fork made by import carries it so). */
export function laneMessage(lane) {
  return { role: "user", content: [{ type: "text", text: forkRoleNote(lane) }], timestamp: Date.now() };
}

/**
 * Give a session made just now its lane (bd-fd98a3), by pi-git's own command in it, run there
 * instead of a turn: `/git lane apply LANE` writes the role note (unless `noted`: an import
 * carried it) and keeps the lane for the editor chips. Only when that session has pi-git's
 * `git` command: otherwise the text would be a prompt. "applied", or "no-module".
 */
export async function applyLaneThere(client, sessionId, lane, { requestId, noted = false } = {}) {
  const listed = await client.call("session.commands", { sessionId });
  const items = Array.isArray(listed?.items) ? listed.items : [];
  if (!items.some((command) => command?.name === "git" && command.kind === "extension")) return "no-module";
  const result = await client.call(
    "conversation.submit",
    { sessionId, requestId, content: `/git lane apply ${JSON.stringify({ ...lane, ...(noted ? { noted: true } : {}) })}`, whenBusy: "reject", wait: true },
    { timeoutMs: LANE_APPLY_TIMEOUT_MS },
  );
  if (result && typeof result === "object" && result.command !== undefined && result.command !== "git") throw new Error(`that session ran /${result.command}, not pi-git's /git`);
  return "applied";
}

/** A lane applied there: `{ restricted, applied }`, or `{ restricted, error }` (the session stays). */
async function laneOutcome(client, sessionId, lane, restricted, { requestId, noted }) {
  try {
    return { restricted, applied: await applyLaneThere(client, sessionId, { ...lane, ...(restricted ? { restricted: true } : {}) }, { requestId, noted }) };
  } catch (error) {
    return { restricted, error: error?.message ?? String(error) };
  }
}

/**
 * Make the fork's session now and return `{ id, title, cwd, host? }`: in `path`, titled `title`,
 * with this conversation (`sessionId`, `conversationId`) as of now. `node` is the worktree's
 * other node, if any (`agent`: this conversation's model and thinking level for it). Throws
 * ForkSessionError "unsupported" when this pi-daemon cannot fork sessions, "unknown-host"
 * when `node` is not in client.hosts; anything else is a failure there.
 *
 * On this host the create says how the conversation goes on (`kind: "fork"`: both sessions go
 * on) and which command of a client asked (`requestId`, when the module was told): pi-daemon
 * marks this session with them, and the client that asked follows its own fork while no other
 * is moved (pi-daemon bd-829c1f). A pi-daemon that does not mark ignores both. Across nodes
 * this daemon learns nothing of the session made there, and marks nothing.
 *
 * With a `lane` (bd-fd98a3, fork-lane.js) the session is given it once made (applyLaneThere;
 * across nodes its role note also ends the imported context), and the result says how
 * (`lane: { restricted, applied | error }`). `tools`, for a qa lane, are the built-in tools the
 * session is made with (its own configuration: no edit or write), where its host takes them.
 */
export async function createForkSession({ sessionId, conversationId, fromCwd, path, title, node, at, agent, requestId, lane, tools }, { env = process.env, settings, connect = connectHost } = {}) {
  const hosts = settings ?? readClientSettings(agentDirOf(env));
  const here = resolveDaemonHost("", { settings: hosts, env });
  const local = await connect(here);
  try {
    if (node === undefined || node === here.name) {
      const info = await local.call("host.info", {}).catch(() => undefined);
      if (info?._meta?.[SESSION_FORK_META] !== true) throw new ForkSessionError("unsupported", "this pi-daemon cannot fork sessions (1.14 or later can)");
      const restricted = Array.isArray(tools) && takesTools(info);
      const created = recordOf(await local.call("sessions.create", {
        requestId: forkRequestId(["local", sessionId, conversationId ?? null, path, title, at]),
        fork: {
          sessionId,
          ...(conversationId === undefined ? {} : { conversationId }),
          kind: "fork",
          ...(typeof requestId === "string" && requestId !== "" ? { requestId } : {}),
        },
        cwd: path,
        title,
        ...(restricted ? { tools } : {}),
      }, { timeoutMs: FORK_CREATE_TIMEOUT_MS }));
      if (typeof created?.id !== "string") throw new Error("the host did not return the new session");
      const made = { id: created.id, title, cwd: typeof created.cwd === "string" ? created.cwd : path };
      if (lane === undefined) return made;
      return { ...made, lane: await laneOutcome(local, created.id, lane, restricted, { requestId: forkRequestId(["lane", created.id, at]) }) };
    }
    let target;
    try {
      target = resolveDaemonHost(node, { settings: hosts, env });
    } catch (error) {
      throw new ForkSessionError("unknown-host", error.message);
    }
    const read = await readConversationContext(local, sessionId, conversationId);
    const row = await findSessionRow(local, sessionId).catch(() => undefined);
    const there = await connect(target);
    try {
      const offered = await there.call("profiles.list", {}).then((listed) => (Array.isArray(listed?.items) ? listed.items.map((item) => item.name) : undefined), () => undefined);
      const profile = typeof row?.profile === "string" && (offered === undefined || offered.includes(row.profile)) ? row.profile : undefined;
      const model = agent?.model && typeof agent.model.provider === "string" ? `${agent.model.provider}/${agent.model.modelId ?? agent.model.id}` : undefined;
      const thinking = typeof agent?.thinkingLevel === "string" ? agent.thinkingLevel : undefined;
      const requestId = forkRequestId(["across", here.name, sessionId, conversationId ?? null, read.at ?? read.messages.length, node, path, title, at]);
      let params = {
        requestId,
        cwd: path,
        title,
        ...(profile === undefined ? {} : { profile }),
        ...(model === undefined ? {} : { model }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(Array.isArray(tools) ? { tools } : {}),
      };
      let created;
      for (;;) {
        try {
          created = recordOf(await there.call("sessions.create", params));
          break;
        } catch (error) {
          // That host lacks this model (its default then), or takes no such tools (its profile's then).
          if (refusedModel(error) && (params.model !== undefined || params.thinking !== undefined)) {
            const { model: _model, thinking: _thinking, ...rest } = params;
            params = rest;
          } else if (refusedTools(error) && params.tools !== undefined) {
            // A tool that host's profile lacks is left out; one it cannot name, all of them.
            const named = /tools: "([^"]+)"/.exec(String(error.message))?.[1];
            const kept = named !== undefined && params.tools.includes(named) ? params.tools.filter((tool) => tool !== named) : [];
            const { tools: _tools, ...rest } = params;
            params = kept.length > 0 ? { ...rest, tools: kept } : rest;
          } else throw error;
        }
      }
      const restricted = params.tools !== undefined;
      if (typeof created?.id !== "string") throw new Error(`${node} did not return the new session`);
      const cwd = typeof created.cwd === "string" && created.cwd !== "" ? created.cwd : path;
      const messages = [...read.messages, relocationNote({ host: here.name, cwd: fromCwd }, { host: node, cwd })];
      if (lane !== undefined) messages.push(laneMessage({ ...lane, ...(restricted ? { restricted: true } : {}) }));
      try {
        const batches = copyBatches(messages);
        for (const [index, batch] of batches.entries()) {
          await there.call("conversation.import", {
            sessionId: created.id,
            importId: `import-${requestId}`,
            index,
            messages: batch,
            final: index === batches.length - 1,
            ...(index === 0 && read.compacted ? { compacted: true } : {}),
          }, { timeoutMs: FORK_CREATE_TIMEOUT_MS });
        }
      } catch (error) {
        await there.call("sessions.dispose", { sessionId: created.id }).catch(() => undefined);
        throw new Error(`copying this conversation to ${node} failed: ${error.message}`);
      }
      const made = { id: created.id, title, cwd, host: node };
      if (lane === undefined) return made;
      return { ...made, lane: await laneOutcome(there, created.id, lane, restricted, { requestId: forkRequestId(["lane", node, created.id, at]), noted: true }) };
    } finally {
      there.close();
    }
  } finally {
    local.close();
  }
}

/**
 * The pi-git module's call: this command's conversation, or "unsupported" without pi-daemon's
 * harness. A qa `lane` makes the session with this one's built-in tools less edit and write.
 */
export async function forkSessionFor(ctx, { path, title, node, at, lane }, options = {}) {
  if (!ctx?.sessionId || typeof ctx.harness?.conversation !== "function") throw new ForkSessionError("unsupported", "this pi-daemon gives module commands no harness");
  let agent;
  if (node !== undefined || lane?.mode === "qa") {
    const conversation = await ctx.harness.conversation(ctx.conversationId, ctx.context).catch(() => undefined);
    agent = await conversation?.agent?.(ctx.context).catch(() => undefined);
  }
  const tools = lane?.mode === "qa" ? qaToolNames(agent) : undefined;
  // This worker's own variables win: PI_DAEMON_URL is its own host's, whatever the session sets.
  const env = typeof ctx.env?.all === "function" ? { ...(await ctx.env.all().catch(() => ({}))), ...process.env } : process.env;
  // The id of the client's command that runs this (pi-daemon 1.15 tells module commands theirs).
  const requestId = typeof ctx.requestId === "string" ? ctx.requestId : undefined;
  return createForkSession(
    {
      sessionId: ctx.sessionId,
      conversationId: ctx.conversationId,
      fromCwd: ctx.cwd,
      path,
      title,
      node,
      at,
      agent,
      ...(requestId === undefined ? {} : { requestId }),
      ...(lane === undefined ? {} : { lane }),
      ...(tools === undefined ? {} : { tools }),
    },
    { env, ...options },
  );
}

export { localNodeName };
