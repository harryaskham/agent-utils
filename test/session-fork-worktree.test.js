// pi-git's /git wt fork NAME @node and /git @node (bd-9fcd6a), on session-fork's peer channel: the
// node clones the repository at the same HOME-relative path from its origin when missing, takes the
// commits it lacks (unpushed work included) from a thin bundle, and adds a worktree on branch NAME.
// Two "nodes" here are two HOMEs; the peer runs in-process under the node's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { peer } from '../extensions/lib/session-fork/core.js';
import { forkWorktreeOnNode, repoStatusOnNode } from '../extensions/lib/session-fork/worktree.js';

const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** Run `fn` as on a node: its HOME, its session-fork state, no XDG state override. */
async function asNode(home, fn) {
  const saved = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home;
  delete process.env.XDG_STATE_HOME;
  process.env.PI_CODING_AGENT_DIR = join(home, '.pi', 'agent');
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test('a worktree on another node: cloned there, unpushed commits sent thin, on branch NAME; replay, dirty, status', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'git-wt-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeA = join(root, 'a');
  const homeB = join(root, 'b');
  const origin = join(root, 'origin.git');
  await mkdir(join(homeA, 'src'), { recursive: true });
  await mkdir(homeB, { recursive: true });
  execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', origin]);
  const source = join(homeA, 'src', 'proj');
  execFileSync('git', ['clone', '--quiet', origin, source], { stdio: 'ignore' });
  await writeFile(join(source, 'a.txt'), 'one\n');
  sh(source, 'add', '.');
  sh(source, 'commit', '--quiet', '-m', 'pushed');
  sh(source, 'push', '--quiet', 'origin', 'HEAD:main');
  sh(source, 'fetch', '--quiet', 'origin');
  await writeFile(join(source, 'b.txt'), 'two\n');
  sh(source, 'add', '.');
  sh(source, 'commit', '--quiet', '-m', 'unpushed');
  const unpushed = sh(source, 'rev-parse', 'HEAD');
  const calls = [];
  const call = (payload) => { calls.push(payload.action); return asNode(homeB, () => peer(payload)); };

  // The node lacks the repository: cloned from origin; the unpushed commit sent; branch try-x.
  const forked = await asNode(homeA, () => forkWorktreeOnNode(source, 'try-x', 'nodeb', { call }));
  const worktree = join(homeB, '.local', 'state', 'pi-daemon', 'worktrees', 'proj', 'try-x');
  assert.deepEqual([forked.path, forked.branch, forked.cloned, forked.sent, forked.created], [worktree, 'try-x', true, true, true]);
  assert.equal(sh(worktree, 'rev-parse', 'HEAD'), unpushed, 'the unpushed commit, there');
  assert.equal(sh(worktree, 'branch', '--show-current'), 'try-x');
  assert.equal(sh(join(homeB, 'src', 'proj'), 'remote', 'get-url', 'origin'), origin, 'the same place under the node\'s HOME');
  assert.deepEqual(calls, ['worktree-plan', 'worktree-add']);
  assert.equal(sh(source, 'for-each-ref', 'refs/heads/session-fork'), '', 'no refs written at the source');

  // The same fork again: its receipt, the same worktree.
  const again = await asNode(homeA, () => forkWorktreeOnNode(source, 'try-x', 'nodeb', { call }));
  assert.equal(again.path, worktree);

  // Dirty: refused with the omit hint; with --dirty omit, the commit only.
  await writeFile(join(source, 'a.txt'), 'changed\n');
  await assert.rejects(() => asNode(homeA, () => forkWorktreeOnNode(source, 'try-y', 'nodeb', { call })), /uncommitted changes: commit them, or \/git wt fork try-y @nodeb --dirty omit/);
  const omitted = await asNode(homeA, () => forkWorktreeOnNode(source, 'try-y', 'nodeb', { dirty: 'omit', call }));
  assert.equal(omitted.cloned, false, 'the repository is there now');
  assert.equal(omitted.sent, false, 'and has the commit: nothing sent');
  assert.equal(sh(omitted.path, 'rev-parse', 'HEAD'), unpushed);
  sh(source, 'checkout', '--quiet', '--', 'a.txt');

  // Another unpushed commit: only it is sent (the node has the rest).
  await writeFile(join(source, 'c.txt'), 'three\n');
  sh(source, 'add', '.');
  sh(source, 'commit', '--quiet', '-m', 'unpushed too');
  const third = await asNode(homeA, () => forkWorktreeOnNode(source, 'try-z', 'nodeb', { call }));
  assert.equal(third.sent, true);
  assert.equal(sh(third.path, 'rev-parse', 'HEAD'), sh(source, 'rev-parse', 'HEAD'));

  // /git @node: the repository there.
  const status = await asNode(homeA, () => repoStatusOnNode(source, 'nodeb', { call }));
  assert.equal(status.exists, true);
  assert.equal(status.hasCommit, true);
  assert.deepEqual(status.worktrees.map((tree) => tree.branch).filter(Boolean).sort(), ['main', 'try-x', 'try-y', 'try-z'].filter((name) => status.worktrees.some((tree) => tree.branch === name)).sort());
  assert.ok(status.worktrees.some((tree) => tree.branch === 'try-x'));

  // No origin and no repository there: refused, saying so.
  const lonely = join(homeA, 'src', 'lonely');
  await mkdir(lonely);
  sh(lonely, 'init', '--quiet');
  await writeFile(join(lonely, 'x'), 'x\n');
  sh(lonely, 'add', '.');
  sh(lonely, 'commit', '--quiet', '-m', 'only here');
  await assert.rejects(() => asNode(homeA, () => forkWorktreeOnNode(lonely, 'w', 'nodeb', { call })), /missing here and the repository has no origin/);
});
