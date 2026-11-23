// pi-git's /git wt fork NAME --rebase[=BASE] (bd-658ee5): the fork's branch starts on a freshly
// fetched base, its base is noted in the conversation (which the fork carries), and a conflict is
// reported with nothing forked. Real git throughout: an origin, a checkout behind it, and for
// @node two HOMEs as two nodes (as test/durable-git.test.js does).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGitCommands, createGitRefresher, readWorkspace, takeRebase } from "../extensions/lib/durable-git.js";
import { ForkBaseConflict, describeBase, forkBaseNote, forkOnBase } from "../extensions/lib/git-fork-base.js";
import { runGit } from "../extensions/lib/durable-git.js";
import gitClient from "../extensions/durable/git-client.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** Commit `files` ({ name: text }) in `cwd` with `message`; its commit. */
async function commit(cwd, files, message) {
  for (const [name, text] of Object.entries(files)) await writeFile(join(cwd, name), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const identify = (cwd) => {
  git(cwd, "config", "user.name", "t");
  git(cwd, "config", "user.email", "t@t");
};

/** An origin; `root`, a clone of it whose main is behind; `other`, a clone that moved origin's main on. */
async function behindOrigin(t, home) {
  const dir = home ?? (await realpath(await mkdtemp(join(tmpdir(), "pi-git-base-"))));
  if (!home) t.after(() => rm(dir, { recursive: true, force: true }));
  const origin = join(dir, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  const root = join(dir, "src", "project");
  await mkdir(join(dir, "src"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin, root], { stdio: "ignore" });
  identify(root);
  const first = await commit(root, { "a.txt": "one\ntwo\nthree\n", "b.txt": "b\n" }, "init");
  git(root, "push", "-q", "origin", "HEAD:main");
  git(root, "remote", "set-head", "origin", "main");
  const other = join(dir, "other");
  execFileSync("git", ["clone", "-q", origin, other], { stdio: "ignore" });
  identify(other);
  await commit(other, { "c.txt": "c\n" }, "moved on");
  const fresh = await commit(other, { "a.txt": "one\nTWO\nthree\n" }, "fresh main");
  git(other, "push", "-q", "origin", "HEAD:main");
  return { dir, origin, root, other, first, fresh };
}

function memoryState() {
  const values = new Map();
  return { values, get: async (key) => values.get(key), set: async (key, value) => void (value === undefined ? values.delete(key) : values.set(key, value)) };
}

/** A module command's ctx whose conversation takes written entries (pi-daemon's harness). */
function commandCtx(cwd, { busy = false } = {}) {
  const writes = [];
  const notices = [];
  const ctx = {
    sessionId: "s",
    conversationId: "c",
    context: {},
    cwd,
    state: memoryState(),
    env: { get: async () => ({}) },
    notify: (text) => notices.push(text),
    harness: {
      conversation: async (id) => ({
        submit: async (draft) => {
          writes.push({ id, ...draft });
          return { status: async () => ({ status: busy ? "queued" : "done" }) };
        },
      }),
    },
  };
  return { ctx, writes, notices };
}

const worktreeBranches = (root) => git(root, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;

test("--rebase[=BASE] is taken from /git's words: BASE after = or as the next word when NAME is there besides", () => {
  assert.deepEqual(takeRebase(["wt", "fork", "x"]), { words: ["wt", "fork", "x"] });
  assert.deepEqual(takeRebase(["wt", "fork", "x", "--rebase"]), { words: ["wt", "fork", "x"], rebase: { base: undefined } });
  assert.deepEqual(takeRebase(["wt", "fork", "x", "--rebase=main"]), { words: ["wt", "fork", "x"], rebase: { base: "main" } });
  assert.deepEqual(takeRebase(["wt", "fork", "x", "--rebase", "upstream/dev"]), { words: ["wt", "fork", "x"], rebase: { base: "upstream/dev" } });
  assert.deepEqual(takeRebase(["wt", "fork", "--rebase", "x"]), { words: ["wt", "fork", "x"], rebase: { base: undefined } }, "x is NAME, not BASE");
  assert.deepEqual(takeRebase(["wt", "fork", "--rebase", "main", "x"]), { words: ["wt", "fork", "x"], rebase: { base: "main" } });
  assert.deepEqual(takeRebase(["wt", "fork", "x", "--rebase", "--other"]), { words: ["wt", "fork", "x", "--other"], rebase: { base: undefined } });
});

test("/git wt fork NAME --rebase: fetched first, the branch moved forward onto origin's main, its base noted in the conversation", async (t) => {
  const { dir, root, fresh, first } = await behindOrigin(t);
  const { ctx, writes, notices } = commandCtx(root);
  const { git: command } = createGitCommands(createGitRefresher(), { root: join(dir, "worktrees"), tmp: dir });
  assert.equal(git(root, "rev-parse", "origin/main"), first, "this checkout has not seen origin's main move");

  await command.run("wt fork try-x --rebase", ctx);
  const path = join(dir, "worktrees", "project", "try-x");
  assert.equal(git(path, "rev-parse", "HEAD"), fresh, "the branch is on the fresh main");
  assert.equal(git(path, "branch", "--show-current"), "try-x");
  assert.equal(git(root, "rev-parse", "HEAD"), first, "the checkout itself is untouched");
  assert.equal(git(root, "rev-parse", "origin/main"), fresh, "its origin/main fetched");
  assert.match(notices.at(-1), new RegExp(`^Worktree ${path} on new branch try-x, moved forward onto origin/main at ${fresh} "fresh main"\\.$`));

  // The record the client part opens the fork from says its base.
  const forked = ctx.state.values.get("forked");
  assert.deepEqual([forked.path, forked.branch, forked.created, forked.base.ref, forked.base.commit, forked.base.head, forked.base.how], [path, "try-x", true, "origin/main", fresh, fresh, "fast-forward"]);
  assert.equal(forked.placed, undefined);

  // The note: in this conversation, written before the record, so the fork carries it as its first new message.
  assert.equal(writes.length, 1);
  const [write] = writes;
  assert.equal(write.type, "write");
  assert.equal(write.id, "c");
  assert.equal(write.entry.kind, "pi.user");
  const text = write.entry.model[0].content[0].text;
  assert.match(text, new RegExp(`^\\[/git wt fork try-x --rebase: worktree ${path}, branch try-x at ${fresh}, moved forward onto origin/main at ${fresh} "fresh main" \\(fetched \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\)\\.\\]$`));
  assert.equal(write.entry.data.piGit.fork.base.commit, fresh);
  assert.equal(worktreeBranches(root), 2, "no temporary worktree left");
});

test("--rebase=main replays this branch's own commits onto the fresh base; a conflict is reported and nothing is forked", async (t) => {
  const { dir, root, fresh } = await behindOrigin(t);
  const own = await commit(root, { "d.txt": "mine\n" }, "my own work");
  const { git: command } = createGitCommands(createGitRefresher(), { root: join(dir, "worktrees"), tmp: dir });

  const one = commandCtx(root);
  await command.run("wt fork mine --rebase=main", one.ctx);
  const path = join(dir, "worktrees", "project", "mine");
  assert.equal(git(path, "rev-parse", "HEAD~1"), fresh, "on the fresh main");
  assert.equal(git(path, "log", "-1", "--format=%s"), "my own work", "with this branch's commit replayed");
  assert.notEqual(git(path, "rev-parse", "HEAD"), own);
  assert.equal(git(root, "rev-parse", "HEAD"), own, "this branch is as it was");
  assert.match(one.notices.at(-1), /, rebased onto origin\/main at [0-9a-f]{40} "fresh main", 1 commit replayed\.$/);
  assert.equal(one.ctx.state.values.get("forked").base.how, "rebased");
  assert.equal(worktreeBranches(root), 2, "the rebase's own worktree is gone");
  assert.deepEqual(await readdir(dir).then((names) => names.filter((name) => name.startsWith("pi-git-rebase-"))), []);

  // A commit that conflicts with the fresh main: reported, with nothing forked.
  const clash = await commit(root, { "a.txt": "one\nmine\nthree\n" }, "clashing edit");
  const two = commandCtx(root);
  const before = git(root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
  await command.run("wt fork clash --rebase main", two.ctx);
  assert.match(two.notices.at(-1), new RegExp(`^/git wt fork clash --rebase: rebasing 2 commits of HEAD onto origin/main \\(${fresh.slice(0, 12)} "fresh main"\\) conflicts at ${clash.slice(0, 12)} "clashing edit" in a\\.txt\\. Nothing was forked \\(the rebase was aborted; no worktree, no branch clash made\\)\\. Resolve it in this checkout \\(git rebase origin/main\\), or fork without --rebase\\.$`));
  assert.equal(two.ctx.state.values.get("forked"), undefined, "no fork for the client part to open");
  assert.deepEqual(two.writes, [], "and no note");
  assert.equal(git(root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), before, "no branch made or moved");
  assert.equal(worktreeBranches(root), 2, "no worktree made, the rebase's own removed");
  assert.equal(git(root, "rev-parse", "HEAD"), clash);
  assert.equal(git(root, "status", "--porcelain"), "", "this checkout is clean, with no rebase of its own in progress");
});

test("--rebase onto a base that has this branch's changes already (squash-merged) starts on the base itself", async (t) => {
  const { dir, root, other } = await behindOrigin(t);
  git(root, "pull", "-q", "--ff-only", "origin", "main");
  // Two commits here; origin's main gets their changes as one squashed commit, and moves on.
  await commit(root, { "e.txt": "1\n" }, "e one");
  await commit(root, { "e.txt": "1\n2\n" }, "e two");
  git(other, "pull", "-q", "--ff-only");
  await commit(other, { "e.txt": "1\n2\n" }, "e (squashed)");
  const fresh = await commit(other, { "f.txt": "f\n" }, "after the squash");
  git(other, "push", "-q", "origin", "HEAD:main");
  const { ctx, notices } = commandCtx(root);
  const { git: command } = createGitCommands(createGitRefresher(), { root: join(dir, "worktrees"), tmp: dir });
  await command.run("wt fork next --rebase", ctx);
  assert.equal(git(join(dir, "worktrees", "project", "next"), "rev-parse", "HEAD"), fresh);
  assert.match(notices.at(-1), /, on origin\/main at [0-9a-f]{40} "after the squash", which has its 2 commits merged already\.$/);
});

test("--rebase on an existing branch NAME moves it (its old tip noted); a fetch that fails forks nothing", async (t) => {
  const { dir, root, first, fresh } = await behindOrigin(t);
  git(root, "branch", "old-work", first);
  const { ctx, writes, notices } = commandCtx(root, { busy: true });
  const { git: command } = createGitCommands(createGitRefresher(), { root: join(dir, "worktrees"), tmp: dir });
  await command.run("wt fork old-work --rebase", ctx);
  assert.equal(git(root, "rev-parse", "old-work"), fresh);
  assert.equal(ctx.state.values.get("forked").created, false);
  assert.match(writes[0].entry.model[0].content[0].text, new RegExp(`Branch old-work was at ${first} before\\.\\]$`));
  assert.match(notices.at(-1), /This conversation is working: the note of its base lands here when its turn ends, too late for the fork.s copy/);

  const failing = commandCtx(root);
  await command.run("wt fork nowhere --rebase=gone", failing.ctx);
  assert.match(failing.notices.at(-1), /^\/git wt fork nowhere --rebase: git fetch origin gone failed: .*; nothing was forked$/);
  assert.equal(failing.ctx.state.values.get("forked"), undefined);
  assert.equal(git(root, "branch", "--list", "nowhere"), "");
  const noRemote = commandCtx(root);
  await command.run("wt fork nowhere --rebase=upstream/main", noRemote.ctx);
  assert.match(noRemote.notices.at(-1), /this repository has no remote origin to fetch upstream\/main from|git fetch origin upstream\/main failed/);
  await command.run("status --rebase", noRemote.ctx);
  assert.equal(noRemote.notices.at(-1), "/git: --rebase[=BASE] is for /git wt fork NAME.");

  // A rebase that stops for another reason than a conflict (here, no committer name): said as it is.
  await commit(root, { "g.txt": "g\n" }, "needs replaying");
  const nameless = commandCtx(root);
  nameless.ctx.env = { get: async () => ({ GIT_COMMITTER_NAME: "" }) };
  await command.run("wt fork nameless --rebase", nameless.ctx);
  assert.match(nameless.notices.at(-1), /^\/git wt fork nameless --rebase: git rebase onto origin\/main failed.*ident.*; nothing was forked$/);
  assert.equal(nameless.ctx.state.values.get("forked"), undefined);
  assert.equal(worktreeBranches(root), 2);
});

test("forkOnBase: BASE as remote/branch fetches that remote; the base's description per case", async (t) => {
  const { dir, origin, root, fresh } = await behindOrigin(t);
  git(root, "remote", "add", "upstream", origin);
  const placed = await forkOnBase(root, "HEAD", "upstream/main", { run: runGit, env: process.env, tmp: dir, now: () => Date.UTC(2026, 10, 23, 10, 12, 0) });
  assert.deepEqual([placed.base.remote, placed.base.branch, placed.base.ref, placed.commit, placed.how], ["upstream", "main", "upstream/main", fresh, "fast-forward"]);
  assert.equal(git(root, "rev-parse", "upstream/main"), fresh);
  assert.match(forkBaseNote({ name: "n", path: "/w/n", host: "aurora", placed }), /^\[\/git wt fork n --rebase: worktree \/w\/n on aurora, branch n at [0-9a-f]{40}, moved forward onto upstream\/main at [0-9a-f]{40} "fresh main" \(fetched 2026-11-23T10:12:00Z\)\.\]$/);
  const base = { ref: "origin/main", commit: "b".repeat(40), subject: "s" };
  assert.equal(describeBase({ base, how: "at", own: 0, replayed: 0 }), `on origin/main at ${"b".repeat(40)} "s"`);
  assert.equal(describeBase({ base, how: "ahead", own: 3, replayed: 3 }), `on its 3 commits over origin/main at ${"b".repeat(40)} "s", which it contains already`);
  assert.equal(describeBase({ base, how: "rebased", own: 3, replayed: 2 }), `rebased onto origin/main at ${"b".repeat(40)} "s", 2 commits replayed (1 already there)`);
  await assert.rejects(() => forkOnBase(root, "HEAD", "../x", { run: runGit, env: process.env, tmp: dir }), /not a branch to rebase onto/);
  await writeFile(join(root, "a.txt"), "one\nconflict\nthree\n");
  git(root, "commit", "-q", "-am", "clash");
  await assert.rejects(() => forkOnBase(root, "HEAD", "main", { run: runGit, env: process.env, tmp: dir }), (error) => error instanceof ForkBaseConflict && error.details.files.includes("a.txt"));
});

test("/git wt fork NAME @node --rebase: the node gets the branch on the base fetched here, this HEAD's commits replayed", async (t) => {
  const { peer } = await import("../extensions/lib/session-fork/core.js");
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-git-base-node-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const homeA = join(dir, "a");
  const homeB = join(dir, "b");
  await mkdir(homeB, { recursive: true });
  const { root, fresh } = await behindOrigin(t, homeA);
  await commit(root, { "d.txt": "mine\n" }, "unpushed work");
  const asNode = async (home, fn) => {
    const saved = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
    process.env.HOME = home;
    delete process.env.XDG_STATE_HOME;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const peerFor = () => (payload) => asNode(homeB, () => peer(payload));
  const { ctx, writes, notices } = commandCtx(root);
  const { git: command } = createGitCommands(createGitRefresher(), { peerFor, tmp: dir });

  await asNode(homeA, () => command.run("wt fork try-n @aurora --rebase", ctx));
  const path = join(homeB, ".local", "state", "pi-daemon", "worktrees", "project", "try-n");
  assert.match(notices.at(-1), new RegExp(`^Worktree ${path} on aurora, on new branch try-n, rebased onto origin/main at ${fresh} "fresh main", 1 commit replayed \\(cloned there, with its rebased commits\\)\\.$`));
  assert.equal(git(path, "rev-parse", "HEAD~1"), fresh, "on the fresh main, there");
  assert.equal(git(path, "log", "-1", "--format=%s"), "unpushed work");
  const forked = ctx.state.values.get("forked");
  assert.deepEqual([forked.host, forked.path, forked.base.ref, forked.base.commit, forked.base.how], ["aurora", path, "origin/main", fresh, "rebased"]);
  assert.equal(forked.base.head, git(path, "rev-parse", "HEAD"));
  assert.match(writes[0].entry.model[0].content[0].text, new RegExp(`^\\[/git wt fork try-n --rebase: worktree ${path} on aurora, branch try-n at ${forked.base.head}, rebased onto origin/main at ${fresh} "fresh main", 1 commit replayed`));

  // A conflict: reported, and the node is never asked.
  await commit(root, { "a.txt": "one\nmine\nthree\n" }, "clash");
  const two = commandCtx(root);
  const asked = [];
  const { git: watched } = createGitCommands(createGitRefresher(), { peerFor: () => (payload) => (asked.push(payload.action), asNode(homeB, () => peer(payload))), tmp: dir });
  await asNode(homeA, () => watched.run("wt fork clash @aurora --rebase=main", two.ctx));
  assert.match(two.notices.at(-1), /^\/git wt fork clash @aurora --rebase: rebasing 2 commits of [0-9a-f]{12} onto origin\/main .* conflicts at .* in a\.txt\. Nothing was forked/);
  assert.deepEqual(asked, []);
  assert.equal(two.ctx.state.values.get("forked"), undefined);
});

test("the client part says the base a fork starts on as it opens it", async () => {
  const handlers = new Map();
  const watches = [];
  const created = [];
  const notices = [];
  const ctx = {
    sessionManager: { getSessionId: () => "a" },
    chord: { async watchDocument(address, onValue) { watches.push(onValue); return () => {}; } },
    sessions: { create: async (options) => created.push(options) },
    ui: { notify: (text) => notices.push(text) },
  };
  gitClient({ on: (type, handler) => handlers.set(type, handler), events: { on() {}, emit() {} } });
  await handlers.get("session_start")({}, ctx);
  await Promise.resolve();
  watches[0]({ values: { forked: { at: 0 } } });
  watches[0]({ values: { forked: { path: "/wt/x", branch: "x", at: 5, base: { ref: "origin/main", commit: "0123456789abcdef0123456789abcdef01234567" } } } });
  await Promise.resolve();
  assert.deepEqual(created, [{ cwd: "/wt/x", title: "x", carry: true }]);
  assert.deepEqual(notices, ["Opening x, on origin/main 0123456789ab: copying this conversation into a session there…"]);
});
