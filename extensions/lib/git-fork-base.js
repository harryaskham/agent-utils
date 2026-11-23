// pi-git's `/git wt fork NAME --rebase[=BASE]` (bd-658ee5): the fork starts on a freshly fetched
// base rather than on whatever this checkout last saw. At the source, before any worktree is made:
//
//   1. BASE: a branch of origin (`main`, or `upstream/main` for another remote); without one,
//      origin's default branch (refs/remotes/origin/HEAD), else `main`.
//   2. fetch it from its remote, into its remote-tracking ref;
//   3. the commit the fork starts on: the start (HEAD, or branch NAME when it exists) rebased onto
//      it. A start the base already contains, or whose own changes it has already (merged,
//      squash-merged or cherry-picked), starts on the base itself; a start that contains the base
//      stays as it is; otherwise its own commits are replayed onto the base in a temporary
//      detached worktree, which writes no refs and runs no hooks.
//   4. a conflict aborts that rebase and throws ForkBaseConflict, naming the commit and files:
//      nothing is forked on the old base.
//
// The caller then places the fork on the commit returned: a worktree here (durable-git.js) or on
// another node (session-fork/worktree.js, which sends the commit as it sends HEAD). The git
// runner is pi-git's (`run(args, { cwd, env, signal })` -> { code, stdout, stderr }).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A branch name git and a shell both take as it is (as /git wt fork's NAME). */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,100}(?<![./])$/;
/** The fetch may take this long (a slow remote); then it is given up, and nothing is forked. */
export const FETCH_TIMEOUT_MS = 5 * 60_000;
/** Most conflicted files a report names; it says how many more there are. */
const REPORTED_FILES = 20;

/** A rebase onto the base that stopped at a conflict, aborted; nothing was forked. */
export class ForkBaseConflict extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ForkBaseConflict";
    this.code = "rebase-conflict";
    this.details = details;
  }
}

const short = (commit) => String(commit ?? "").slice(0, 12);
const quoted = (subject) => (subject ? ` "${subject}"` : "");
/** HEAD, a branch, or a commit, as a report names it. */
const startLabel = (start) => (/^[0-9a-f]{40,64}$/.test(start) ? short(start) : start.replace(/^refs\/heads\//, "branch "));
const lines = (text) => String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);

/** Which remote and branch BASE names (undefined: origin's default branch, else main). */
export async function resolveBase(root, base, { run, env, signal }) {
  const remotes = lines((await run(["remote"], { cwd: root, env, signal })).stdout);
  let remote = "origin";
  let branch = base;
  if (branch === undefined || branch === "") {
    const head = (await run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: root, env, signal })).stdout.trim();
    branch = head.startsWith("origin/") && head.length > "origin/".length ? head.slice("origin/".length) : "main";
  } else {
    const slash = branch.indexOf("/");
    if (slash > 0 && remotes.includes(branch.slice(0, slash))) {
      remote = branch.slice(0, slash);
      branch = branch.slice(slash + 1);
    }
    branch = branch.replace(/^refs\/heads\//, "");
  }
  if (!BRANCH_NAME.test(branch)) throw new Error(`not a branch to rebase onto: ${base}`);
  if (!remotes.includes(remote)) throw new Error(`this repository has no remote ${remote} to fetch ${branch} from`);
  return { remote, branch, ref: `${remote}/${branch}` };
}

