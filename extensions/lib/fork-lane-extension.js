// Fork lanes in TUI Pi (bd-fd98a3): `/clone [NAME] [focus=TEXT] [mode=work|qa]` and the qa guard.
//
// Pi's own `/clone` (exactly that, no arguments) stays Pi's. Given arguments, Pi has no command
// for it, so its `input` event sees it: this hands it to `/clone-lane`, its own name (an
// extension command named like a built-in is reported as a conflict at every start). It
// duplicates the session at its current position as Pi's does (ctx.fork, "at"), names it, and
// with a lane gives the fork its role note (a custom message whose details are the lane, so the
// guard and the editor chips find it on the branch) and the original a notice that a fork took
// that lane. The notice is appended to the original's session file once the fork exists, so the
// fork's copy never has it.
//
// A qa lane refuses edits: Pi's tool_call hook blocks edit and write, and bash commands that
// plainly change files or git state (fork-lane.js qaBashRefusal). pi-client sessions are
// pi-daemon's: there the module (durable-git.js) does this, and this extension registers nothing.
import { LANE_ENTRY, LANE_NOTICE_ENTRY, forkRoleNote, laneFromEntries, laneSummary, normalizeLane, originalNotice, qaToolRefusal, splitWords, takeLane } from "./fork-lane.js";

/** The lane of the session a ctx is in now (its branch's latest role note), cached by its leaf. */
export function createLaneReader() {
  let cached = { leaf: undefined, length: -1, lane: undefined };
  return (ctx) => {
    let entries = [];
    try {
      entries = ctx?.sessionManager?.getBranch?.() || [];
    } catch {
      return undefined;
    }
    const leaf = entries.at(-1);
    if (cached.leaf !== leaf || cached.length !== entries.length) cached = { leaf, length: entries.length, lane: laneFromEntries(entries) };
    return cached.lane;
  };
}

/** The command `/clone ARGS` runs (Pi keeps the name /clone for its own, without arguments). */
export const CLONE_LANE_COMMAND = "clone-lane";

/** The arguments of `/clone ARGS` as typed, or undefined for anything else (`/clone` alone is Pi's). */
export function cloneArgsOf(text) {
  const match = /^\/clone\s+(\S[\s\S]*)$/.exec(String(text ?? "").trim());
  return match ? match[1] : undefined;
}

/** `/clone`'s arguments: `{ name, lane }` or `{ error }`. */
export function parseCloneArgs(args) {
  const taken = takeLane(splitWords(args));
  if (taken.error) return { error: taken.error };
  const name = taken.words.join(" ").trim();
  if (name.startsWith("@")) return { error: "/clone @host is pi-client's; in TUI Pi, /session-fork --remote HOST forks to another host" };
  return { name, lane: taken.lane };
}

/** The fork's session name: NAME, else the focus, else the original's name with the mode. */
export function cloneName({ name, lane }, original) {
  if (name) return name;
  if (lane?.focus) return lane.focus;
  if (lane) return `${original || "session"} (${lane.mode})`;
  return undefined;
}

export function createForkLaneExtension({ SessionManager }) {
  return function forkLane(pi) {
    // pi-client's facade (sidebar segments are its own): its sessions are pi-daemon's, whose
    // module makes lanes; its /clone is a client command an extension may not register.
    if (typeof pi.registerSidebarSegment === "function") return;
    const laneOf = createLaneReader();

    pi.on("tool_call", (event, ctx) => {
      const lane = laneOf(ctx);
      if (lane?.mode !== "qa") return undefined;
      const reason = qaToolRefusal(String(event?.toolName ?? ""), event?.input, lane);
      return reason ? { block: true, reason } : undefined;
    });

    // `/clone ARGS`: Pi's own /clone takes none, so its input comes here; the clone runs as a
    // command (only a command's ctx can fork), after this input is done with.
    pi.on("input", (event) => {
      if (event?.source === "extension") return undefined;
      const args = cloneArgsOf(event?.text);
      if (args === undefined) return undefined;
      const deliverAs = event.streamingBehavior;
      setTimeout(() => {
        try {
          pi.sendUserMessage(`/${CLONE_LANE_COMMAND} ${args}`, { expandPromptTemplates: true, ...(deliverAs ? { deliverAs } : {}) });
        } catch {}
      }, 0);
      return { action: "handled" };
    });

    pi.registerCommand(CLONE_LANE_COMMAND, {
      description: "Duplicate this session at its current position, as /clone NAME focus=TEXT mode=work|qa does: [NAME] [focus=TEXT] [mode=work|qa] (a lane: the fork gets a role note, this session a notice; qa refuses edits)",
      getArgumentCompletions(prefix) {
        const last = String(prefix ?? "").split(/\s+/).at(-1) ?? "";
        const items = [
          { value: "mode=qa", label: "mode=qa", description: "The fork answers questions and refuses edits" },
          { value: "mode=work", label: "mode=work", description: "The fork may edit (the default with focus=)" },
          { value: 'focus=""', label: "focus=TEXT", description: "The fork's lane (quote it when it has spaces)" },
        ].filter((item) => item.value.startsWith(last));
        if (items.length === 0) return null;
        const head = String(prefix ?? "").slice(0, String(prefix ?? "").length - last.length);
        return items.map((item) => ({ ...item, value: `${head}${item.value}` }));
      },
      handler: async (args, ctx) => {
        const parsed = parseCloneArgs(args);
        if (parsed.error) {
          ctx.ui.notify(`/clone: ${parsed.error}`, "error");
          return;
        }
        await ctx.waitForIdle();
        const leafId = ctx.sessionManager.getLeafId();
        if (!leafId) {
          ctx.ui.notify("Nothing to clone yet", "warning");
          return;
        }
        const originalFile = ctx.sessionManager.getSessionFile?.();
        if (parsed.lane && !originalFile) {
          ctx.ui.notify("/clone: a lane needs a saved session (the original keeps a notice of it)", "error");
          return;
        }
        const originalName = ctx.sessionManager.getSessionName?.();
        const cwd = ctx.cwd;
        const name = cloneName(parsed, originalName);
        const lane = parsed.lane
          ? normalizeLane({ ...parsed.lane, from: { title: originalName || originalFile, cwd }, cwd, shared: true, at: Date.now() })
          : undefined;
        let failed;
        const result = await ctx.fork(leafId, {
          position: "at",
          withSession: async (next) => {
            try {
              if (name) next.sessionManager.appendSessionInfo(name);
              if (lane) {
                await next.sendMessage({ customType: LANE_ENTRY, content: forkRoleNote(lane), display: true, details: lane }, { triggerTurn: false });
                const fork = { title: name, sessionId: next.sessionManager.getSessionId?.(), file: next.sessionManager.getSessionFile?.() };
                // The original runs no more in this process: its file takes the notice, which it reads when resumed.
                SessionManager.open(originalFile).appendCustomMessageEntry(LANE_NOTICE_ENTRY, originalNotice(lane, fork), true, { fork, lane });
              }
            } catch (error) {
              failed = error;
            }
            const said = lane ? ` · lane ${laneSummary(lane)}${lane.mode === "qa" ? " (edits refused)" : ""}` : "";
            if (failed) next.ui.notify(`Cloned${name ? ` into ${name}` : ""}, but the lane was not fully set: ${failed.message ?? failed}`, "error");
            else next.ui.notify(`Cloned${name ? ` into ${name}` : ""}${said}${lane ? "; the original has a notice of it" : ""}`, "info");
          },
        });
        if (result?.cancelled) ctx.ui.notify("/clone was cancelled", "warning");
      },
    });
  };
}
