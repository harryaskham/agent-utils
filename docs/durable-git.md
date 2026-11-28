# pi-git: git for pi-daemon sessions (agent-utils)

A pi-daemon plugin in two parts. pi-daemon itself knows nothing of git.

- **Daemon part:** `extensions/durable/git.mjs`, a profile module.
  - **After each turn** (`agent_end`), its observer reads the session directory's git state on the session's host.
  - **What it reads:** the branch (or detached commit), upstream with ahead/behind, staged/modified/untracked/conflicted counts, lines added and removed against HEAD, and the repository and worktree roots.
  - **Where it goes:** the module's per-session state, the Durable document `pi-daemon.module-state` keyed `git`.
  - **How it stays safe:** the refresh is started and left to run, never inside a tool call.
    - A newer refresh aborts an older one.
    - git is killed after 5s.
    - A slow repository is refreshed less often (backoff from 30s up to 10 minutes).
    - It reads with `--no-optional-locks`, so it never takes the index lock the agent's own git may want.
    - The result is one state write.
- **Client part:** `extensions/durable/git-client.js`, for pi-client.
  - It follows that document for the focused session, and for each pane the editor chips draw.
  - It publishes the state on Pi's event bus (`agent-utils:git.v1`). The branch and diff chips use it in place of running git themselves, so they work for remote sessions too.
  - **The repo sidebar:** the focused session's repository shows in pi-client's sidebar, under the sessions: branch and project, upstream with ahead/behind, changes, and whether it is a worktree. It uses Pi's `setWidget` with pi-client's `placement: "sidebar"`, and only where `ctx.ui.hasSidebar` (with the sidebar hidden, as in Rex workspaces, pi-client shows it above the editor). When the editor chips already draw the session's branch and diff, the panel leaves its repository out and lists only the repositories `git_track` follows.
  - **Sidebar segments:** pi-client's `client.sidebar.rows` can name `branch` (`⎇ main`, or `detached` and the commit) and `repo` (the project). They show for the sessions the client part follows, those open in a pane, and are blank for the rest.
  - **`/repo`:** switch to another session in the same repository or one of its worktrees, on the same host, newest first. The state lists the repository's worktrees for it.
  - In TUI Pi it does nothing, and the chips run git locally as before.

## The agent's tool: `git_track`

`git_track { path, stop? }` lets the agent follow another repository in its session, such as one it works in beside the session's directory.

- **Where it's recorded:** the repository's top level (`path` may be relative to the session's directory) goes into a session document (`agent-utils.git-tracked`), at most 8.
- **After each turn,** the observer refreshes each followed repository, bounded like the session's own, into the module state's `tracked`. It reads the document with pi-daemon's observer `ctx.snapshot`; on an older pi-daemon a repository's state shows only once, when it's first followed.
- **The sidebar** lists the followed repositories under the session's own.
- **Managing them:** `stop: true` stops following one; with no `path`, the tool lists those followed.

No tool is wrapped to guess which repository the agent touched: the agent says so.

## Commands

| Command | What it does |
| --- | --- |
| `/git` (or `/git status`) | Refresh now and show the state in one line |
| `/git wt list` | The repository's worktrees |
| `/git wt fork NAME` | A worktree on a new branch `NAME` from HEAD (or on `NAME` if it exists), under `$XDG_STATE_HOME/pi-daemon/worktrees/<project>/<NAME>` (default `~/.local/state/...`), and a session there with this conversation (below) |
| `/git wt fork NAME --no-session` | The worktree only |
| `/git wt fork NAME --rebase[=BASE]` | The same, with branch `NAME` on `BASE` fetched just now (below) |
| `/git wt fork NAME @node [--dirty omit]` | The same on another pi-daemon node, and this conversation continued there (below); `--rebase[=BASE]` works there too |
| `/git wt fork NAME focus=TEXT mode=work\|qa` | The same, with the fork in its own lane: it gets a role note, this session a notice, its chip shows the lane, and `mode=qa` makes it without the edit and write tools ([fork lanes](fork-lanes.md)) |
| `/git fork [NAME] [focus=TEXT] [mode=work\|qa]` | A session in this same directory with this conversation (no worktree), with a lane when given; pi-client's client part opens it |
| `/git lane` | This session's fork lane, if it has one |
| `/git @node` | This repository on that node: its branch, HEAD, ahead/behind its upstream, worktrees, and whether it has this HEAD |
| `/repo` | pi-client: pick another session in this repository or its worktrees, and open it |

### The fork's session

`/git wt fork` makes the fork's session itself, before it answers, so every client lists it at once: pi-client, the web view, Culture and ag, with or without pi-git's client part. It is titled `NAME`, starts in the worktree, and has this conversation as of the command:

- **This host:** pi-daemon's own `sessions.create` with `fork` (1.14 or later). pi-daemon copies the conversation, reasoning included, with its profile, model and thinking level, and adds its note that the directory changed.
  - The create says it is a fork (`kind: "fork"`) and, where pi-daemon tells the module (1.15), which command of a client asked (`fork.requestId`). pi-daemon marks this session with where its conversation went on: both sessions go on, no other client is moved, and the client that typed the command knows the session as its own, so Culture follows its own fork. A pi-daemon that marks nothing ignores both.
- **`@node`:** a session made on that node over its `/chord`, a host of Pi's `settings.json` `client.hosts` (bearer from `client.tokenFile` or the host's `tokenFile`). It is made with this session's profile where the node has it, and this conversation's model and thinking level, else the node's defaults. This conversation's model context is imported there (`conversation.import`) with the note pi-daemon's cross-host clone adds, that it moved. A failed import removes the session made there.

