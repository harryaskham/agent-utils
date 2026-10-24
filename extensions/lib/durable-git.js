// pi-git's daemon part (git.mjs): the git state of a pi-daemon session's working directory, read
// on the session's host after each turn, for the client part (git-client.js: the editor chips,
// later a repo sidebar). pi-daemon knows nothing of git: this is a profile module (its `observe`
// and `commands`), and the state is the module's own per-session state, the Durable document
// `pi-daemon.module-state` keyed "git", which clients watch over /chord.
//
// A refresh runs after a turn ends (agent_end), never inside a tool call: it is started and
// left to run (the observer returns at once), a newer one aborts it, it is killed after
// GIT_TIMEOUT_MS, and a repository whose git is slow is refreshed less often (backoff). It reads
// with --no-optional-locks (GIT_OPTIONAL_LOCKS=0), so it never takes the index lock the agent's
// own git may want. The result is written in one state.set (one Durable commit).
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** The module's name (git.mjs), which keys its state document. */
export const GIT_MODULE = "git";
/** The state key of the session's workspace. */
export const WORKSPACE_KEY = "workspace";
/** pi-client watches this document for a session's git state. */
export { GIT_STATE_DOC } from "./git-indicator.js";
/** A refresh's git commands get this long, together. */
export const GIT_TIMEOUT_MS = 5_000;
/** A refresh slower than this backs the next automatic one off. */
export const SLOW_GIT_MS = 1_500;
export const MIN_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 10 * 60_000;
/** Sessions whose refreshes are tracked at once (the oldest let go). */
export const MAX_GIT_SESSIONS = 256;
/** Most bytes read from one git command. */
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
/** Most worktrees a repository's state lists. */
export const MAX_WORKTREES = 64;

/** The environment git runs with: the session's overrides, never prompting or taking optional locks. */
export function gitEnv(overrides = {}, base = process.env) {
  const env = { ...base, ...overrides, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  // git-ssh-multiplex and the like: PI_GIT_SSH_COMMAND is git's SSH command for this host.
  if (env.PI_GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = env.PI_GIT_SSH_COMMAND;
  return env;
}

/** Run git in `cwd`: { code, stdout }, or a rejection when aborted or failing to start. */
export function runGit(args, { cwd, env, signal }) {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["--no-optional-locks", ...args], { cwd, env, signal, maxBuffer: MAX_GIT_OUTPUT, encoding: "utf8" }, (error, stdout) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      if (error && typeof error.code !== "number") return reject(error);
      resolvePromise({ code: error ? error.code : 0, stdout: String(stdout ?? "") });
    });
  });
}

/** `git status --porcelain=v2 --branch`, summarised. */
export function parseStatus(text) {
  const status = { branch: "", detached: false, oid: "", upstream: "", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const line of String(text).split("\n")) {
    if (line.startsWith("# branch.oid ")) status.oid = line.slice(13).trim() === "(initial)" ? "" : line.slice(13).trim();
    else if (line.startsWith("# branch.head ")) {
      const head = line.slice(14).trim();
      status.detached = head === "(detached)";
      status.branch = status.detached ? "" : head;
    } else if (line.startsWith("# branch.upstream ")) status.upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.slice(2, 4);
      if (xy[0] !== ".") status.staged += 1;
      if (xy[1] !== ".") status.unstaged += 1;
    } else if (line.startsWith("u ")) status.conflicts += 1;
    else if (line.startsWith("? ")) status.untracked += 1;
  }
  return status;
}

/** `git diff --numstat`: lines added and removed (binary files count none). */
export function parseNumstat(text) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(text).split("\n")) {
    const [added, removed] = line.split("\t");
    if (/^\d+$/.test(added ?? "")) additions += Number(added);
    if (/^\d+$/.test(removed ?? "")) deletions += Number(removed);
  }
  return { additions, deletions };
}

