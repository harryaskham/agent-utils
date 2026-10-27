import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createGitCommands,
  createGitObserver,
  createGitRefresher,
  parseNumstat,
  parseStatus,
  parseWorktrees,
  createGitTrackTool,
  readWorkspace,
  refreshTracked,
  TRACKED_DOC,
  workspacePanel,
  workspaceSummary,
} from "../extensions/lib/durable-git.js";
import gitClient from "../extensions/durable/git-client.js";
import { GIT_EVENT, GIT_REQUEST, GIT_STATE_DOC } from "../extensions/lib/git-indicator.js";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();

async function repo(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-git-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "project");
  execFileSync("mkdir", ["-p", root]);
  git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "a.txt"), "one\ntwo\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "init");
  return { dir, root };
}

function memoryState() {
  const values = new Map();
  return { values, get: async (key) => values.get(key), set: async (key, value) => void (value === undefined ? values.delete(key) : values.set(key, value)) };
}

test("git's porcelain status, numstat and worktree list are summarised", () => {
  const status = parseStatus(
    ["# branch.oid abc123", "# branch.head feature", "# branch.upstream origin/feature", "# branch.ab +2 -1", "1 M. N... 100644 100644 100644 a b x.txt", "1 .M N... 100644 100644 100644 a b y.txt", "2 R. N... 100644 100644 100644 a b R100 n.txt\to.txt", "u UU N... 1 2 3 4 a b c z.txt", "? new.txt", "? other.txt"].join("\n"),
  );
  assert.deepEqual(status, { branch: "feature", detached: false, oid: "abc123", upstream: "origin/feature", ahead: 2, behind: 1, staged: 2, unstaged: 1, untracked: 2, conflicts: 1 });
  assert.equal(parseStatus("# branch.oid (initial)\n# branch.head (detached)").detached, true);
  assert.deepEqual(parseNumstat("3\t1\ta\n-\t-\tbin\n10\t0\tb\n"), { additions: 13, deletions: 1 });
  assert.deepEqual(parseWorktrees("worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /w\nHEAD bbb\ndetached\n"), [
    { path: "/r", branch: "main", head: "aaa", detached: false },
    { path: "/w", branch: "", head: "bbb", detached: true },
  ]);
});

test("a repository's state: branch, changes, lines; a directory outside one is no repository", async (t) => {
  const { dir, root } = await repo(t);
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\n");
  await writeFile(join(root, "new.txt"), "x\n");
  const workspace = await readWorkspace(root);
  assert.equal(workspace.repo, true);
  assert.equal(workspace.root, root);
  assert.equal(workspace.project, "project");
  assert.equal(workspace.branch, "main");
  assert.equal(workspace.worktree, false);
  assert.equal(workspace.unstaged, 1);
  assert.equal(workspace.untracked, 1);
  assert.deepEqual([workspace.additions, workspace.deletions], [2, 1]);
  assert.match(workspaceSummary(workspace), /^main · 1 modified, 1 untracked \(\+2 −1\)$/);
  assert.deepEqual(await readWorkspace(dir), { repo: false });
});

test("the refresher: a newer refresh supersedes one in flight, a slow repository backs off, a timeout keeps the last state", async () => {
  let clock = 1_000;
  const now = () => clock;
  const pending = [];
  // A git that answers when told to, and honours aborts.
  const run = (args, { signal }) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason));
      pending.push(() => resolve(args[0] === "rev-parse" && args[1] === "--show-toplevel" ? { code: 0, stdout: "/r\n/r/.git\n/r/.git\n" } : args[0] === "status" ? { code: 0, stdout: "# branch.oid a\n# branch.head main\n" } : { code: 0, stdout: "" }));
    });
  // Answer git until `promise` settles (the refresher also awaits the file system).
  const drive = async (promise) => {
    let settled = false;
    promise.then(() => (settled = true), () => (settled = true));
    for (let i = 0; i < 2_000 && !settled; i += 1) {
      if (pending.length > 0) pending.shift()();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return promise;
  };
  const refresher = createGitRefresher({ run, now, timeoutMs: 60_000, slowMs: 1_500 });
  const state = memoryState();
  const info = { cwd: "/tmp", state };
  const first = refresher.refresh("s", info);
  const second = refresher.refresh("s", info);
  assert.equal(await drive(first), undefined, "superseded");
  const written = await drive(second);
  assert.equal(written.branch, "main");
  assert.equal(state.values.get("workspace").branch, "main");

  // A refresh that took 3 s: the next automatic one waits; a forced one does not.
  clock += 10;
  const slow = refresher.refresh("s", info);
  clock += 3_000;
  assert.ok(await drive(slow));
  assert.equal(await refresher.refresh("s", info), undefined, "backing off");
  assert.ok(await drive(refresher.refresh("s", info, { force: true })));

  // A git that never answers: killed at the timeout; the last state stays, marked.
  const stuck = createGitRefresher({ run: (_args, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))), timeoutMs: 20 });
  const kept = memoryState();
  await kept.set("workspace", { repo: true, branch: "old" });
  assert.equal(await stuck.refresh("t", { cwd: "/tmp", state: kept }), undefined);
  assert.equal(kept.values.get("workspace").branch, "old");
  assert.equal(kept.values.get("workspace").error, "timeout");
});

