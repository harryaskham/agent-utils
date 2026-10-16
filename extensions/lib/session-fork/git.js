import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir, hostname, tmpdir } from 'node:os';
import { MAX_BUNDLE, atomicWrite, boundedRead, exists, fail, hash, localPath, privateDir, run, writeJson } from './io.js';

const git = (cwd, args, options) => run('git', ['-C', cwd, ...args], options);
export const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 48) || 'fork';
export async function repository(cwd) {
  const probe = await git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (probe.code) {
    if (/not a git repository/i.test(probe.stderr)) return null;
    fail('git', `Cannot inspect source repository: ${probe.stderr.trim()}`);
  }
  const top = probe.stdout.trim();
  const common = (await git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  const standardLayout = basename(common) === '.git';
  const root = standardLayout ? dirname(common) : top;
  const remoteResult = await git(root, ['remote', 'get-url', 'origin'], { allowFailure: true });
  const remote = remoteResult.code === 0 ? remoteResult.stdout.trim() : null;
  if (remote && /^https?:\/\//i.test(remote)) {
    const url = new URL(remote);
    if (url.username || url.password) fail('git-credential', 'Git remote embeds credentials; use credential helpers or an SSH remote before forking');
  }
  const rel = relative(homedir(), root);
  return {
    root, standardLayout, homeRelativeRoot: !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') ? rel : null,
    remote, commit: (await git(top, ['rev-parse', 'HEAD'])).stdout.trim(),
    branch: (await git(top, ['branch', '--show-current'])).stdout.trim(),
    dirty: !!(await git(top, ['status', '--porcelain=v1', '--untracked-files=normal'])).stdout,
  };
}
export async function destinationPlan(request) {
  const o = request.options; const repo = request.repository;
  const crossHost = !!(o.remote || o.from);
  const cwdBase = homedir();
  let repoPath;
  if (o.repo) repoPath = localPath(o.repo, cwdBase);
  else if (repo) {
    if (!crossHost) repoPath = repo.root;
    else if (repo.homeRelativeRoot !== null) repoPath = resolve(homedir(), repo.homeRelativeRoot);
    else if (!o.cwd) fail('destination-repo', 'Source repo is outside HOME; specify --repo on the destination');
  }
  let cwd;
  if (o.cwd) cwd = localPath(o.cwd, o.remote ? cwdBase : request.invocationCwd);
  else if (repo) {
    const worktreeRoot = o.worktreeRoot ? localPath(o.worktreeRoot, cwdBase) : join(homedir(), o.herdr ? '.herdr' : '.pi', 'worktrees');
    cwd = join(worktreeRoot, slug(basename(repoPath)), o.worktree || slug(request.name));
  } else {
    if (o.worktree || o.repo || o.clone) fail('destination', 'Git worktree options require a Git source');
    if (crossHost && request.origin.cwd !== request.origin.home) fail('destination', 'For a non-Git source outside HOME, specify destination --cwd');
    cwd = crossHost ? homedir() : request.origin.cwd;
  }
  const makeWorktree = !o.cwd && !!repo;
  if (makeWorktree && repo.standardLayout === false) fail('git-layout', 'Separate-git-dir repositories need an explicit existing --cwd; automatic worktrees expect a normal Git common directory');
  const plan = { host: hostname(), home: homedir(), cwd, repo: repoPath ?? null, makeWorktree, repoExists: false, hasCommit: false };
  if (makeWorktree) {
    plan.repoExists = await exists(repoPath);
    if (plan.repoExists) {
      const top = (await git(repoPath, ['rev-parse', '--show-toplevel'])).stdout.trim();
      if (await realpath(top) !== await realpath(repoPath)) fail('destination-repo', 'Destination --repo must be a repository root, not a subdirectory');
      plan.hasCommit = (await git(repoPath, ['cat-file', '-e', `${repo.commit}^{commit}`], { allowFailure: true })).code === 0;
    } else if (!o.clone || !repo.remote) {
      fail('clone-required', `Destination repository is missing: ${repoPath}. Supply --repo or explicitly use --clone with an origin remote.`);
    }
  } else {
    const info = await stat(cwd).catch(() => null);
    if (!info?.isDirectory()) fail('destination-cwd', `Destination cwd must exist: ${cwd}`);
    if (repo) {
      const targetCommit = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
      if (targetCommit !== repo.commit) fail('destination-commit', 'Existing destination cwd is at a different commit; use a new worktree or align it yourself');
      const sameSource = !crossHost && await realpath(cwd) === await realpath(request.origin.cwd);
      if (!sameSource && (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=normal'])).stdout) fail('destination-dirty', 'Existing destination working tree is dirty; use another cwd');
      plan.hasCommit = true;
    }
  }
  return plan;
}
export async function makeGitBundle(repo) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fork-git-'));
  try {
    const path = join(dir, 'objects.bundle');
    // A linked worktree may have a different HEAD than the main checkout. A raw
    // commit alone is not an advertised bundle ref. Give the exact captured
    // commit a temporary ref in an isolated bare repo, not the source repo.
    await run('git', ['init', '--bare', '--quiet', join(dir, 'pack')]);
    const objects = (await git(repo.root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).stdout.trim();
    await atomicWrite(join(dir, 'pack', 'objects', 'info', 'alternates'), `${objects}\n`);
    await run('git', ['--git-dir', join(dir, 'pack'), 'update-ref', 'refs/heads/session-fork', repo.commit]);
    await run('git', ['--git-dir', join(dir, 'pack'), 'bundle', 'create', path, 'refs/heads/session-fork']);
    const bytes = await boundedRead(path, MAX_BUNDLE);
    return { sha256: hash(bytes), data: bytes.toString('base64') };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export function decodeGitBundle(bundle) {
  if (!bundle || typeof bundle.data !== 'string' || bundle.data.length > Math.ceil(MAX_BUNDLE * 4 / 3) + 4 || !/^[a-f0-9]{64}$/.test(bundle.sha256 || '')) fail('integrity', 'Invalid Git bundle');
  const bytes = Buffer.from(bundle.data, 'base64');
  if (bytes.length > MAX_BUNDLE || hash(bytes) !== bundle.sha256) fail('integrity', 'Invalid Git bundle checksum');
  return bytes;
}
export async function prepareGit(request, plan, dir, bundle) {
  if (!plan.makeWorktree) return;
  const repo = request.repository;
  if (!(await exists(plan.repo))) {
    if (!request.options.clone || !repo.remote) fail('clone-required', 'Cloning was not authorized');
    await privateDir(dirname(plan.repo));
    await run('git', ['clone', '--no-checkout', '--', repo.remote, plan.repo]);
  }
  if ((await git(plan.repo, ['cat-file', '-e', `${repo.commit}^{commit}`], { allowFailure: true })).code !== 0) {
    if (!bundle) fail('git-objects', 'Exact source commit is unavailable; retry with its saved Git bundle');
    const bytes = decodeGitBundle(bundle);
    const path = join(dir, 'objects.bundle');
    if (!(await exists(path))) await atomicWrite(path, bytes);
    await git(plan.repo, ['bundle', 'verify', path]);
    await git(plan.repo, ['fetch', '--no-tags', '--no-write-fetch-head', path, 'refs/heads/session-fork']);
    await git(plan.repo, ['cat-file', '-e', `${repo.commit}^{commit}`]);
  }
  const admitted = join(dir, 'worktree-admitted.json');
  if (await exists(plan.cwd)) {
    if (!(await exists(admitted))) fail('worktree-exists', `Worktree destination already exists: ${plan.cwd}. Choose another name or explicit --cwd.`);
    const target = await repository(plan.cwd);
    const expectedCommon = (await git(plan.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
    const actualCommon = (await git(plan.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
    if (!target || target.commit !== repo.commit || target.dirty || await realpath(expectedCommon) !== await realpath(actualCommon)) fail('worktree-conflict', 'Previously admitted worktree no longer matches the fork');
    return;
  }
  if (!(await exists(admitted))) await writeJson(admitted, { cwd: plan.cwd, commit: repo.commit });
  await privateDir(dirname(plan.cwd));
  await git(plan.repo, ['worktree', 'add', '--detach', '--', plan.cwd, repo.commit]);
}