/**
 * The git state of `cwd`: `{ repo: false }` outside a repository, else its root, the main
 * worktree's root (`worktree` when this is a linked worktree), the branch (or detached HEAD's
 * commit), upstream and ahead/behind, and counts of staged, unstaged, untracked and conflicted
 * files and of lines added and removed against HEAD.
 */
export async function readWorkspace(cwd, { env, signal, run = runGit } = {}) {
  const options = { cwd, env, signal };
  const paths = await run(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], options);
  if (paths.code !== 0) return { repo: false };
  const [top, gitDir, commonDir] = paths.stdout.split("\n").map((line) => line.trim());
  if (!top) return { repo: false };
  const absolute = (path) => (isAbsolute(path) ? path : resolve(cwd, path));
  const linked = Boolean(gitDir && commonDir) && absolute(gitDir) !== absolute(commonDir);
  const common = commonDir ? absolute(commonDir) : join(top, ".git");
  const mainRoot = basename(common) === ".git" ? dirname(common) : top;
  const status = await run(["status", "--porcelain=v2", "--branch"], options);
  if (status.code !== 0) throw new Error("git status failed");
  const parsed = parseStatus(status.stdout);
  const diff = parsed.oid ? await run(["diff", "--numstat", "HEAD", "--"], options) : { code: 0, stdout: "" };
  // The repository's worktrees (its main one first): /repo's sessions are those in any of them.
  const trees = await run(["worktree", "list", "--porcelain"], options);
  const worktrees = trees.code === 0 ? parseWorktrees(trees.stdout).map((tree) => tree.path).filter(Boolean).slice(0, MAX_WORKTREES) : [];
  return {
    repo: true,
    root: top,
    mainRoot,
    worktree: linked,
    project: basename(mainRoot),
    worktrees,
    ...parsed,
    ...(diff.code === 0 ? parseNumstat(diff.stdout) : { additions: 0, deletions: 0 }),
  };
}

/**
 * Refreshes sessions' git state into their module state. `refresh` resolves with the new state,
 * or undefined when it was skipped (backing off), superseded by a newer refresh, or failed (the
 * last good state stays, with `failedAt` and `error`).
 */
export function createGitRefresher({ run = runGit, now = () => Date.now(), timeoutMs = GIT_TIMEOUT_MS, slowMs = SLOW_GIT_MS, maxSessions = MAX_GIT_SESSIONS } = {}) {
  const sessions = new Map();
  const entryOf = (sessionId) => {
    let entry = sessions.get(sessionId);
    if (entry) sessions.delete(sessionId);
    else entry = { controller: undefined, backoffUntil: 0, failures: 0 };
    sessions.set(sessionId, entry);
    while (sessions.size > maxSessions) {
      const [oldest, gone] = sessions.entries().next().value;
      sessions.delete(oldest);
      gone.controller?.abort(new Error("superseded"));
    }
    return entry;
  };

  async function refresh(sessionId, { cwd, env, state }, { force = false } = {}) {
    if (!sessionId || !cwd || typeof state?.set !== "function") return undefined;
    const entry = entryOf(sessionId);
    if (!force && entry.backoffUntil > now()) return undefined;
    entry.controller?.abort(new Error("superseded"));
    const controller = new AbortController();
    entry.controller = controller;
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    timer.unref?.();
    const started = now();
    try {
      await stat(cwd);
      const overrides = typeof env?.get === "function" ? await env.get().catch(() => ({})) : {};
      const workspace = await readWorkspace(cwd, { env: gitEnv(overrides), signal: controller.signal, run });
      if (controller.signal.aborted) throw controller.signal.reason;
      const tookMs = now() - started;
      entry.failures = 0;
      entry.backoffUntil = tookMs > slowMs ? now() + Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, tookMs * 20)) : 0;
      const value = { ...workspace, cwd, at: now(), tookMs };
      await state.set(WORKSPACE_KEY, value);
      return value;
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      if (reason?.message === "superseded") return undefined;
      entry.failures += 1;
      entry.backoffUntil = now() + Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (entry.failures - 1));
      const previous = await Promise.resolve(state.get?.(WORKSPACE_KEY)).catch(() => undefined);
      const failed = reason?.message === "timeout" ? "timeout" : reason?.code === "ENOENT" ? "missing" : "error";
      await Promise.resolve(state.set(WORKSPACE_KEY, { ...(previous && typeof previous === "object" ? previous : {}), cwd, failedAt: now(), error: failed })).catch(() => {});
      return undefined;
    } finally {
      clearTimeout(timer);
      if (entry.controller === controller) entry.controller = undefined;
    }
  }

  return {
    refresh,
    /** Abort every refresh in flight. */
    stop() {
      for (const entry of sessions.values()) entry.controller?.abort(new Error("superseded"));
      sessions.clear();
    },
  };
}