test("the observer refreshes after a turn ends, without waiting for git", () => {
  const calls = [];
  const observe = createGitObserver({ refresh: (sessionId, info) => (calls.push([sessionId, info.cwd]), new Promise(() => {})) });
  assert.equal(observe({ type: "tool_execution_end" }, { sessionId: "s", cwd: "/w" }), undefined);
  assert.equal(observe({ type: "agent_end" }, { sessionId: "s", cwd: "/w" }), undefined);
  assert.deepEqual(calls, [["s", "/w"]]);
});

test("/git status, /git wt fork NAME and /git wt list", async (t) => {
  const { dir, root } = await repo(t);
  const state = memoryState();
  const notices = [];
  const ctx = { sessionId: "s", cwd: root, state, notify: (text) => notices.push(text), env: { get: async () => ({}) } };
  const { git: command } = createGitCommands(createGitRefresher(), { root: join(dir, "worktrees") });
  await command.run("", ctx);
  assert.equal(notices.at(-1), "main · clean");
  await command.run("wt fork feature/x", ctx);
  const forked = state.values.get("forked");
  assert.equal(forked.path, join(dir, "worktrees", "project", "feature-x"));
  assert.equal(forked.branch, "feature/x");
  assert.equal(forked.created, true);
  const there = await readWorkspace(forked.path);
  assert.equal(there.branch, "feature/x");
  assert.equal(there.worktree, true);
  assert.equal(there.mainRoot, root);
  await command.run("wt list", ctx);
  assert.match(notices.at(-1), /feature-x\s+feature\/x/);
  await command.run("wt fork ../escape", ctx).catch((error) => notices.push(error.message));
  assert.match(notices.at(-1), /not a usable/);
});

test("the client part publishes each session's git state, and opens a session for a fork made while it follows", async () => {
  const handlers = new Map();
  const bus = new Map();
  const events = { on: (name, listener) => bus.set(name, [...(bus.get(name) ?? []), listener]), emit: (name, data) => (bus.get(name) ?? []).forEach((listener) => listener(data)) };
  const published = [];
  events.on(GIT_EVENT, (data) => published.push(data));
  const watches = [];
  const created = [];
  let current = "a";
  const ctx = {
    sessionManager: { getSessionId: () => current },
    chord: { async watchDocument(address, onValue) { watches.push({ session: current, address, onValue }); return () => {}; } },
    sessions: { create: async (options) => created.push(options) },
    ui: { notify() {} },
  };
  gitClient({ on: (type, handler) => handlers.set(type, handler), events });
  await handlers.get("session_start")({}, ctx);
  await Promise.resolve();
  assert.deepEqual(watches[0].address, GIT_STATE_DOC);
  // An old fork in the first value is history; a new one opens a session there.
  watches[0].onValue({ values: { workspace: { repo: true, branch: "main" }, forked: { path: "/old", branch: "old", at: 1 } } });
  assert.deepEqual(published.at(-1), { sessionId: "a", workspace: { repo: true, branch: "main" } });
  assert.deepEqual(created, []);
  watches[0].onValue({ values: { workspace: { repo: true, branch: "main" }, forked: { path: "/wt/x", branch: "x", at: 2 } } });
  await Promise.resolve();
  assert.deepEqual(created, [{ cwd: "/wt/x", title: "x", carry: true }]);
  // A consumer drawing another session's pane: followed when the live ctx is that session's.
  events.emit(GIT_REQUEST, { sessionId: "b" });
  assert.equal(watches.length, 1);
  current = "b";
  events.emit(GIT_REQUEST, { sessionId: "b" });
  await Promise.resolve();
  assert.equal(watches[1].session, "b");
});

