// /goal for pi-daemon (Durable) sessions: a goal the agent keeps working toward until it says it
// is done, built on the /loop machinery (the same session document, numbers, /loop list and
// /loop stop, and the loops chip).
//
// A goal is a background task of its conversation. Whenever the conversation goes idle while the
// goal is live, the task sends it a nudge (the goal, and to call goal_done once it is done) and
// waits for that run to end. The agent ends the goal with the goal_done tool; the operator with
// /goal stop (or /goal done, or /loop stop N). Its system prompt section names the live goal, so
// the agent knows it between nudges and after a compaction.
//
// Bounds: at most `maxNudges` nudges (default DEFAULT_GOAL_MAX_NUDGES); a nudge the operator
// interrupts (aborts) ends the goal rather than fighting them; a failed run waits
// GOAL_FAILURE_BACKOFF_MS before the next nudge, and GOAL_MAX_FAILURES in a row end the goal.
// Nothing here imports Durable or Pi.

import { DEFAULT_GOAL_MAX_NUDGES, GOAL_TASK, LOOPS_DOC, MAX_LOOPS, timestampPrefix } from "./durable-loop.js";

export { DEFAULT_GOAL_MAX_NUDGES, GOAL_TASK };
export const MAX_GOAL_NUDGES = 1000;
export const GOAL_FAILURE_BACKOFF_MS = 60_000;
export const GOAL_MAX_FAILURES = 3;
/** The longest goal text kept (the nudge repeats it every time). */
export const MAX_GOAL_CHARS = 4000;

const USAGE = "Usage: /goal <what done looks like> [--max N] | /goal (show it) | /goal stop (off, clear) | /goal done";

/** The nudge a goal sends when its conversation goes idle. */
export function goalNudge(goal, number) {
  return [
    `[goal #${number}] Keep working toward this goal: ${goal}`,
    "When it is fully done and checked, call goal_done with a short summary. If it cannot be done, call goal_done with blocked: true and the reason. Until then, carry on: do not stop to ask whether to continue.",
  ].join("\n");
}

function summarize(text, max = 60) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const liveGoals = (doc, conversationId) =>
  Object.entries(doc?.loops ?? {})
    .filter(([, entry]) => entry && entry.kind === "goal" && entry.stopped !== true)
    .filter(([, entry]) => conversationId === undefined || String(entry.conversationId) === String(conversationId))
    .map(([number, entry]) => ({ number: Number(number), ...entry }))
    .sort((a, b) => a.number - b.number);

async function forget(tx, number) {
  const doc = await tx.doc(LOOPS_DOC);
  delete doc.loops[String(number)];
}

/**
 * The goal task. Input: `{ number, goal, maxNudges, startedAt }`; checkpoint:
 * `{ phase: "watch", nudges, failures }`.
 */