/** The module's observer: after each turn, the session's git state, refreshed in the background. */
export function createGitObserver(refresher) {
  return (event, info) => {
    if (event?.type !== "agent_end") return;
    void refresher.refresh(info?.sessionId, info ?? {}).catch(() => {});
  };
}

/** One line for a workspace state. */
export function workspaceSummary(workspace) {
  if (!workspace || workspace.repo === false) return "Not a git repository.";
  const head = workspace.branch || (workspace.oid ? `detached at ${workspace.oid.slice(0, 8)}` : "no commits yet");
  const parts = [head];
  if (workspace.upstream) parts.push(`${workspace.upstream} ↑${workspace.ahead} ↓${workspace.behind}`);
  const changed = [
    workspace.staged ? `${workspace.staged} staged` : "",
    workspace.unstaged ? `${workspace.unstaged} modified` : "",
    workspace.untracked ? `${workspace.untracked} untracked` : "",
    workspace.conflicts ? `${workspace.conflicts} conflicted` : "",
  ].filter(Boolean);
  parts.push(changed.length ? `${changed.join(", ")} (+${workspace.additions} −${workspace.deletions})` : "clean");
  if (workspace.worktree) parts.push(`worktree of ${workspace.mainRoot}`);
  return parts.join(" · ");
}

/** A repository's state as a sidebar panel's lines: branch and project, upstream, changes, worktree. */
export function workspacePanel(workspace) {
  if (!workspace || workspace.repo === false) return undefined;
  const head = workspace.branch || (workspace.oid ? `detached ${workspace.oid.slice(0, 8)}` : "no commits");
  const lines = [`⎇ ${head}  ${workspace.project ?? ""}`.trimEnd()];
  if (workspace.upstream) lines.push(`  ↑${workspace.ahead ?? 0} ↓${workspace.behind ?? 0} ${workspace.upstream}`);
  const changed = [
    workspace.staged ? `${workspace.staged} staged` : "",
    workspace.unstaged ? `${workspace.unstaged} modified` : "",
    workspace.untracked ? `${workspace.untracked} untracked` : "",
    workspace.conflicts ? `${workspace.conflicts} conflicted` : "",
  ].filter(Boolean);
  lines.push(changed.length ? `  ${changed.join(", ")} +${workspace.additions ?? 0} −${workspace.deletions ?? 0}` : "  clean");
  if (workspace.worktree) lines.push(`  worktree of ${basename(workspace.mainRoot ?? "")}`);
  return lines;
}

/** Where `/git wt fork` puts worktrees: $XDG_STATE_HOME/pi-daemon/worktrees (or ~/.local/state/...). */
export function worktreesRoot(env = process.env) {
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(env.HOME || homedir(), ".local", "state");
  return join(state, "pi-daemon", "worktrees");
}

const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,100}(?<![./])$/;

/**
 * `git worktree add` for `name` under the managed directory (<root>/<project>/<name>): on a new
 * branch `name` from HEAD, or on branch `name` when it exists. Returns { path, branch, created }.
 */