test("pi-client's sidebar rows can show a followed session's branch and repo (pi-daemon bd-8e7f67)", async () => {
  const handlers = new Map();
  const segments = new Map();
  const watches = [];
  let renders = 0;
  const ctx = {
    sessionManager: { getSessionId: () => "a" },
    chord: { async watchDocument(_address, onValue) { watches.push(onValue); return () => {}; } },
    ui: { notify() {}, requestRender: () => { renders += 1; } },
  };
  gitClient({ on: (type, handler) => handlers.set(type, handler), events: { on() {}, emit() {} }, registerSidebarSegment: (name, segment) => segments.set(name, segment) });
  assert.deepEqual([...segments.keys()], ["branch", "repo"]);
  await handlers.get("session_start")({}, ctx);
  await Promise.resolve();
  const branch = segments.get("branch");
  const repoName = segments.get("repo");
  assert.equal(branch({ id: "a" }), undefined, "nothing until its state arrives");
  watches[0]({ values: { workspace: { repo: true, branch: "main", project: "pi-daemon" } } });
  assert.deepEqual([branch({ id: "a" }), repoName({ id: "a" }), branch({ id: "other" })], ["⎇ main", "pi-daemon", undefined]);
  assert.ok(renders > 0, "a change redraws");
  watches[0]({ values: { workspace: { repo: true, oid: "0123456789abcdef", project: "pi-daemon" } } });
  assert.equal(branch({ id: "a" }), "⎇ detached 01234567");
  watches[0]({ values: { workspace: { repo: false } } });
  assert.deepEqual([branch({ id: "a" }), repoName({ id: "a" })], [undefined, undefined], "not a repository");
});

test("a repository's state lists its worktrees, main first; its panel shows branch, upstream, changes and worktree", async (t) => {
  const { dir, root } = await repo(t);
  const tree = join(dir, "feature");
  git(root, "worktree", "add", "-q", "-b", "feature", tree);
  const workspace = await readWorkspace(tree);
  assert.deepEqual(workspace.worktrees, [root, tree]);
  assert.equal(workspace.worktree, true);
  assert.deepEqual(workspacePanel(workspace), ["⎇ feature  project", "  clean", "  worktree of project"]);
  assert.deepEqual(
    workspacePanel({ repo: true, branch: "main", project: "p", upstream: "origin/main", ahead: 2, behind: 1, unstaged: 3, additions: 4, deletions: 5 }),
    ["⎇ main  p", "  ↑2 ↓1 origin/main", "  3 modified +4 −5"],
  );
  assert.equal(workspacePanel({ repo: false }), undefined);
});

test("the client part shows the focused session's repository in pi-client's sidebar, and /repo switches within it", async () => {
  const handlers = new Map();
  const commands = new Map();
  const bus = new Map();
  const events = { on: (name, listener) => bus.set(name, [...(bus.get(name) ?? []), listener]), emit: (name, data) => (bus.get(name) ?? []).forEach((listener) => listener(data)) };
  const watches = [];
  const panels = [];
  const opened = [];
  let current = "a";
  let choose = (labels) => labels[0];
  const rows = [
    { host: "local", id: "a", title: "This", cwd: "/src/project", activeAt: 5 },
    { host: "local", id: "b", title: "Feature work", cwd: "/wt/project-feature/sub", activeAt: 4 },
    { host: "local", id: "c", title: "Older", cwd: "/src/project/docs", activeAt: 1 },
    { host: "remote", id: "d", title: "Same path elsewhere", cwd: "/src/project", activeAt: 9 },
    { host: "local", id: "e", title: "Archived", cwd: "/src/project", activeAt: 9, archived: true },
    { host: "local", id: "f", title: "Unrelated", cwd: "/src/other", activeAt: 9 },
  ];
  const ctx = {
    sessionManager: { getSessionId: () => current },
    chord: { async watchDocument(address, onValue) { watches.push({ session: current, onValue }); return () => {}; } },
    sessions: { list: () => rows, open: async (row) => opened.push(row.id), create: async () => {} },
    ui: {
      hasSidebar: true,
      notify() {},
      setWidget: (key, lines, options) => panels.push({ key, lines, placement: options?.placement }),
      select: async (_title, labels) => choose(labels),
    },
  };
  gitClient({ on: (type, handler) => handlers.set(type, handler), registerCommand: (name, command) => commands.set(name, command), events });
  await handlers.get("session_start")({}, ctx);
  await Promise.resolve();
  const workspace = { repo: true, branch: "main", project: "project", mainRoot: "/src/project", worktrees: ["/src/project", "/wt/project-feature"], unstaged: 1, additions: 2, deletions: 0 };
  watches[0].onValue({ values: { workspace } });
  assert.deepEqual(panels, [{ key: "pi-git", lines: ["⎇ main  project", "  1 modified +2 −0"], placement: "sidebar" }]);
  // The same state again: not set again.
  watches[0].onValue({ values: { workspace } });
  assert.equal(panels.length, 1);

  // /repo: this repository's other sessions on this host, newest first; the chosen one opens.
  let offered;
  choose = (labels) => {
    offered = labels;
    return labels[1];
  };
  await commands.get("repo").handler("", ctx);
  assert.deepEqual(offered, ["1. Feature work · project-feature", "2. Older · project"]);
  assert.deepEqual(opened, ["c"]);

  // Focus moves to a session whose state has not arrived: the panel is cleared.
  current = "z";
  events.emit(GIT_REQUEST, { sessionId: "z" });
  assert.deepEqual(panels.at(-1), { key: "pi-git", lines: undefined, placement: "sidebar" });

  // Without pi-client's sidebar (TUI Pi, an earlier pi-client), no panel is set.
  const plain = [];
  const handlers2 = new Map();
  gitClient({ on: (type, handler) => handlers2.set(type, handler), events: { on() {}, emit() {} } });
  const watches2 = [];
  await handlers2.get("session_start")({}, {
    sessionManager: { getSessionId: () => "a" },
    chord: { async watchDocument(_address, onValue) { watches2.push(onValue); return () => {}; } },
    ui: { notify() {}, setWidget: (...args) => plain.push(args) },
  });
  await Promise.resolve();
  watches2[0]({ values: { workspace } });
  assert.deepEqual(plain, []);
});