export function createGoalTask({ now = () => Date.now(), timeZone } = {}) {
  const entryOf = async (runtime, task, context) => {
    const doc = typeof runtime.snapshot === "function" ? await Promise.resolve(runtime.snapshot(LOOPS_DOC, context)).catch(() => undefined) : undefined;
    return doc?.loops?.[String(task.input.number)];
  };
  const live = (entry) => entry !== undefined && entry.stopped !== true;
  const finish = (runtime, task, context, outcome) =>
    runtime.commit(async (tx) => {
      await forget(tx, task.input.number);
      return { status: "terminal", outcome };
    }, context);

  return {
    definition: {
      name: GOAL_TASK,
      version: 1,
      initial: () => ({ phase: "watch", nudges: 0, failures: 0 }),
      phases: {
        async watch(task, runtime, context) {
          const { number, goal } = task.input;
          const maxNudges = Number(task.input.maxNudges) || DEFAULT_GOAL_MAX_NUDGES;
          const checkpoint = task.state.checkpoint;
          const nudges = Number(checkpoint.nudges) || 0;
          const ended = async () => {
            const entry = await entryOf(runtime, task, context);
            if (live(entry)) return false;
            await finish(runtime, task, context, { status: "completed", result: { nudges, ...(entry?.done ? { done: entry.done } : { stopped: true }) } });
            return true;
          };
          if (await ended()) return;
          const conversation = await runtime.conversation(runtime.conversationId, context);
          if (conversation === undefined) {
            await finish(runtime, task, context, { status: "completed", result: { nudges, gone: true } });
            return;
          }
          // Its own work, or the operator's, runs first: a goal only fills idle time.
          await conversation.waitForIdle(context);
          if (await ended()) return;
          if (nudges >= maxNudges) {
            await finish(runtime, task, context, { status: "completed", result: { nudges, gaveUp: true } });
            return;
          }
          // One request id per nudge: a nudge retried after a crash is the same submission.
          const requestId = `goal:${runtime.taskId}:${nudges + 1}`;
          const content = `${timestampPrefix(new Date(now()), timeZone)} ${goalNudge(goal, number)}`;
          const submission = await conversation.submit({ type: "input", content, whenBusy: "followUp", requestId }, context);
          const settled = await submission.wait(context);
          if (await ended()) return;
          const reason = String(settled?.reason ?? "");
          if (settled?.status === "unanswered" && /abort|cancel|interrupt|withdr/i.test(reason)) {
            // The operator stopped the agent: the goal stops too, rather than restarting it.
            await finish(runtime, task, context, { status: "completed", result: { nudges: nudges + 1, interrupted: true } });
            return;
          }
          const failed = settled?.status !== "done";
          const failures = failed ? (Number(checkpoint.failures) || 0) + 1 : 0;
          if (failures >= GOAL_MAX_FAILURES) {
            await finish(runtime, task, context, { status: "completed", result: { nudges: nudges + 1, failed: reason || "the agent's runs failed" } });
            return;
          }
          const at = now();
          const sleeps = failed && typeof runtime.sleepUntil === "function";
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(LOOPS_DOC);
            const entry = doc.loops[String(number)];
            if (entry !== undefined) {
              entry.nudges = nudges + 1;
              entry.lastAt = at;
            }
            const next = { phase: "watch", nudges: nudges + 1, failures };
            return sleeps ? { status: "sleeping", until: at + GOAL_FAILURE_BACKOFF_MS, checkpoint: next } : { status: "running", checkpoint: next };
          }, context);
        },
      },
      async abort(task, runtime, context) {
        await finish(runtime, task, context, { status: "aborted", reason: "goal stopped" });
      },
    },
  };
}

/** Goal operations over a Durable commit (a module command's harness, or a tool's api). */
export function goalOperations({ task, now = () => Date.now() }) {
  return {
    /** Start a goal in `conversationId`, stopping the conversation's live ones; `{ number, replaced }`. */
    async start(commit, conversationId, { goal, maxNudges }) {
      return commit(async (tx) => {
        const doc = await tx.doc(LOOPS_DOC);
        const replaced = liveGoals(doc, conversationId);
        for (const old of replaced) doc.loops[String(old.number)].stopped = true;
        const live = Object.values(doc.loops ?? {}).filter((entry) => entry && entry.stopped !== true).length;
        if (live >= MAX_LOOPS) throw new Error(`at most ${MAX_LOOPS} loops and goals run at once; stop one first`);
        const number = (Number(doc.last) || 0) + 1;
        const at = now();
        const taskId = await tx.createTask(task, { number, goal, maxNudges, startedAt: at }, { ownership: { kind: "conversation" }, conversationId, background: true });
        doc.last = number;
        doc.loops[String(number)] = { taskId: String(taskId), kind: "goal", prompt: goal, maxNudges, nudges: 0, startedAt: at, conversationId };
        return { number, replaced: replaced.map((entry) => ({ number: entry.number, taskId: entry.taskId })) };
      });
    },
    /** The conversation's live goals (copies). */
    async list(commit, conversationId) {
      return commit(async (tx) => JSON.parse(JSON.stringify(liveGoals(await tx.doc(LOOPS_DOC), conversationId))));
    },
    /** End the conversation's live goals, as done (`done`: `{ summary, blocked, by }`) or stopped. */
    async end(commit, conversationId, done) {
      return commit(async (tx) => {
        const doc = await tx.doc(LOOPS_DOC);
        const goals = liveGoals(doc, conversationId);
        for (const goal of goals) {
          const entry = doc.loops[String(goal.number)];
          entry.stopped = true;
          if (done !== undefined) entry.done = { ...done, at: now() };
        }
        return goals.map((goal) => ({ number: goal.number, taskId: goal.taskId, prompt: goal.prompt }));
      });
    },
  };
}

