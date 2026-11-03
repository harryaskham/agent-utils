// A git worktree on another node, for pi-git's `/git wt fork NAME @node` and `/git @node`
// (bd-9fcd6a). It rides session-fork's peer channel (`pi-session _peer` on the node, over SSH),
// and only moves git: the conversation goes through pi-daemon's cross-host clone (bd-cd7999).
//
// On the node (peer actions):
//   worktree-plan  the repository at the same HOME-relative path, cloned from its origin when
//                  missing (fetched from it when present); whether it has the source commit, and
//                  which of the source's origin heads it has (the base of a thin bundle).
//   worktree-add   the commits it lacks from a bundle (unpushed work included; no refs written),
//                  then a worktree on branch NAME at the source commit under the node's
//                  pi-daemon worktrees root, as pi-git's local /git wt fork makes them. A receipt
//                  per request id: a replay reuses its worktree; one that no longer matches fails.
//   repo-status    the repository there: branch, HEAD, upstream ahead/behind, worktrees, and
//                  whether it has the source commit.
// At the source: `forkWorktreeOnNode` (plan, bundle what is missing, add) and `repoStatusOnNode`.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, hostname, tmpdir } from 'node:os';
import { MAX_BUNDLE, VERSION, atomicWrite, boundedRead, exists, fail, hash, privateDir, readJson, requestDir, run, withLock, writeJson } from './io.js';
import { decodeGitBundle, repository } from './git.js';

const git = (cwd, args, options) => run('git', ['-C', cwd, ...args], options);
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,100}(?<![./])$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const WORKTREE_ACTIONS = new Set(['worktree-plan', 'worktree-add', 'repo-status']);

/** Where pi-git puts worktrees on this machine: $XDG_STATE_HOME/pi-daemon/worktrees (or ~/.local/state/...). */
export function nodeWorktreesRoot(env = process.env) {
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(env.HOME || homedir(), '.local', 'state');
  return join(state, 'pi-daemon', 'worktrees');
}

function validate(payload) {
  if (!payload || payload.version !== VERSION) fail('protocol', 'Unsupported peer protocol');
  requestDir('incoming', payload.id);
  const repo = payload.repository;
  if (!repo || typeof repo !== 'object') fail('protocol', 'A worktree request names its repository');
  const path = repo.homeRelativeRoot;
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\0\r\n]/.test(path) || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    fail('destination-repo', 'The repository must lie under HOME on both machines');
  }
  if (repo.remote !== null && repo.remote !== undefined && (typeof repo.remote !== 'string' || repo.remote.length > 4096 || /[\0\r\n]/.test(repo.remote))) fail('protocol', 'Invalid origin');
  if (payload.action !== 'repo-status') {
    if (!COMMIT.test(repo.commit || '')) fail('protocol', 'Invalid Git commit identity');
    if (typeof payload.branch !== 'string' || !BRANCH_NAME.test(payload.branch)) fail('worktree-name', `Not a usable worktree/branch name: ${payload.branch}`);
  }
}

