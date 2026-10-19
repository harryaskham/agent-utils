// /cd DIR for TUI Pi (bd-aa5717): continue the conversation in another directory.
//
// Pi's runtime takes its directory (tools, AGENTS.md, skills) from the session file it opens, so
// moving means a new session file in DIR: the current branch's model context (as Pi would send
// it next), the model, thinking level and name, a note that the directory changed, and a link to
// the session it came from. The old session is left as it was; `pi --resume` in DIR finds the
// new one.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Messages Pi's session file stores as they are; others are sent as Pi converts them. */
const STORED_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution", "custom"]);

export function resolveDirectory(from, arg, home = homedir()) {
  const expanded = arg === "~" ? home : arg.startsWith("~/") ? `${home}${arg.slice(1)}` : arg;
  return resolve(from, expanded);
}

export function directoryNote(from, to) {
  return `[Working directory changed from ${from} to ${to}. Files, commands and project instructions now refer to ${to}.]`;
}

/**
 * Write the new session file for `dir` and return its path. `SessionManager` and `convertToLlm`
 * are Pi's (injected so the logic can be tested without Pi).
 */
export function writeMovedSession({ current, cwd, dir, SessionManager, convertToLlm, now = () => Date.now(), home }) {
  const to = resolveDirectory(cwd, dir, home);
  if (to === cwd) throw new Error(`already in ${cwd}`);
  if (!existsSync(to) || !statSync(to).isDirectory()) throw new Error(`${to} is not a directory`);
  const context = current.buildSessionContext();
  const parentSession = current.getSessionFile?.();
  const next = SessionManager.create(to, undefined, parentSession ? { parentSession } : undefined);
  if (context.model) next.appendModelChange(context.model.provider, context.model.modelId);
  if (context.thinkingLevel) next.appendThinkingLevelChange(context.thinkingLevel);
  const name = current.getSessionName?.();
  if (name) next.appendSessionInfo(name);
  let carried = 0;
  for (const message of context.messages) {
    if (STORED_ROLES.has(message.role)) {
      next.appendMessage(message);
      carried += 1;
    } else {
      for (const converted of convertToLlm([message])) {
        next.appendMessage(converted);
        carried += 1;
      }
    }
  }
  // A user message: it also makes Pi write the file even for an empty conversation.
  next.appendMessage({ role: "user", content: [{ type: "text", text: directoryNote(cwd, to) }], timestamp: now() });
  return { file: next.getSessionFile(), to, carried };
}

/** The `/cd` command, given Pi's `SessionManager` and `convertToLlm`. */
export function createCdCommand({ SessionManager, convertToLlm }) {
  return {
    description: "Continue this conversation in another directory (a new session there; this one stays)",
    handler: async (args, ctx) => {
      const dir = String(args ?? "").trim();
      if (dir === "") {
        ctx.ui.notify("/cd DIR: continue this conversation in DIR (a new session there; this one stays)", "warning");
        return;
      }
      await ctx.waitForIdle();
      let moved;
      try {
        moved = writeMovedSession({ current: ctx.sessionManager, cwd: ctx.cwd, dir, SessionManager, convertToLlm });
      } catch (error) {
        ctx.ui.notify(`/cd: ${error.message}`, "error");
        return;
      }
      await ctx.switchSession(moved.file, {
        withSession: async (next) => next.ui.notify(`Now in ${moved.to} (${moved.carried} messages carried over)`, "info"),
      });
    },
  };
}
