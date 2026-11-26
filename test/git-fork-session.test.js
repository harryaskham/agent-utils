// /git wt fork makes the fork's session itself (./extensions/lib/fork-session.js): on this host
// by pi-daemon's sessions.create with fork, on another node by create and conversation.import
// there; the module records it, and pi-git's client part opens it rather than making another.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ForkSessionError, SESSION_FORK_META, copyBatches, createForkSession, forkRequestId, forkSessionFor, readConversationContext } from "../extensions/lib/fork-session.js";
import { createGitCommands, createGitRefresher } from "../extensions/lib/durable-git.js";
import gitClient from "../extensions/durable/git-client.js";

const exec = promisify(execFile);
const settings = { hosts: [{ name: "helsinki", url: "ws://helsinki:7463" }], tokenFile: "~/t" };
const env = { PI_DAEMON_NODE: "aurora", PI_DAEMON_URL: "http://127.0.0.1:7463" };

/** Fake /chord hosts by name: each answers `handlers[method](params, options)`, and records calls. */
function fakeHosts(byHost) {
  const calls = [];
  const closed = [];
  const connect = async (host) => ({
    async call(method, params, options) {
      calls.push({ host: host.name, method, params, ...(options ? { options } : {}) });
      const handler = byHost[host.name]?.[method];
      if (!handler) throw Object.assign(new Error(`method_not_found: ${method}`), { code: "method_not_found" });
      return handler(params, options);
    },
    close: () => closed.push(host.name),
  });
  return { calls, closed, connect };
}

test("a fork on this host is pi-daemon's own sessions.create with fork, idempotent by its request id", async () => {
  const { calls, closed, connect } = fakeHosts({
    aurora: {
      "host.info": () => ({ _meta: { [SESSION_FORK_META]: true } }),
      "sessions.create": (params) => ({ session: { id: "chord-new", cwd: params.cwd } }),
    },
  });
  const made = await createForkSession({ sessionId: "chord-src", conversationId: 3, fromCwd: "/w", path: "/wt/x", title: "x", at: 5 }, { env, settings, connect });
  assert.deepEqual(made, { id: "chord-new", title: "x", cwd: "/wt/x" });
  const create = calls.find((call) => call.method === "sessions.create");
  assert.deepEqual(create.params, { requestId: forkRequestId(["local", "chord-src", 3, "/wt/x", "x", 5]), fork: { sessionId: "chord-src", conversationId: 3 }, cwd: "/wt/x", title: "x" });
  assert.equal(create.options.timeoutMs, 300_000, "copying a long conversation may take minutes");
  assert.deepEqual(closed, ["aurora"]);
  assert.match(forkRequestId(["a"]), /^pi-git-fork-[0-9a-f]{32}$/);
  assert.equal(forkRequestId(["a"]), forkRequestId(["a"]));

  const old = fakeHosts({ aurora: { "host.info": () => ({ _meta: {} }) } });
  await assert.rejects(createForkSession({ sessionId: "s", path: "/wt/x", title: "x", at: 1 }, { env, settings, connect: old.connect }), (error) => error instanceof ForkSessionError && error.code === "unsupported");
  assert.equal(old.calls.some((call) => call.method === "sessions.create"), false);
});

