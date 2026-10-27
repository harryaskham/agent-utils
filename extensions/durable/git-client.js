// pi-git's client part, for pi-client: each session's git state, as git.mjs reads it on the
// session's host after each turn, published for the editor chips (branch, diff) of whichever pane
// draws that session, so they work for remote sessions too and run no git of their own there.
// It follows git.mjs's module state (pi-daemon's `pi-daemon.module-state` document, key "git")
// through pi-client's ctx.chord.watchDocument: the focused session's, and any a consumer asks
// for while drawing its pane. After /git wt fork, it opens a session in the new worktree,
// carrying the conversation (pi-client's ctx.sessions). The focused session's repository shows in
// pi-client's sidebar (setWidget's placement "sidebar", where ctx.ui.hasSidebar); /repo switches
// to another session in the same repository or one of its worktrees, on the same host. Sidebar rows
// (pi-client's client.sidebar.rows) can show each followed session's "branch" and "repo". In TUI Pi
// (no ctx.chord) it does nothing.
import { GIT_EVENT, GIT_REQUEST, GIT_STATE_DOC } from "../lib/git-indicator.js";
import { workspacePanel } from "../lib/durable-git.js";

/** The sidebar panel's key. */
export const GIT_PANEL = "pi-git";

/** Whether `path` is `root` or inside it. */
const within = (path, root) => typeof path === "string" && typeof root === "string" && root !== "" && (path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`));

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
  // The focused session's repository in pi-client's sidebar; set again only when it changes.
  let panel;
  const showPanel = () => {
    if (live?.ui?.hasSidebar !== true || typeof live.ui.setWidget !== "function") return;
    const entry = sessions.get(sessionIdOf(live));
    // The session's repository, then those git_track follows.
    const followed = (Array.isArray(entry?.tracked) ? entry.tracked : []).flatMap((tracked) =>
      workspacePanel(tracked) ?? [`✗ ${String(tracked?.path ?? "").split("/").pop()} ${tracked?.error ?? "unavailable"}`],
    );
    const own = workspacePanel(entry?.workspace) ?? [];
    const lines = own.length + followed.length === 0 ? undefined : [...own, ...followed];
    const key = JSON.stringify(lines ?? null);
    if (key === panel) return;
    panel = key;
    live.ui.setWidget(GIT_PANEL, lines, { placement: "sidebar" });
  };
  const publish = (sessionId) => {
    const entry = sessions.get(sessionId);
    if (entry?.workspace) pi.events?.emit?.(GIT_EVENT, { sessionId, workspace: entry.workspace });
    showPanel();
    // The sidebar's branch and repo segments may have changed.
    live?.ui?.requestRender?.();
  };

  // pi-client's sidebar rows (client.sidebar.rows) can name "branch" and "repo" (pi-daemon
  // bd-8e7f67): each session followed here (shown in a pane), else nothing.
  const repository = (session) => {
    const workspace = sessions.get(String(session?.id ?? ""))?.workspace;
    return workspace && workspace.repo !== false ? workspace : undefined;
  };
  pi.registerSidebarSegment?.("branch", (session) => {
    const workspace = repository(session);
    if (!workspace) return undefined;
    return `⎇ ${workspace.branch || (workspace.oid ? `detached ${String(workspace.oid).slice(0, 8)}` : "no commits")}`;
  });
  pi.registerSidebarSegment?.("repo", (session) => repository(session)?.project || undefined);

  // /repo: another session in this repository (its worktrees too), on the same host.
  pi.registerCommand?.("repo", {
    description: "Switch to another session in this repository or its worktrees",
    handler: async (_args, ctx) => {
      const notify = (text) => ctx?.ui?.notify?.(text, "info");
      if (typeof ctx?.sessions?.list !== "function" || typeof ctx.sessions.open !== "function") return notify("/repo needs pi-client.");
      const id = sessionIdOf(ctx);
      const workspace = sessions.get(id)?.workspace;
      if (!workspace?.repo) return notify("/repo: this session's directory is not a git repository (or its state has not arrived yet).");
      const roots = [workspace.mainRoot, ...(Array.isArray(workspace.worktrees) ? workspace.worktrees : [])];
      const rows = ctx.sessions.list();
      const host = rows.find((row) => row.id === id)?.host;
      const others = rows
        .filter((row) => row.id !== id && row.host === host && !row.archived && roots.some((root) => within(row.cwd, root)))
        .sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));
      if (others.length === 0) return notify(`No other session in ${workspace.project}.`);
      const labels = others.map((row, index) => {
        const tree = roots.filter((root) => within(row.cwd, root)).sort((a, b) => b.length - a.length)[0];
        const where = tree === workspace.mainRoot ? workspace.project : tree.split("/").pop();
        return `${index + 1}. ${row.title || row.id} · ${where}${row.busy ? " · working" : ""}`;
      });
      const chosen = await ctx.ui.select(`Sessions in ${workspace.project}`, labels);
      const index = labels.indexOf(chosen);
      if (index < 0) return;
      await ctx.sessions.open(others[index]);
    },
  });

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
        if (values.workspace && typeof values.workspace === "object") entry.workspace = values.workspace;
        if (Array.isArray(values.tracked)) entry.tracked = values.tracked;
        if (entry.workspace || entry.tracked) publish(sessionId);
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
    // Panes are drawn as focus moves: the sidebar follows the focused session's repository.
    showPanel();
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
    if (panel !== undefined && live?.ui?.hasSidebar === true) live.ui.setWidget?.(GIT_PANEL, undefined, { placement: "sidebar" });
    panel = undefined;
    for (const entry of sessions.values()) {
      entry.stopped = true;
      entry.stop?.();
    }
    sessions.clear();
  });
}
