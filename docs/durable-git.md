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
  - **`/repo`:** switch to another session in the same repository or one of its worktrees, on the same host, newest first. The state lists the repository's worktrees for it.
  - In TUI Pi it does nothing, and the chips run git locally as before.

## Commands

| Command | What it does |
| --- | --- |
| `/git` (or `/git status`) | Refresh now and show the state in one line |
| `/git wt list` | The repository's worktrees |
| `/git wt fork NAME` | A worktree on a new branch `NAME` from HEAD (or on `NAME` if it exists), under `$XDG_STATE_HOME/pi-daemon/worktrees/<project>/<NAME>` (default `~/.local/state/...`) |
| `/repo` | pi-client: pick another session in this repository or its worktrees, and open it |

After `/git wt fork`, the client part opens a session in the new worktree, carrying the conversation, where pi-client lets plugins open sessions. Elsewhere it tells you to `/cd` there.

## Environment

- `PI_GIT_SSH_COMMAND` becomes git's `GIT_SSH_COMMAND` (git-ssh-multiplex and the like). Only commands that reach a remote use it; the refresh never fetches.
- `PI_GH_COMMAND` is reserved for PR state, which comes later.