const repoPathOf = repo => resolve(homedir(), repo.homeRelativeRoot);
const hasCommit = async (repo, commit) => (await git(repo, ['cat-file', '-e', `${commit}^{commit}`], { allowFailure: true })).code === 0;
const worktreePath = (repo, branch) => join(nodeWorktreesRoot(), basename(repo), branch.replace(/\//g, '-'));

async function assertRoot(repoPath) {
  const top = (await git(repoPath, ['rev-parse', '--show-toplevel'], { allowFailure: true })).stdout.trim();
  if (!top || await realpath(top) !== await realpath(repoPath)) fail('destination-repo', `${repoPath} is not a repository root here`);
}

async function plan(payload) {
  const repo = payload.repository;
  const repoPath = repoPathOf(repo);
  let cloned = false;
  if (!(await exists(repoPath))) {
    if (!repo.remote) fail('clone-required', `${repoPath} is missing here and the repository has no origin to clone it from`);
    await privateDir(dirname(repoPath));
    await run('git', ['clone', '--no-checkout', '--', repo.remote, repoPath], { timeout: 600000 });
    cloned = true;
  } else {
    await assertRoot(repoPath);
    // What is pushed already: the bundle carries only the rest.
    if (repo.remote) await git(repoPath, ['fetch', '--no-tags', '--quiet', 'origin'], { allowFailure: true, timeout: 300000 });
  }
  const heads = Array.isArray(payload.remoteHeads) ? payload.remoteHeads.filter(head => COMMIT.test(head)).slice(0, 256) : [];
  const have = [];
  for (const head of heads) if (await hasCommit(repoPath, head)) have.push(head);
  return { requestId: payload.id, host: hostname(), repo: repoPath, cloned, hasCommit: await hasCommit(repoPath, repo.commit), have, cwd: worktreePath(repoPath, payload.branch) };
}

async function add(payload) {
  const repo = payload.repository;
  const repoPath = repoPathOf(repo);
  const dir = requestDir('incoming', payload.id);
  return withLock(dir, async () => {
    const receiptPath = join(dir, 'worktree.json');
    const saved = await readJson(receiptPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (saved) {
      // A replay: the same worktree, if it is still that one.
      const head = (await git(saved.path, ['rev-parse', 'HEAD'], { allowFailure: true })).stdout.trim();
      if (head !== saved.commit) fail('worktree-conflict', `The worktree ${saved.path} made for this request no longer matches it`);
      return saved;
    }
    if (!(await exists(repoPath))) fail('destination-repo', `${repoPath} is missing here: plan the fork first`);
    await assertRoot(repoPath);
    if (!(await hasCommit(repoPath, repo.commit))) {
      if (!payload.bundle) fail('git-objects', 'The source commit is not here; send its bundle');
      const path = join(dir, 'objects.bundle');
      if (!(await exists(path))) await atomicWrite(path, decodeGitBundle(payload.bundle));
      await git(repoPath, ['bundle', 'verify', path]);
      await git(repoPath, ['fetch', '--no-tags', '--no-write-fetch-head', path, 'refs/heads/session-fork']);
      if (!(await hasCommit(repoPath, repo.commit))) fail('git-objects', 'The bundle did not bring the source commit');
    }
    const path = worktreePath(repoPath, payload.branch);
    if (await exists(path)) fail('worktree-exists', `${path} exists here already: choose another name`);
    const branch = (await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${payload.branch}`], { allowFailure: true })).stdout.trim();
    if (branch && branch !== repo.commit) fail('branch-exists', `Branch ${payload.branch} exists here at another commit (${branch.slice(0, 8)})`);
    await privateDir(dirname(path));
    await git(repoPath, branch ? ['worktree', 'add', '--', path, payload.branch] : ['worktree', 'add', '-b', payload.branch, '--', path, repo.commit]);
    const receipt = { requestId: payload.id, host: hostname(), repo: repoPath, path, branch: payload.branch, commit: repo.commit, created: !branch };
    await writeJson(receiptPath, receipt);
    return receipt;
  });
}

async function status(payload) {
  const repo = payload.repository;
  const repoPath = repoPathOf(repo);
  const base = { requestId: payload.id, host: hostname(), repo: repoPath };
  if (!(await exists(repoPath))) return { ...base, exists: false };
  await assertRoot(repoPath);
  const branch = (await git(repoPath, ['branch', '--show-current'], { allowFailure: true })).stdout.trim();
  const head = (await git(repoPath, ['rev-parse', 'HEAD'], { allowFailure: true })).stdout.trim();
  const counts = (await git(repoPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { allowFailure: true })).stdout.trim().split(/\s+/);
  const worktrees = parsePorcelain((await git(repoPath, ['worktree', 'list', '--porcelain'], { allowFailure: true })).stdout);
  return {
    ...base,
    exists: true,
    branch,
    head,
    ...(counts.length === 2 ? { behind: Number(counts[0]), ahead: Number(counts[1]) } : {}),
    worktrees,
    ...(COMMIT.test(repo.commit || '') ? { hasCommit: await hasCommit(repoPath, repo.commit) } : {}),
  };
}

function parsePorcelain(text) {
  const trees = [];
  let current;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('worktree ')) trees.push(current = { path: line.slice(9), branch: '', head: '' });
    else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return trees.slice(0, 64);
}

/** A worktree peer action, on the node. */
export async function worktreePeer(payload) {
  validate(payload);
  if (payload.action === 'worktree-plan') return plan(payload);
  if (payload.action === 'worktree-add') return add(payload);
  return status(payload);
}

/**
 * A bundle of the commits up to `commit` that `have` (commits the node has) do not reach: the
 * source's unpushed work, bounded; isolated as session-fork's, so the source repository gets no refs.
 */
export async function thinBundle(repo, have = []) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-git-wt-'));
  try {
    const path = join(dir, 'objects.bundle');
    await run('git', ['init', '--bare', '--quiet', join(dir, 'pack')]);
    const objects = (await git(repo.root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).stdout.trim();
    await atomicWrite(join(dir, 'pack', 'objects', 'info', 'alternates'), `${objects}\n`);
    await run('git', ['--git-dir', join(dir, 'pack'), 'update-ref', 'refs/heads/session-fork', repo.commit]);
    await run('git', ['--git-dir', join(dir, 'pack'), 'bundle', 'create', path, 'refs/heads/session-fork', ...(have.length ? ['--not', ...have] : [])], { timeout: 600000 });
    const bytes = await boundedRead(path, MAX_BUNDLE);
    return { sha256: hash(bytes), data: bytes.toString('base64') };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** The source's origin heads: what the node may have already. */
async function originHeads(repo) {
  const listed = await git(repo.root, ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin'], { allowFailure: true });
  return [...new Set(listed.stdout.split('\n').map(line => line.trim()).filter(line => COMMIT.test(line)))].slice(0, 256);
}

/** The request id of a fork: the same repository, commit, branch and node is the same request. */
export function worktreeRequestId(parts) {
  return `wt-${hash(JSON.stringify(parts)).slice(0, 40)}`;
}

/**
 * `/git wt fork NAME @node`, at the source: the repository here (refused when dirty unless
 * `dirty: 'omit'`), its worktree on branch NAME on `node`, cloned there when missing, with the
 * commits the node lacks. `call(payload)` reaches the node's peer (session-fork's peerCall).
 */
export async function forkWorktreeOnNode(cwd, name, node, { dirty, call }) {
  if (!BRANCH_NAME.test(name)) fail('worktree-name', `Not a usable worktree/branch name: ${name}`);
  const repo = await repository(cwd);
  if (!repo) fail('source', "This session's directory is not in a git repository");
  if (repo.dirty && dirty !== 'omit') fail('source-dirty', `${repo.root} has uncommitted changes: commit them, or /git wt fork ${name} @${node} --dirty omit (they stay here)`);
  if (repo.homeRelativeRoot === null) fail('destination-repo', `${repo.root} is outside HOME: ${node} cannot put it at the same place`);
  if (!repo.commit) fail('source', 'The repository has no commit yet');
  const id = worktreeRequestId([hostname(), repo.root, repo.commit, name, node]);
  const base = { version: VERSION, id, repository: repo, branch: name };
  const planned = await call({ ...base, action: 'worktree-plan', remoteHeads: await originHeads(repo) });
  const bundle = planned.hasCommit ? undefined : await thinBundle(repo, planned.have ?? []);
  const added = await call({ ...base, action: 'worktree-add', ...(bundle ? { bundle } : {}) });
  return { host: node, path: added.path, branch: added.branch, created: added.created, commit: repo.commit, cloned: planned.cloned === true, sent: bundle !== undefined };
}

/** `/git @node`: this repository's state on `node`. */
export async function repoStatusOnNode(cwd, node, { call }) {
  const repo = await repository(cwd);
  if (!repo) fail('source', "This session's directory is not in a git repository");
  if (repo.homeRelativeRoot === null) fail('destination-repo', `${repo.root} is outside HOME`);
  return call({ version: VERSION, id: worktreeRequestId(['status', hostname(), repo.root, node, Date.now()]), action: 'repo-status', repository: repo });
}