test("/git completes its subcommands as Pi's commands do", () => {
  const { git } = createGitCommands(createGitRefresher());
  assert.deepEqual(git.getArgumentCompletions("").map((item) => item.value), ["status", "wt list", "wt fork "]);
  assert.deepEqual(git.getArgumentCompletions("wt f").map((item) => item.value), ["wt fork "]);
  assert.deepEqual(git.getArgumentCompletions("nope"), []);
});

test("git_track follows another repository: recorded in the session's document, refreshed after a turn, shown in the panel", async (t) => {
  const { dir, root } = await repo(t);
  const other = join(dir, "other");
  execFileSync("mkdir", ["-p", join(other, "sub")]);
  git(other, "init", "-q", "-b", "trunk");
  await writeFile(join(other, "b.txt"), "b\n");
  git(other, "add", "b.txt");
  git(other, "commit", "-q", "-m", "init");
  // A Durable session as far as the tool and the observer use it.
  const docs = new Map();
  const tx = { async doc(token) { if (!docs.has(token.definition.kind)) docs.set(token.definition.kind, token.definition.initial()); return docs.get(token.definition.kind); } };
  const api = {
    env: { absolutePath: async (path) => ({ ok: true, value: path.startsWith("/") ? path : join(root, path) }) },
    commit: async (change) => JSON.parse(JSON.stringify((await change(tx)) ?? null)),
  };
  const tool = createGitTrackTool();
  const followed = await tool.execute({ path: "../other/sub" }, api, {});
  assert.equal(followed.isError, undefined);
  assert.equal(followed.output[0].text, `Following ${other}: trunk · clean.`);
  assert.deepEqual(followed.content, followed.output);
  assert.deepEqual(docs.get(TRACKED_DOC.definition.kind).paths, [other]);
  assert.equal((await tool.execute({}, api, {})).output[0].text, `Following: ${other}`);
  const outside = await tool.execute({ path: dir }, api, {});
  assert.equal(outside.isError, true);
  assert.match(outside.output[0].text, /is not in a git repository/);

  // After a turn: the followed repositories' states, in module state.
  const state = memoryState();
  const info = { sessionId: "s", state, snapshot: async (token) => docs.get(token.definition.kind) };
  const tracked = await refreshTracked(info);
  assert.equal(tracked.length, 1);
  assert.deepEqual({ path: tracked[0].path, repo: tracked[0].repo, branch: tracked[0].branch }, { path: other, repo: true, branch: "trunk" });
  assert.deepEqual(state.values.get("tracked"), tracked);

  // The client part's panel: the session's repository, then the followed one.
  const handlers = new Map();
  const panels = [];
  const watches = [];
  gitClient({ on: (type, handler) => handlers.set(type, handler), events: { on() {}, emit() {} } });
  await handlers.get("session_start")({}, {
    sessionManager: { getSessionId: () => "s" },
    chord: { async watchDocument(_address, onValue) { watches.push(onValue); return () => {}; } },
    ui: { hasSidebar: true, notify() {}, setWidget: (key, lines) => panels.push(lines) },
  });
  await Promise.resolve();
  watches[0]({ values: { workspace: { repo: true, branch: "main", project: "project" }, tracked } });
  assert.deepEqual(panels.at(-1), ["⎇ main  project", "  clean", "⎇ trunk  other", "  clean"]);

  // Stopped: no longer recorded, and the next refresh clears the states.
  assert.equal((await tool.execute({ path: other, stop: true }, api, {})).output[0].text, `No longer following ${other}.`);
  assert.deepEqual(docs.get(TRACKED_DOC.definition.kind).paths, []);
  assert.deepEqual(await refreshTracked(info), []);
  assert.deepEqual(state.values.get("tracked"), []);
});
