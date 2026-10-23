// pi-git's client part, for pi-client: each session's git state, as git.mjs reads it on the
// session's host after each turn, published for the editor chips (branch, diff) of whichever pane
// draws that session, so they work for remote sessions too and run no git of their own there.
// It follows git.mjs's module state (pi-daemon's `pi-daemon.module-state` document, key "git")
// through pi-client's ctx.chord.watchDocument: the focused session's, and any a consumer asks
// for while drawing its pane. After /git wt fork, it opens a session in the new worktree,
// carrying the conversation (pi-client's ctx.sessions). In TUI Pi (no ctx.chord) it does nothing.
import { GIT_EVENT, GIT_REQUEST, GIT_STATE_DOC } from "../lib/git-indicator.js";

export default function gitClient(pi, { maxSessions = 32 } = {}) {
  // sessionId -> { workspace, forkedAt, stop, stopped }
  const sessions = new Map();
  let live;

  const sessionIdOf = (ctx) => {
    try {
      return ctx?.sessionManager?.getSessionId?.();
    } catch {
      return undefined;
    }
  };
  const publish = (sessionId) => {
    const entry = sessions.get(sessionId);
    if (entry?.workspace) pi.events?.emit?.(GIT_EVENT, { sessionId, workspace: entry.workspace });
  };

  // A /git wt fork in this session: a session in the worktree, with this conversation.
  const openForked = async (forked) => {
    const sessionsApi = live?.sessions;
    if (typeof sessionsApi?.create !== "function") {
      live?.ui?.notify?.(`Worktree ready: /cd ${forked.path} continues this conversation there.`, "info");
      return;
    }
    try {
      await sessionsApi.create({ cwd: forked.path, title: forked.branch, carry: true });
    } catch (error) {
      live?.ui?.notify?.(`Cannot open a session in ${forked.path}: ${error?.message ?? error}`, "error");
    }
  };

  // Follow a session's git state; `ctx` refers to that session now (pi-client binds the watch to
  // the pane the ctx refers to when it is called).
  const follow = (ctx, sessionId) => {
    if (!sessionId || sessions.has(sessionId) || typeof ctx?.chord?.watchDocument !== "function") return;
    const entry = { workspace: undefined, forkedAt: undefined, stop: undefined, stopped: false };
    sessions.set(sessionId, entry);
    while (sessions.size > maxSessions) {
      const [oldest, gone] = sessions.entries().next().value;
      sessions.delete(oldest);
      gone.stopped = true;
      gone.stop?.();
    }
    Promise.resolve(
      ctx.chord.watchDocument(GIT_STATE_DOC, (value) => {
        if (entry.stopped) return;
        const values = value?.values ?? {};
        if (values.workspace && typeof values.workspace === "object") {
          entry.workspace = values.workspace;
          publish(sessionId);
        }
        const forked = values.forked;
        const at = Number(forked?.at);
        // The first value is history: only a fork made while followed opens a session.
        if (entry.forkedAt === undefined) entry.forkedAt = Number.isFinite(at) ? at : 0;
        else if (Number.isFinite(at) && at > entry.forkedAt && typeof forked.path === "string") {
          entry.forkedAt = at;
          if (sessionIdOf(live) === sessionId) void openForked(forked);
        }
      }),
    ).then(
      (stopper) => {
        if (entry.stopped) stopper?.();
        else entry.stop = stopper;
      },
      () => sessions.delete(sessionId),
    );
  };

  pi.events?.on?.(GIT_REQUEST, (data) => {
    const sessionId = data?.sessionId ? String(data.sessionId) : undefined;
    if (!sessionId) return;
    if (sessions.has(sessionId)) return publish(sessionId);
    // pi-client's live ctx refers to the pane being drawn: follow it when it is that session's.
    if (sessionIdOf(live) === sessionId) follow(live, sessionId);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (typeof ctx?.chord?.watchDocument !== "function") return;
    live = ctx;
    follow(ctx, sessionIdOf(ctx));
  });

  pi.on("session_shutdown", async () => {
    for (const entry of sessions.values()) {
      entry.stopped = true;
      entry.stop?.();
    }
    sessions.clear();
  });
}