/** Fetch BASE into its remote-tracking ref: { ...base, commit, subject, fetchedAt }. */
export async function fetchBase(root, base, { run, env, signal, timeoutMs = FETCH_TIMEOUT_MS, now = Date.now }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let fetched;
  try {
    fetched = await run(["fetch", "--no-tags", "--quiet", base.remote, `+refs/heads/${base.branch}:refs/remotes/${base.remote}/${base.branch}`], { cwd: root, env, signal: both });
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw new Error(`git fetch ${base.remote} ${base.branch} took longer than ${Math.round(timeoutMs / 1000)}s: nothing was forked`);
    throw error;
  }
  if (fetched.code !== 0) {
    const why = lines(fetched.stderr).slice(-2).join(" ");
    throw new Error(`git fetch ${base.remote} ${base.branch} failed${why ? `: ${why}` : ""}; nothing was forked`);
  }
  const commit = (await run(["rev-parse", "--verify", "--quiet", `refs/remotes/${base.remote}/${base.branch}^{commit}`], { cwd: root, env, signal })).stdout.trim();
  if (!commit) throw new Error(`${base.ref} is not a branch after fetching it`);
  const subject = (await run(["log", "-1", "--format=%s", commit], { cwd: root, env, signal })).stdout.trim();
  return { ...base, commit, subject, fetchedAt: now() };
}

const isAncestor = async (root, ancestor, descendant, { run, env, signal }) =>
  (await run(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: root, env, signal })).code === 0;

const count = async (root, range, { run, env, signal }) => Number((await run(["rev-list", "--count", range], { cwd: root, env, signal })).stdout.trim()) || 0;

/**
 * The commit a fork rebased onto `base` (fetched) starts on, from `start` (a commit or branch):
 * { commit, how, own, replayed } where `how` is "at" (the start is the base), "fast-forward" (the
 * base contains the start), "merged" (the base has the start's own changes already), "ahead"
 * (the start contains the base) or "rebased" (its `own` commits replayed, `replayed` of them kept).
 * A conflict throws ForkBaseConflict.
 */
export async function rebaseStart(root, start, base, { run, env, signal, tmp = tmpdir() }) {
  const options = { run, env, signal };
  const startCommit = (await run(["rev-parse", "--verify", "--quiet", `${start}^{commit}`], { cwd: root, env, signal })).stdout.trim();
  if (!startCommit) throw new Error(`${start} is not a commit here`);
  if (startCommit === base.commit) return { commit: base.commit, start: startCommit, how: "at", own: 0, replayed: 0 };
  if (await isAncestor(root, startCommit, base.commit, options)) return { commit: base.commit, start: startCommit, how: "fast-forward", own: 0, replayed: 0 };
  const own = await count(root, `${base.commit}..${startCommit}`, options);
  if (await isAncestor(root, base.commit, startCommit, options)) return { commit: startCommit, start: startCommit, how: "ahead", own, replayed: own };
  // Its changes merged into the base already (a squash merge too): the base, as it is.
  // (git merge-tree --write-tree, git 2.38: exit 0 and the merged tree when clean; else conflicts or too old a git.)
  const merged = await run(["merge-tree", "--write-tree", base.commit, startCommit], { cwd: root, env, signal });
  if (merged.code === 0) {
    const tree = lines(merged.stdout)[0];
    const baseTree = (await run(["rev-parse", `${base.commit}^{tree}`], { cwd: root, env, signal })).stdout.trim();
    if (tree && tree === baseTree) return { commit: base.commit, start: startCommit, how: "merged", own, replayed: 0 };
  }
  // Replay its own commits onto the base, in a worktree of its own: the checkout and its refs stay as they are.
  const dir = await mkdtemp(join(tmp, "pi-git-rebase-"));
  const path = join(dir, "tree");
  const quiet = ["-c", "core.hooksPath=/dev/null"];
  try {
    const added = await run([...quiet, "worktree", "add", "--quiet", "--detach", path, startCommit], { cwd: root, env, signal });
    if (added.code !== 0) throw new Error(`cannot make a temporary worktree to rebase in: ${lines(added.stderr).slice(-1)[0] ?? `git exited ${added.code}`}`);
    const rebase = [...quiet, "-c", "rebase.updateRefs=false", "-c", "rebase.autoSquash=false", "-c", "rebase.autoStash=false", "rebase", "--quiet", base.commit];
    const rebased = await run(rebase, { cwd: path, env, signal });
    if (rebased.code !== 0) {
      const files = lines((await run(["diff", "--name-only", "--diff-filter=U"], { cwd: path, env, signal })).stdout);
      const stopped = (await run(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], { cwd: path, env, signal })).stdout.trim();
      const subject = stopped ? (await run(["log", "-1", "--format=%s", stopped], { cwd: path, env, signal })).stdout.trim() : "";
      await run(["rebase", "--abort"], { cwd: path, env, signal }).catch(() => undefined);
      // Stopped without a conflicted file: something else (no committer identity, a signing failure).
      if (files.length === 0) {
        const why = lines(rebased.stderr).filter((line) => !/^hint:/.test(line)).slice(-3).join(" ") || `git exited ${rebased.code}`;
        throw new Error(`git rebase onto ${base.ref} failed${stopped ? ` at ${short(stopped)}${quoted(subject)}` : ""}: ${why}; nothing was forked`);
      }
      const named = files.slice(0, REPORTED_FILES).join(", ") + (files.length > REPORTED_FILES ? ` and ${files.length - REPORTED_FILES} more` : "");
      throw new ForkBaseConflict(
        `rebasing ${own} commit${own === 1 ? "" : "s"} of ${startLabel(start)} onto ${base.ref} (${short(base.commit)}${quoted(base.subject)}) conflicts${stopped ? ` at ${short(stopped)}${quoted(subject)}` : ""}${named ? ` in ${named}` : ""}`,
        { base, from: start, start: startCommit, own, stopped, subject, files },
      );
    }
    const commit = (await run(["rev-parse", "HEAD"], { cwd: path, env, signal })).stdout.trim();
    return { commit, start: startCommit, how: "rebased", own, replayed: await count(root, `${base.commit}..${commit}`, options) };
  } finally {
    await run(["worktree", "remove", "--force", path], { cwd: root, env }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await run(["worktree", "prune"], { cwd: root, env }).catch(() => undefined);
  }
}

