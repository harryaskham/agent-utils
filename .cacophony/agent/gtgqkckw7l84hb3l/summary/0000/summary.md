# Session summary — /git wt fork NAME --rebase[=BASE]

## Goal

Harry opens nearly every fork with "rebase on main". He asked for the tool to do it rather than a standing preference: an option on pi-git's `/git wt fork NAME` (local and `@node`) that fetches, puts the fork's branch on the named base before the fork's first turn, states the base commit in the fork's first message, and stops with a report on a conflict instead of working on the old base.

## Bead(s)

- `bd-658ee5` — pi-git: /git wt fork NAME --rebase=main, so a fork starts on fresh main
- (related: `bd-9fcd6a` — /git wt fork NAME @node; its owner confirmed nothing in flight in the same files)

## Before state

- `/git wt fork NAME` made branch NAME from HEAD (or checked out an existing NAME) with no fetch; `@node` put the node's worktree at the source's HEAD.
- The agent and Harry learned the base only by running git in the fork.

## After state

- `/git wt fork NAME --rebase[=BASE]` (also `--rebase BASE` after NAME, and `--rebase=upstream/main` for another remote; plain `--rebase` takes origin's default branch, else main):
  - fetches BASE into its remote-tracking ref; if the fetch fails, nothing is forked;
  - places the branch on the base itself when HEAD is behind it or HEAD's changes are already in it (merged or squash-merged, checked with `git merge-tree`); keeps HEAD when it already contains the base; otherwise replays HEAD's own commits onto the base in a temporary detached worktree (no refs, no hooks, `rebase.updateRefs` off), leaving the checkout untouched;
  - on a conflict, aborts and reports the commit it stopped at and the conflicted files, and forks nothing, so no session opens on the old base;
  - notes the base (ref, full commit, subject, fetch time) in the conversation as a user message written with no turn, before the fork's record, so the opened fork carries it as its first new message. The notice and pi-client's "Opening …" line say it too.
- `@node`: the rebase runs at the source, and `forkWorktreeOnNode` takes the result through `commitFor`, so the node's peer protocol is unchanged.
- New and existing pi-git and session-fork tests pass locally; "Check & Lint" is the final gate.

## Diff summary

- Code commit: e066e3ea (the final squash SHA will come from the reintegration receipt)
- Files: `extensions/lib/git-fork-base.js` (new), `extensions/lib/durable-git.js`, `extensions/lib/session-fork/worktree.js`, `extensions/durable/git-client.js`, `extensions/durable/git.mjs`, `docs/durable-git.md`, `test/git-fork-base.test.js` (new)
- Tests: 8 new tests, 0 removed. They use real git throughout: fast-forward with the note, replayed commits, a conflict with nothing forked, a squash-merged branch, an existing branch moved, a failed fetch, a rebase failure that is not a conflict, a remote/branch base, `@node` with two HOMEs, and the client message.
- `runGit` now also returns stderr.

## Operator-takeaway

The base note is written into the forking conversation, and the fork inherits it through pi-daemon's copy. pi-daemon offers no way to add a message only to the new session. The cost is that the source session sees the note too. While the source is mid-turn, the note lands after the fork has been copied, and the notice says so. Draft bd-95ac29 asks pi-daemon for a `note` on `sessions.create`. It is live after the merge, Collective's agent-utils pin update, and a switch with a pi-daemon restart.