With `focus=` or `mode=` ([fork lanes](fork-lanes.md), bd-fd98a3), the session made is given its lane: a qa fork is made with this session's built-in tools less `edit` and `write`, then pi-git's own `/git lane apply` runs in it (its role note and its lane, for the chips), and this conversation keeps a notice of the fork, written after the copy. On another node the role note ends the imported context. A lane needs the session, so `--no-session` with one is refused.

The same fork asked again (a retried command) makes no second session: its request id comes from the session, conversation, worktree, title and time of the command.

In pi-client, the client part then opens that session in the pane the fork was typed in. A client without the client part shows the notice: pick the session from the session list. When no session can be made (a pi-daemon before 1.14, a node not in `client.hosts`, or a failure, which the notice names), the fork's record says so and pi-client's client part makes one as before (`ctx.sessions.create` carrying the conversation). Elsewhere `/cd` (or `/cd @node DIR`) continues the conversation there. With `--no-session`, nothing opens.

### A fresh base: `/git wt fork NAME --rebase[=BASE]` (bd-658ee5)

The fork starts on the base as it is now, not as this checkout last saw it. Before any worktree is made:

1. **Which base:** `BASE` is a branch of `origin` (`--rebase=main`, or `--rebase main` after `NAME`), or of another remote when it starts with that remote's name (`--rebase=upstream/main`). Plain `--rebase` takes origin's default branch (`refs/remotes/origin/HEAD`), else `main`.
2. **Fetched:** `git fetch` of that branch into its remote-tracking ref (`origin/main`), within 5 minutes. A fetch that fails forks nothing.
3. **Where the branch starts:** HEAD (or branch `NAME`, when it exists) rebased onto the base:
   - HEAD is behind the base, or the base has HEAD's own changes already (merged, squash-merged or cherry-picked; `git merge-tree`): the base itself;
   - HEAD contains the base already: HEAD as it is;
   - otherwise HEAD's own commits are replayed onto the base, in a temporary detached worktree that writes no refs and runs no hooks. This checkout, its branch and its working tree stay as they are.
4. **A conflict** aborts that rebase and is reported, naming the commit it stopped at and the conflicted files. Nothing is forked: no worktree, no branch made or moved, and no session opens on the old base.
5. **The base is said:** this conversation keeps a note (a user message written with no turn, as `/splice` writes them) of the worktree, the branch's commit, and the base: its ref, full commit, subject, and when it was fetched. The note is written before the fork's session is made, so that session carries it as its first new message, before pi-daemon's note that the directory changed. The notice says the same, and the client part says the base as it opens the fork. While this conversation is working the note lands when its turn ends, so a session opened before then lacks it (the notice says so).

An existing branch `NAME` is moved to its rebased commit (`git worktree add -B`), and the note says where it was.

With `@node`, the rebase is done here, and the node gets the rebased commit as it gets HEAD otherwise (only the commits it lacks are sent). The node's peer protocol is unchanged, so a node on an older agent-utils takes it.

### Another node: `/git wt fork NAME @node` (bd-9fcd6a)

`@node` is a pi-daemon host of pi-client's fleet, reached over SSH by the same name (`ssh node` must work without a prompt, with agent-utils' `pi-session` installed there). It reuses session-fork's peer channel (`pi-session _peer`), git only:

1. The repository at the same HOME-relative path on the node, cloned from this one's origin when it is missing there (fetched from origin when present). A repository outside HOME, or one missing there with no origin, is refused.
2. The commits the node lacks, unpushed ones included, in a thin bundle (only what the node's origin heads do not reach). No refs are written here.
3. A worktree on branch `NAME` at this HEAD under the node's `pi-daemon/worktrees/<project>/<NAME>`. A branch `NAME` there at another commit is refused, not moved. A dirty tree here is refused unless `--dirty omit` (the changes stay here).
4. The session on that node, as above. Where it cannot be made, pi-client's client part asks for one there carrying this conversation (`ctx.sessions.create({ host, cwd, title, carry })`, pi-daemon's cross-host clone, bd-cd7999). Without the client part, it says `/cd @node DIR`.

Each fork has a request id from the repository, commit, branch and node: the same fork again reuses its worktree (a receipt on the node), and one that no longer matches fails rather than being redone.

## Environment

- `PI_GIT_SSH_COMMAND` becomes git's `GIT_SSH_COMMAND` (git-ssh-multiplex and the like). Only commands that reach a remote use it; the refresh never fetches.
- `PI_GH_COMMAND` is reserved for PR state, which comes later.