/** How a goal reads in /loop list and /goal. */
export function describeGoal(goal, now = Date.now()) {
  const nudges = Number(goal.nudges) || 0;
  const running = Math.max(0, now - (Number(goal.startedAt) || now));
  const age = running >= 3_600_000 ? `${Math.floor(running / 3_600_000)}h` : running >= 60_000 ? `${Math.floor(running / 60_000)}m` : `${Math.floor(running / 1000)}s`;
  return `#${goal.number}: goal — "${summarize(goal.prompt, 80)}" (${nudges} nudge${nudges === 1 ? "" : "s"} of ${Number(goal.maxNudges) || DEFAULT_GOAL_MAX_NUDGES}, running ${age})`;
}

/** Parse `/goal` arguments: `{ verb }` for show/stop/done, `{ goal, maxNudges }` to set one, or `{ error }`. */
export function parseGoalArgs(args) {
  const text = String(args ?? "").trim();
  if (text === "" || /^(status|show|list)$/i.test(text)) return { verb: "show" };
  if (/^(stop|off|clear|cancel|end)$/i.test(text)) return { verb: "stop" };
  if (/^done$/i.test(text)) return { verb: "done" };
  let goal = text;
  let maxNudges = DEFAULT_GOAL_MAX_NUDGES;
  const max = /(?:^|\s)--max(?:=|\s+)(\S+)(?=\s|$)/.exec(goal);
  if (max !== null) {
    const value = Number.parseInt(max[1], 10);
    if (!Number.isInteger(value) || String(value) !== max[1] || value < 1 || value > MAX_GOAL_NUDGES) return { error: `--max must be a whole number from 1 to ${MAX_GOAL_NUDGES}.` };
    maxNudges = value;
    goal = `${goal.slice(0, max.index)} ${goal.slice(max.index + max[0].length)}`.trim();
  }
  if (goal === "") return { error: USAGE };
  if (goal.length > MAX_GOAL_CHARS) return { error: `A goal is at most ${MAX_GOAL_CHARS} characters.` };
  return { goal, maxNudges };
}