export async function forkWorktree(cwd, name, { env, root = worktreesRoot(env), run = runGit, signal } = {}) {
  if (!BRANCH_NAME.test(name)) throw new Error(`not a usable worktree/branch name: ${name}`);
  const workspace = await readWorkspace(cwd, { env, signal, run });
  if (!workspace.repo) throw new Error("this session's directory is not in a git repository");
  const path = join(root, workspace.project, name.replace(/\//g, "-"));
  await mkdir(dirname(path), { recursive: true });
  const options = { cwd: workspace.root, env, signal };
  const exists = (await run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], options)).code === 0;
  const added = await run(exists ? ["worktree", "add", path, name] : ["worktree", "add", "-b", name, path, "HEAD"], options);
  if (added.code !== 0) throw new Error(`git worktree add failed for ${path} (is ${name} checked out elsewhere, or the path taken?)`);
  return { path, branch: name, created: !exists };
}

/** `git worktree list --porcelain`: [{ path, branch, head, detached }]. */
export function parseWorktrees(text) {
  const worktrees = [];
  let current;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), branch: "", head: "", detached: false };
      worktrees.push(current);
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (current && line === "detached") current.detached = true;
  }
  return worktrees;
}

/** The module's commands: /git (status), /git wt list, /git wt fork NAME. */
export function createGitCommands(refresher, { run = runGit, root } = {}) {
  const envOf = async (ctx) => gitEnv(typeof ctx.env?.get === "function" ? await ctx.env.get().catch(() => ({})) : {});
  return {
    git: {
      description: "Git for this session's directory: /git (status, refreshed now), /git wt list, /git wt fork NAME (a worktree and branch NAME, under ~/.local/state/pi-daemon/worktrees)",
      // Pi's argument completions (pi-daemon reads them; older hosts ignore them).
      getArgumentCompletions(prefix) {
        const text = String(prefix ?? "").trimStart().toLowerCase();
        return [
          { value: "status", label: "status", description: "Refresh now and show the state" },
          { value: "wt list", label: "wt list", description: "The repository's worktrees" },
          { value: "wt fork ", label: "wt fork NAME", description: "A worktree on a new branch, and a session there" },
        ].filter((item) => item.value.startsWith(text));
      },
      async run(args, ctx) {
        const [sub = "status", ...rest] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        if (!ctx.cwd) return ctx.notify("/git: this session's directory is not known.");
        if (sub === "status" || sub === "st") {
          const workspace = await refresher.refresh(ctx.sessionId, ctx, { force: true });
          return ctx.notify(workspace ? workspaceSummary(workspace) : "/git: git did not answer in time; the last state stays.");
        }
        if (sub === "wt" || sub === "worktree") {
          const [action = "list", name] = rest;
          const env = await envOf(ctx);
          if (action === "list") {
            const listed = await run(["worktree", "list", "--porcelain"], { cwd: ctx.cwd, env });
            if (listed.code !== 0) return ctx.notify("/git wt list: not a git repository.");
            const lines = parseWorktrees(listed.stdout).map((tree) => `${tree.path}  ${tree.branch || (tree.detached ? `detached ${tree.head.slice(0, 8)}` : "")}`);
            return ctx.notify(lines.join("\n") || "No worktrees.");
          }
          if (action === "fork") {
            if (!name) return ctx.notify("/git wt fork NAME: a name for the worktree and its branch.");
            const forked = await forkWorktree(ctx.cwd, name, { env, run, ...(root ? { root } : {}) });
            // The client part opens a session there (pi-client), from this record.
            await ctx.state.set("forked", { ...forked, from: ctx.cwd, at: Date.now() });
            return ctx.notify(`Worktree ${forked.path} on ${forked.created ? "new " : ""}branch ${forked.branch}.`);
          }
        }
        return ctx.notify("/git: status, wt list, wt fork NAME");
      },
    },
  };
}