/** Fetch BASE and rebase `start` onto it: the base and the commit the fork starts on. */
export async function forkOnBase(root, start, baseName, { run, env, signal, tmp, timeoutMs, now }) {
  const base = await fetchBase(root, await resolveBase(root, baseName, { run, env, signal }), { run, env, signal, ...(timeoutMs ? { timeoutMs } : {}), ...(now ? { now } : {}) });
  return { base, ...(await rebaseStart(root, start, base, { run, env, signal, ...(tmp ? { tmp } : {}) })) };
}

/** How the fork's branch sits on its base, in a few words (the notice and the conversation's note). */
export function describeBase(placed) {
  const { base, how, own, replayed } = placed;
  const at = `${base.ref} at ${base.commit}${quoted(base.subject)}`;
  const commits = (n) => `${n} commit${n === 1 ? "" : "s"}`;
  switch (how) {
    case "at":
      return `on ${at}`;
    case "fast-forward":
      return `moved forward onto ${at}`;
    case "merged":
      return `on ${at}, which has its ${commits(own)} merged already`;
    case "ahead":
      return `on its ${commits(own)} over ${at}, which it contains already`;
    default:
      return `rebased onto ${at}, ${commits(replayed)} replayed${replayed < own ? ` (${own - replayed} already there)` : ""}`;
  }
}

/** The note the conversation keeps, so the fork (which carries it) and its reader know its base. */
export function forkBaseNote({ name, path, host, placed, previous }) {
  const fetched = new Date(placed.base.fetchedAt).toISOString().replace(/\.\d+Z$/, "Z");
  const where = host ? `${path} on ${host}` : path;
  const was = previous && previous !== placed.commit ? ` Branch ${name} was at ${previous} before.` : "";
  return `[/git wt fork ${name} --rebase: worktree ${where}, branch ${name} at ${placed.commit}, ${describeBase(placed)} (fetched ${fetched}).${was}]`;
}
