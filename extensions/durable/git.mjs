// pi-git's daemon part, for pi-daemon profiles: each session's git state (branch, upstream,
// changes, worktree), read on the session's host after each turn, in the background and
// cancellably, into this module's per-session state; /git (status), /git wt list,
// /git wt fork NAME; and the agent's git_track tool, to follow other repositories too. pi-daemon knows nothing of git. The client part is git-client.js
// (pi-client: the editor chips for any session, local or remote). Behaviour: ../lib/durable-git.js.
import { createGitCommands, createGitObserver, createGitRefresher, createGitTrackTool } from "../lib/durable-git.js";

const refresher = createGitRefresher();

export const observe = createGitObserver(refresher);
export const commands = createGitCommands(refresher);
// git_track: the agent follows another repository (needs pi-daemon's observer ctx.snapshot to
// refresh it after each turn; older hosts show it once, when tracked).
export const extension = { name: "pi-git", tools: [createGitTrackTool()] };