test("a fork on another node: this context read here, a session made there like this one, the context imported with a note", async () => {
  const pages = { undefined: { messages: [{ role: "user", content: "one" }], compacted: true, at: 41, next: "p2" }, p2: { messages: [{ role: "assistant", content: [] }] } };
  const imported = [];
  const { calls, closed, connect } = fakeHosts({
    aurora: {
      "conversation.context": (params) => pages[params.cursor],
      "sessions.list": (params) => (params.after === undefined ? { items: [{ id: "other" }], next: "c2" } : { items: [{ id: "chord-src", profile: "personal" }] }),
    },
    helsinki: {
      "profiles.list": () => ({ items: [{ name: "personal" }, { name: "cacophony" }] }),
      "sessions.create": (params) => {
        if (params.model) throw Object.assign(new Error("invalid_argument: unknown model"), { code: "invalid_argument" });
        return { id: "chord-there", cwd: "/home/h/wt/x" };
      },
      "conversation.import": (params) => (imported.push(params), null),
    },
  });
  const agent = { model: { provider: "github-copilot", modelId: "claude-opus-5.5" }, thinkingLevel: "high" };
  const made = await createForkSession({ sessionId: "chord-src", conversationId: 1, fromCwd: "/w/project", path: "/home/h/wt/x", title: "x", node: "helsinki", at: 9, agent }, { env, settings, connect });
  assert.deepEqual(made, { id: "chord-there", title: "x", cwd: "/home/h/wt/x", host: "helsinki" });
  assert.deepEqual(calls.filter((call) => call.method === "conversation.context").map((call) => call.params), [{ sessionId: "chord-src", conversationId: 1 }, { sessionId: "chord-src", conversationId: 1, at: 41, cursor: "p2" }]);
  const creates = calls.filter((call) => call.method === "sessions.create").map((call) => call.params);
  assert.equal(creates[0].model, "github-copilot/claude-opus-5.5");
  assert.equal(creates[0].thinking, "high");
  assert.equal(creates[0].profile, "personal");
  assert.deepEqual(creates[1], { requestId: creates[0].requestId, cwd: "/home/h/wt/x", title: "x", profile: "personal" }, "that host's default model, same request id");
  assert.equal(imported.length, 1);
  assert.deepEqual([imported[0].sessionId, imported[0].index, imported[0].final, imported[0].compacted, imported[0].importId], ["chord-there", 0, true, true, `import-${creates[0].requestId}`]);
  assert.equal(imported[0].messages.length, 3);
  assert.match(imported[0].messages[2].content[0].text, /^\[Copied from host aurora \(cwd \/w\/project\) to host helsinki \(cwd \/home\/h\/wt\/x\)\./);
  assert.deepEqual(closed.sort(), ["aurora", "helsinki"]);
});

test("a fork on another node: an unknown host, and a failed import that removes the session made there", async () => {
  const none = fakeHosts({});
  await assert.rejects(createForkSession({ sessionId: "s", path: "/p", title: "x", node: "nowhere", at: 1 }, { env, settings, connect: none.connect }), (error) => error.code === "unknown-host" && /client\.hosts has helsinki/.test(error.message));
  const disposed = [];
  const failing = fakeHosts({
    aurora: { "conversation.context": () => ({ messages: [] }), "sessions.list": () => ({ items: [] }) },
    helsinki: {
      "profiles.list": () => ({ items: [{ name: "cacophony" }] }),
      "sessions.create": () => ({ session: { id: "chord-there" } }),
      "conversation.import": () => { throw new Error("closed"); },
      "sessions.dispose": (params) => (disposed.push(params.sessionId), null),
    },
  });
  await assert.rejects(createForkSession({ sessionId: "s", path: "/p", title: "x", node: "helsinki", at: 1 }, { env, settings, connect: failing.connect }), /copying this conversation to helsinki failed: closed/);
  assert.deepEqual(disposed, ["chord-there"]);
  assert.equal(failing.calls.find((call) => call.method === "sessions.create").params.profile, undefined, "a profile that host lacks is left to its default");
});

test("context pages, copy batches and the module's call", async () => {
  await assert.rejects(readConversationContext({ call: async () => ({}) }, "s"), /did not return the conversation's context/);
  const big = { role: "user", content: "x".repeat(5 * 1024 * 1024) };
  assert.deepEqual(copyBatches([big, big, { role: "user", content: "y" }]).map((batch) => batch.length), [1, 2]);
  assert.deepEqual(copyBatches(Array.from({ length: 1001 }, () => ({ role: "user", content: "z" }))).map((batch) => batch.length), [500, 500, 1]);
  await assert.rejects(forkSessionFor({ sessionId: "s" }, { path: "/p", title: "x", at: 1 }), (error) => error.code === "unsupported");
  // The worker's own PI_DAEMON_URL wins over the session's variables.
  const seen = [];
  const connect = async (host) => (seen.push(host.url), { call: async (method) => (method === "host.info" ? { _meta: { [SESSION_FORK_META]: true } } : { id: "n" }), close() {} });
  const ctx = { sessionId: "s", conversationId: 1, cwd: "/w", harness: { conversation: async () => ({}) }, env: { all: async () => ({ PI_DAEMON_URL: "http://elsewhere:1" }) } };
  const before = process.env.PI_DAEMON_URL;
  process.env.PI_DAEMON_URL = "http://127.0.0.1:7999";
  try {
    assert.deepEqual(await forkSessionFor(ctx, { path: "/p", title: "x", at: 1 }, { settings: { hosts: [] }, connect }), { id: "n", title: "x", cwd: "/p" });
  } finally {
    if (before === undefined) delete process.env.PI_DAEMON_URL;
    else process.env.PI_DAEMON_URL = before;
  }
  assert.deepEqual(seen, ["http://127.0.0.1:7999"]);
});

async function gitRepo(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-git-session-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "project");
  const git = (...args) => exec("git", args, { cwd: root });
  await exec("git", ["init", "-q", "-b", "main", root]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await writeFile(join(root, "a.txt"), "a\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "first");
  return { dir, root };
}

function memoryState() {
  const values = new Map();
  return { values, get: async (key) => values.get(key), set: async (key, value) => void values.set(key, value) };
}

test("/git wt fork records the session it made for the client part, and says so; --no-session and failures", async (t) => {
  const { dir, root } = await gitRepo(t);
  const asked = [];
  let answer = (fork) => ({ id: "chord-made", title: fork.title, cwd: fork.path });
  const forkSession = async (_ctx, fork) => (asked.push(fork), answer(fork));
  const state = memoryState();
  const notices = [];
  const ctx = { sessionId: "s", conversationId: 1, cwd: root, state, notify: (text) => notices.push(text), env: { get: async () => ({}) } };
  const { git } = createGitCommands(createGitRefresher(), { root: join(dir, "worktrees"), forkSession });

  await git.run("wt fork feature/x", ctx);
  const path = join(dir, "worktrees", "project", "feature-x");
  assert.deepEqual(asked.map(({ path: where, title, node, noSession }) => [where, title, node, noSession]), [[path, "feature/x", undefined, false]]);
  assert.deepEqual(state.values.get("forked").session, { id: "chord-made", title: "feature/x" });
  assert.equal(notices.at(-1), `Worktree ${path} on new branch feature/x. Session "feature/x" there has this conversation; every client lists it.`);

  await git.run("wt fork bare --no-session", ctx);
  assert.equal(asked.length, 1, "no session asked for");
  assert.equal(state.values.get("forked").noSession, true);
  assert.equal(state.values.get("forked").session, undefined);
  assert.match(notices.at(-1), /on new branch bare\. No session \(--no-session\): \/cd .*\/bare continues this conversation there\.$/);

  answer = () => { throw new Error("timed out"); };
  await git.run("wt fork late", ctx);
  assert.equal(state.values.get("forked").session, undefined, "the client part may still make one");
  assert.match(notices.at(-1), /on new branch late\. No session was made there \(timed out\): \/cd .*\/late continues this conversation there\.$/);
  assert.match(git.description, /--no-session/);
});

test("the client part opens the session the module made, on its host, and makes none of its own", async () => {
  const handlers = new Map();
  const watches = [];
  const opened = [];
  const created = [];
  const notices = [];
  const ctx = {
    sessionManager: { getSessionId: () => "a" },
    chord: { async watchDocument(_address, onValue) { watches.push(onValue); return () => {}; } },
    sessions: { create: async (options) => created.push(options), open: async (session) => opened.push(session) },
    ui: { notify: (text) => notices.push(text) },
  };
  gitClient({ on: (type, handler) => handlers.set(type, handler), events: { on() {}, emit() {} } });
  await handlers.get("session_start")({}, ctx);
  await Promise.resolve();
  watches[0]({ values: {} });
  watches[0]({ values: { forked: { path: "/wt/x", branch: "x", at: 2, session: { id: "chord-made", title: "x" } } } });
  await Promise.resolve();
  watches[0]({ values: { forked: { path: "/h/wt/y", branch: "y", host: "helsinki", at: 3, session: { id: "chord-there", title: "y", host: "helsinki" } } } });
  await Promise.resolve();
  watches[0]({ values: { forked: { path: "/wt/z", branch: "z", at: 4, noSession: true } } });
  await Promise.resolve();
  assert.deepEqual(opened, [{ id: "chord-made" }, { id: "chord-there", host: "helsinki" }]);
  assert.deepEqual(created, []);
  assert.deepEqual(notices, []);

  // A client without ctx.sessions.open: where to find it.
  delete ctx.sessions.open;
  watches[0]({ values: { forked: { path: "/wt/w", branch: "w", at: 5, session: { id: "chord-w", title: "w" } } } });
  await Promise.resolve();
  assert.deepEqual(notices, ["Session w is ready in w: pick it in the session list."]);
  assert.deepEqual(created, []);
});
