// pi-git's daemon part, for pi-daemon profiles: each session's git state (branch, upstream,
// changes, worktree), read on the session's host after each turn, in the background and
// cancellably, into this module's per-session state; and /git (status), /git wt list,
// /git wt fork NAME. pi-daemon knows nothing of git. The client part is git-client.js
// (pi-client: the editor chips for any session, local or remote). Behaviour: ../lib/durable-git.js.
import { createGitCommands, createGitObserver, createGitRefresher } from "../lib/durable-git.js";

const refresher = createGitRefresher();

export const observe = createGitObserver(refresher);
export const commands = createGitCommands(refresher);
