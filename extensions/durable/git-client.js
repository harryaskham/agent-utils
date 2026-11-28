// pi-git's client part, for pi-client: each session's git state, as git.mjs reads it on the
// session's host after each turn, published for the editor chips (branch, diff) of whichever pane
// draws that session, so they work for remote sessions too and run no git of their own there.
// It follows git.mjs's module state (pi-daemon's `pi-daemon.module-state` document, key "git")
// through pi-client's ctx.chord.watchDocument: the focused session's, and any a consumer asks
// for while drawing its pane. After /git wt fork, it opens the session git.mjs made in the new
// worktree (or, from a host that could not make one, makes it, carrying the conversation, with
// pi-client's ctx.sessions). The focused session's repository shows in
// pi-client's sidebar (setWidget's placement "sidebar", where ctx.ui.hasSidebar); /repo switches
// to another session in the same repository or one of its worktrees, on the same host. Sidebar rows
// (pi-client's client.sidebar.rows) can show each followed session's "branch", "repo" and fork
// "lane". /git fork (a session in the same directory) opens as /git wt fork does. Where pi-client
// lets a plugin take its /clone (`pi.replaceableCommands` names it), /clone with focus= or mode=
// is /git fork with that lane (bd-fd98a3), and /clone without them is pi-client's own. In TUI Pi
// (no ctx.chord) it does nothing.
import { GIT_EVENT, GIT_REQUEST, GIT_STATE_DOC } from "../lib/git-indicator.js";
import { workspacePanel } from "../lib/durable-git.js";
import { laneSummary, normalizeLane, quoteWord, splitWords, takeLane } from "../lib/fork-lane.js";

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
  // Editor chips draw the sessions' git state (they ask for it): the session's own repository is
  // in the editor's border already, so the panel (in the sidebar, or above the editor while the
  // sidebar is hidden) leaves it out and shows only the repositories git_track follows.
  let chipsShowGit = false;
  // The focused session's repository in pi-client's sidebar; set again only when it changes.
  let panel;
  let panelQueued = false;
  // pi-client's ctx refers to the pane being drawn while it draws (chips ask then): the panel is
  // worked out afterwards, for the focused session, so drawing other panes never changes it.
  const showPanel = () => {
    if (panelQueued) return;
    panelQueued = true;
    queueMicrotask(() => {
      panelQueued = false;
      renderPanel();
    });
  };
  const renderPanel = () => {
    if (live?.ui?.hasSidebar !== true || typeof live.ui.setWidget !== "function") return;
    const sessionId = sessionIdOf(live);
    const entry = sessions.get(sessionId);
    // The session's repository, then those git_track follows.
    const followed = (Array.isArray(entry?.tracked) ? entry.tracked : []).flatMap((tracked) =>
      workspacePanel(tracked) ?? [`✗ ${String(tracked?.path ?? "").split("/").pop()} ${tracked?.error ?? "unavailable"}`],
    );
    const own = chipsShowGit ? [] : workspacePanel(entry?.workspace) ?? [];
    const lines = own.length + followed.length === 0 ? undefined : [...own, ...followed];
    const key = JSON.stringify(lines ?? null);
    // Nothing shown yet and nothing to show: no call.
    if (key === (panel ?? "null")) return;
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
  // A fork's lane (bd-fd98a3): `⑂ qa`, as its editor chip says it.
  pi.registerSidebarSegment?.("lane", (session) => {
    const lane = sessions.get(String(session?.id ?? ""))?.lane;
    return lane ? `⑂ ${lane.mode}` : undefined;
  });

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

  // A /git wt fork in this session: the session git.mjs made in the worktree with this
  // conversation, opened; from a module that made none, one made here, carrying it; on another
  // node (`host`, bd-9fcd6a), there, through pi-daemon's cross-host clone (bd-cd7999).
  // `here`: the ctx of the pane showing the forking session (it opens there); without one, only
  // where to go, in `tell` (the pane the fork was typed in, which shows another session now).
  const openForked = async (forked, here, tell = here) => {
    const sessionsApi = here?.sessions;
    const host = typeof forked.host === "string" && forked.host !== "" ? forked.host : undefined;
    const cd = host === undefined ? `/cd ${forked.path}` : `/cd @${host} ${forked.path}`;
    // --rebase (bd-658ee5): the base it starts on, fetched just now (the conversation has a note of it).
    const base = typeof forked.base?.ref === "string" && typeof forked.base?.commit === "string" ? `, on ${forked.base.ref} ${forked.base.commit.slice(0, 12)}` : "";
    // A lane (bd-fd98a3): said as it opens.
    const lane = normalizeLane(forked.lane);
    const laneSaid = lane ? ` · lane ${laneSummary(lane)}${lane.mode === "qa" ? " (read-only)" : ""}` : "";
    // /git wt fork names its branch; /git fork, in the same directory, its session.
    const label = forked.branch ?? forked.title ?? forked.path;
    // --no-session: the worktree only, as asked.
    if (forked.noSession === true) return;
    const made = typeof forked.session?.id === "string" && forked.session.id !== "" ? forked.session : undefined;
    if (made !== undefined) {
      const where = `${label}${host === undefined ? "" : ` on ${host}`}${base}`;
      if (typeof sessionsApi?.open !== "function") {
        tell?.ui?.notify?.(`Session ${made.title ?? label} is ready in ${where}${laneSaid}: pick it in the session list.`, "info");
        return;
      }
      try {
        await sessionsApi.open({ id: made.id, ...(host === undefined ? {} : { host }) });
        if (lane) here.ui?.notify?.(`Opened the fork ${made.title ?? label}${laneSaid}; the original has a notice of it.`, "info");
      } catch (error) {
        here.ui?.notify?.(`Cannot open the fork's session ${made.id}${host === undefined ? "" : ` on ${host}`}: ${error?.message ?? error} (pick it in the session list)`, "error");
      }
      return;
    }
    // /git fork makes its session or nothing: there is no worktree to open one in.
    if (forked.here === true) return;
    const without = lane ? ` (without its lane ${laneSummary(lane)}: its host made no session to give it to)` : "";
    if (typeof sessionsApi?.create !== "function") {
      tell?.ui?.notify?.(`Worktree ${label} ready${host === undefined ? "" : ` on ${host}`}${base}: ${cd} continues this conversation there${without}.`, "info");
      return;
    }
    // Copying a long conversation takes a while: say so at once, rather than nothing until it opens.
    here.ui?.notify?.(`Opening ${label}${host === undefined ? "" : ` on ${host}`}${base}: copying this conversation into a session there${without}…`, "info");
    try {
      // A fork: both sessions go on, and pi-daemon marks this one so (a pi-client before that ignores `kind`).
      await sessionsApi.create({ ...(host === undefined ? {} : { host }), cwd: forked.path, title: label, carry: true, kind: "fork" });
    } catch (error) {
      here.ui?.notify?.(`Cannot open a session in ${forked.path}${host === undefined ? "" : ` on ${host}`}: ${error?.message ?? error} (${cd} continues there)`, "error");
    }
  };

  // /git wt fork typed in a pane: that pane opens the fork's session when its record comes,
  // wherever focus is by then (a Rex workspace runs many windows in one client, and the focused
  // pane may be another window's when the record arrives). Kept by session, at most 32, 10 min.
  const expected = new Map();
  const EXPECT_MS = 10 * 60_000;
  // A record this much older than the typed command (clock skew between hosts) is still its own.
  const SKEW_MS = 60_000;
  const expect = (ctx) => {
    const sessionId = sessionIdOf(ctx);
    if (!sessionId) return undefined;
    expected.delete(sessionId);
    expected.set(sessionId, { ctx: typeof ctx?.pinned === "function" ? ctx.pinned() : ctx, at: Date.now() });
    while (expected.size > 32) expected.delete(expected.keys().next().value);
    // Followed from now: its record is then a change, not history.
    follow(ctx, sessionId);
    return sessionId;
  };
  pi.on("input", (event, ctx) => {
    if (!/^\/git\s+(?:(?:wt|worktree)\s+)?fork(?:\s|$)/.test(String(event?.text ?? "").trim())) return undefined;
    expect(ctx);
    return undefined;
  });

  // /clone, where pi-client lets a plugin take it (bd-fd98a3): with focus= or mode=, /git fork
  // with that lane, which the module makes and this part opens; without, as pi-client's own: this
  // conversation copied into a new session (here, or on @host), titled NAME or "… (clone)".
  const replaceable = Array.isArray(pi.replaceableCommands) ? pi.replaceableCommands : [];
  if (replaceable.includes("clone")) {
    pi.registerCommand?.("clone", {
      description: "Copy this conversation into a new session and switch to it: /clone [@host] [NAME]; focus=TEXT mode=work|qa give the fork a lane (a role note; the original a notice; qa refuses edits)",
      handler: async (args, ctx) => {
        const notify = (text, level = "info") => ctx?.ui?.notify?.(text, level);
        const laned = takeLane(splitWords(args));
        if (laned.error) return notify(`/clone: ${laned.error}`, "error");
        const words = [...laned.words];
        const host = words[0]?.startsWith("@") ? words.shift().slice(1) : undefined;
        const name = words.join(" ").trim();
        if (laned.lane) {
          if (host !== undefined) return notify("/clone @host with a lane: /git wt fork NAME @host focus=… mode=… forks to another node.", "error");
          if (typeof ctx?.chord?.call !== "function") return notify("/clone with a lane needs a pi-daemon session.", "error");
          if (!expect(ctx)) return notify("/clone: this pane shows no session.", "error");
          const lane = `mode=${laned.lane.mode}${laned.lane.focus ? ` ${quoteWord(`focus=${laned.lane.focus}`)}` : ""}`;
          const text = `/git fork${name ? ` ${quoteWord(name)}` : ""} ${lane}`;
          try {
            await ctx.chord.call("conversation.submit", { requestId: `pi-git-clone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, content: text, wait: true });
          } catch (error) {
            notify(`/clone failed: ${error?.message ?? error}`, "error");
          }
          return undefined;
        }
        if (typeof ctx?.sessions?.create !== "function") return notify("/clone needs pi-client.", "error");
        const id = sessionIdOf(ctx);
        const row = typeof ctx.sessions.list === "function" ? ctx.sessions.list().find((candidate) => candidate.id === id) : undefined;
        const title = name || `${row?.title || "session"} (clone)`;
        try {
          await ctx.sessions.create({ ...(host === undefined ? {} : { host }), title, carry: true, kind: "copy" });
          notify(`Cloned into ${title}${host === undefined ? "" : ` on ${host}`}`);
        } catch (error) {
          notify(`/clone failed: ${error?.message ?? error}`, "error");
        }
        return undefined;
      },
    });
  }

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
        // A fork's lane (bd-fd98a3), for the sidebar's "lane" segment.
        const lane = normalizeLane(values.lane);
        if (Boolean(lane) !== Boolean(entry.lane) || (lane && laneSummary(lane) !== laneSummary(entry.lane))) {
          entry.lane = lane;
          live?.ui?.requestRender?.();
        }
        if (entry.workspace || entry.tracked) publish(sessionId);
        const forked = values.forked;
        const at = Number.isFinite(Number(forked?.at)) ? Number(forked.at) : 0;
        const waiting = expected.get(sessionId);
        const typed = waiting !== undefined && Date.now() - waiting.at <= EXPECT_MS ? waiting : undefined;
        // The first value is history: only a fork made while followed opens a session (or the one
        // just typed here, when its record came before the first value).
        const first = entry.forkedAt === undefined;
        const fresh = typeof forked?.path === "string" && (first ? typed !== undefined && at >= typed.at - SKEW_MS : at > entry.forkedAt);
        if (first || fresh) entry.forkedAt = at;
        if (fresh) {
          if (waiting !== undefined) expected.delete(sessionId);
          // The pane it was typed in, if it still shows this session; else the focused one, if it does.
          const here = typed !== undefined && sessionIdOf(typed.ctx) === sessionId ? typed.ctx : sessionIdOf(live) === sessionId ? live : undefined;
          if (here !== undefined || typed !== undefined) void openForked(forked, here, typed?.ctx);
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
    if (sessionId) chipsShowGit = true;
    // Panes are drawn as focus moves: the sidebar follows the focused session's repository.
    showPanel();
    if (!sessionId) return;
    if (sessions.has(sessionId)) return publish(sessionId);
    // pi-client's live ctx refers to the pane being drawn: follow it when it is that session's.
    if (sessionIdOf(live) === sessionId) follow(live, sessionId);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (typeof ctx?.chord?.watchDocument !== "function") return;
    live = ctx;
    follow(ctx, sessionIdOf(ctx));
    // Focus moved (pi-client starts a session for the pane that gets it): its repository.
    showPanel();
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
