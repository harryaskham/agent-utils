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
  - **The repo sidebar:** the focused session's repository shows in pi-client's sidebar, under the sessions: branch and project, upstream with ahead/behind, changes, and whether it is a worktree. It uses Pi's `setWidget` with pi-client's `placement: "sidebar"`, and only where `ctx.ui.hasSidebar`.
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
| `/git wt fork NAME` | A worktree on a new branch `NAME` from HEAD (or on `NAME` if it exists), under `$XDG_STATE_HOME/pi-daemon/worktrees/<project>/<NAME>` (default `~/.local/state/...`) |
| `/git wt fork NAME @node [--dirty omit]` | The same on another pi-daemon node, and this conversation continued there (below) |
| `/git @node` | This repository on that node: its branch, HEAD, ahead/behind its upstream, worktrees, and whether it has this HEAD |
| `/repo` | pi-client: pick another session in this repository or its worktrees, and open it |

After `/git wt fork`, the client part opens a session in the new worktree, carrying the conversation, where pi-client lets plugins open sessions. Elsewhere it tells you to `/cd` there.

### Another node: `/git wt fork NAME @node` (bd-9fcd6a)

`@node` is a pi-daemon host of pi-client's fleet, reached over SSH by the same name (`ssh node` must work without a prompt, with agent-utils' `pi-session` installed there). It reuses session-fork's peer channel (`pi-session _peer`), git only:

1. The repository at the same HOME-relative path on the node, cloned from this one's origin when it is missing there (fetched from origin when present). A repository outside HOME, or one missing there with no origin, is refused.
2. The commits the node lacks, unpushed ones included, in a thin bundle (only what the node's origin heads do not reach). No refs are written here.
3. A worktree on branch `NAME` at this HEAD under the node's `pi-daemon/worktrees/<project>/<NAME>`. A branch `NAME` there at another commit is refused, not moved. A dirty tree here is refused unless `--dirty omit` (the changes stay here).
4. The session: the client part asks pi-client for one on that node in the worktree, carrying this conversation (`ctx.sessions.create({ host, cwd, title, carry })`, pi-daemon's cross-host clone, bd-cd7999), which adds a note that it moved. Without it, it says `/cd @node DIR`.

Each fork has a request id from the repository, commit, branch and node: the same fork again reuses its worktree (a receipt on the node), and one that no longer matches fails rather than being redone.

## Environment

- `PI_GIT_SSH_COMMAND` becomes git's `GIT_SSH_COMMAND` (git-ssh-multiplex and the like). Only commands that reach a remote use it; the refresh never fetches.
- `PI_GH_COMMAND` is reserved for PR state, which comes later.