/** The `/goal` command over a module command context with `harness` (pi-daemon ≥ 1.10). */
export function createGoalCommands({ task, now = () => Date.now() } = {}) {
  const ops = goalOperations({ task, now });
  const commitOf = (ctx) => (change) => ctx.harness.commit(change, ctx.context);
  const abort = async (ctx, ended) => {
    if (typeof ctx.harness.abortTask !== "function") return;
    for (const goal of ended) await Promise.resolve(ctx.harness.abortTask(Number(goal.taskId), ctx.context)).catch(() => undefined);
  };
  return {
    goal: {
      description: "Keep the agent working toward a goal until it calls goal_done: /goal <what done looks like> [--max N], /goal, /goal stop, /goal done",
      async getArgumentCompletions(prefix) {
        const text = String(prefix ?? "").trimStart().toLowerCase();
        if (/\s/.test(text)) return null;
        return [
          { value: "stop", label: "stop", description: "Stop this conversation's goal" },
          { value: "done", label: "done", description: "Mark the goal done yourself" },
        ].filter((item) => item.value.startsWith(text));
      },
      async run(args, ctx) {
        if (typeof ctx.harness?.commit !== "function") return ctx.notify("/goal needs pi-daemon 1.10 or later (module commands with the Durable harness).");
        const parsed = parseGoalArgs(args);
        if (parsed.error) return ctx.notify(parsed.error);
        if (parsed.verb === "show") {
          const goals = await ops.list(commitOf(ctx), ctx.conversationId);
          return ctx.notify(goals.length === 0 ? "No goal. Set one with /goal <what done looks like>." : goals.map((goal) => describeGoal(goal, now())).join("\n"));
        }
        if (parsed.verb === "stop" || parsed.verb === "done") {
          const ended = await ops.end(commitOf(ctx), ctx.conversationId, parsed.verb === "done" ? { summary: "marked done by the operator", by: "operator" } : undefined);
          await abort(ctx, ended);
          if (ended.length === 0) return ctx.notify("No goal to end.");
          return ctx.notify(ended.map((goal) => `Goal #${goal.number} ${parsed.verb === "done" ? "marked done" : "stopped"}: "${summarize(goal.prompt)}".`).join("\n"));
        }
        let started;
        try {
          started = await ops.start(commitOf(ctx), ctx.conversationId, parsed);
        } catch (error) {
          return ctx.notify(error?.message ?? String(error));
        }
        await abort(ctx, started.replaced);
        const replaced = started.replaced.length > 0 ? ` It replaces goal #${started.replaced.map((goal) => goal.number).join(", #")}.` : "";
        ctx.notify(`Goal #${started.number} set: "${summarize(parsed.goal)}". The agent is nudged whenever it goes idle, at most ${parsed.maxNudges} times, until it calls goal_done.${replaced} Stop with /goal stop.`);
      },
    },
  };
}

/** The agent's goal_done tool. */
export function createGoalTools({ task, now = () => Date.now() } = {}) {
  const ops = goalOperations({ task, now });
  const text = (value, details) => {
    const output = [{ type: "text", text: value }];
    return { output, content: output, ...(details === undefined ? {} : { details }) };
  };
  return [
    {
      name: "goal_done",
      description:
        "End this conversation's goal (set by the operator with /goal) once it is fully done and checked, with a short summary; or, if it cannot be done, with blocked: true and the reason. Without it the goal keeps nudging you whenever you stop.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What was done (or, when blocked, why it cannot be)." },
          blocked: { type: "boolean", description: "True when the goal cannot be reached." },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      async execute(args, api, context) {
        const summary = String(args.summary ?? "").trim().slice(0, 2000);
        if (summary === "") return { ...text("goal_done needs a summary."), isError: true };
        const blocked = args.blocked === true;
        // A tool cannot abort a task: the goal's task sees the goal ended once this run ends.
        const ended = await ops.end((change) => api.commit(change, context), api.conversationId, { summary, blocked, by: "agent" });
        if (ended.length === 0) return { ...text("There is no live goal in this conversation."), isError: true };
        return text(`Goal #${ended.map((goal) => goal.number).join(", #")} ${blocked ? "ended as blocked" : "done"}. No more nudges.`, { goals: ended.map((goal) => goal.number), blocked });
      },
    },
  ];
}

/** The `goal` system prompt section: the conversation's live goal, so the agent knows it between nudges. */
export function goalSection() {
  return {
    key: "goal",
    async render(input, context) {
      let doc;
      try {
        doc = await input.read.snapshot(LOOPS_DOC, context);
      } catch {
        return undefined;
      }
      const goals = liveGoals(doc, input.conversationId);
      if (goals.length === 0) return undefined;
      return goals
        .map((goal) => `The operator set a goal for this conversation (goal #${goal.number}): ${goal.prompt}\nKeep working toward it. Call goal_done with a summary only once it is fully done and checked (or with blocked: true if it cannot be done). Until then you are nudged to continue whenever you stop.`)
        .join("\n\n");
    },
  };
}
