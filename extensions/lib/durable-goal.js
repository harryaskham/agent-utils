// /goal for pi-daemon (Durable) sessions: goals the agent keeps working toward until it says each
// is done, built on the /loop machinery (the same session document, numbers, /loop list and
// /loop stop, and the loops chip).
//
// `/goal TEXT` adds a goal, as `/loop` adds a loop: a conversation may have several. One
// background task per conversation nudges for all of them: whenever the conversation goes idle
// while any goal is open, it sends one nudge listing every open goal (a to-do list) and waits for
// that run to end. The agent ends a goal with goal_done (its id); the operator with
// `/goal done N`, `/goal stop N` (or `all`), or `/loop stop N`. The `goal` system prompt section
// lists the open goals, so the agent knows them between nudges and after a compaction.
//
// Bounds: each goal has at most `maxNudges` nudges (default DEFAULT_GOAL_MAX_NUDGES) and ends at
// its limit; a nudge the operator interrupts (aborts) ends the conversation's goals rather than
// fighting them; a failed run waits GOAL_FAILURE_BACKOFF_MS before the next nudge, and
// GOAL_MAX_FAILURES in a row end them. Nothing here imports Durable or Pi.

import { DEFAULT_GOAL_MAX_NUDGES, GOAL_TASK, LOOPS_DOC, MAX_LOOPS, timestampPrefix } from "./durable-loop.js";

export { DEFAULT_GOAL_MAX_NUDGES, GOAL_TASK };
export const MAX_GOAL_NUDGES = 1000;
export const GOAL_FAILURE_BACKOFF_MS = 60_000;
export const GOAL_MAX_FAILURES = 3;
/** The longest goal text kept (each nudge repeats it). */
export const MAX_GOAL_CHARS = 4000;

const USAGE = "Usage: /goal <what done looks like> [--max N] adds a goal | /goal (list) | /goal done [N|all] | /goal stop [N|all] (off, clear)";

/** The nudge for a conversation's open goals: one goal as a sentence, several as a to-do list. */
export function goalNudge(goals) {
  const list = Array.isArray(goals) ? goals : [goals];
  if (list.length === 1) {
    const [goal] = list;
    return [
      `[goal #${goal.number}] Keep working toward this goal: ${goal.prompt}`,
      `When it is fully done and checked, call goal_done with id ${goal.number} and a short summary. If it cannot be done, call goal_done with blocked: true and the reason. Until then, carry on: do not stop to ask whether to continue.`,
    ].join("\n");
  }
  return [
    `[goals] Keep working toward these ${list.length} goals:`,
    ...list.map((goal) => `- #${goal.number}: ${goal.prompt}`),
    "When one is fully done and checked, call goal_done with its id and a short summary; if one cannot be done, call goal_done with its id, blocked: true and the reason. Until they are all done, carry on: do not stop to ask whether to continue.",
  ].join("\n");
}

function summarize(text, max = 60) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Open goals (of `conversationId`, when given; of task `taskId`, when given), by number. */
export function liveGoals(doc, conversationId, taskId) {
  return Object.entries(doc?.loops ?? {})
    .filter(([, entry]) => entry && entry.kind === "goal" && entry.stopped !== true)
    .filter(([, entry]) => conversationId === undefined || String(entry.conversationId) === String(conversationId))
    .filter(([, entry]) => taskId === undefined || String(entry.taskId) === String(taskId))
    .map(([number, entry]) => ({ number: Number(number), ...entry }))
    .sort((a, b) => a.number - b.number);
}

/**
 * The goal task: one per conversation with open goals, nudging for all of them. Input:
 * `{ conversationId?, startedAt }` (tasks from before several goals carry `{ number, goal }`);
 * checkpoint: `{ phase: "watch", nudges, failures }` (nudges the task has sent).
 */
export function createGoalTask({ now = () => Date.now(), timeZone } = {}) {
  const snapshot = async (runtime, context) =>
    typeof runtime.snapshot === "function" ? Promise.resolve(runtime.snapshot(LOOPS_DOC, context)).catch(() => undefined) : undefined;
  const mine = (doc, runtime) => liveGoals(doc, undefined, runtime.taskId);
  /** Drop this task's ended goals; end it when none is open (in one commit, so none is lost). */
  const settle = (runtime, context, next, outcome) =>
    runtime.commit(async (tx) => {
      const doc = await tx.doc(LOOPS_DOC);
      for (const [number, entry] of Object.entries(doc.loops ?? {})) {
        if (entry?.kind === "goal" && String(entry.taskId) === String(runtime.taskId) && entry.stopped === true) delete doc.loops[number];
      }
      if (mine(doc, runtime).length > 0) return next;
      return { status: "terminal", outcome };
    }, context);
  /** End every goal of this task (an interruption, repeated failures, an abort). */
  const endAll = (runtime, context, outcome) =>
    runtime.commit(async (tx) => {
      const doc = await tx.doc(LOOPS_DOC);
      for (const [number, entry] of Object.entries(doc.loops ?? {})) {
        if (entry?.kind === "goal" && String(entry.taskId) === String(runtime.taskId)) delete doc.loops[number];
      }
      return { status: "terminal", outcome };
    }, context);

  return {
    definition: {
      name: GOAL_TASK,
      version: 1,
      initial: () => ({ phase: "watch", nudges: 0, failures: 0 }),
      phases: {
        async watch(task, runtime, context) {
          const checkpoint = task.state.checkpoint;
          const nudges = Number(checkpoint.nudges) || 0;
          const again = { status: "running", checkpoint: { phase: "watch", nudges, failures: Number(checkpoint.failures) || 0 } };
          if (mine(await snapshot(runtime, context), runtime).length === 0) {
            await settle(runtime, context, again, { status: "completed", result: { nudges } });
            return;
          }
          const conversation = await runtime.conversation(runtime.conversationId, context);
          if (conversation === undefined) {
            await endAll(runtime, context, { status: "completed", result: { nudges, gone: true } });
            return;
          }
          // Its own work, or the operator's, runs first: goals only fill idle time.
          await conversation.waitForIdle(context);
          const goals = mine(await snapshot(runtime, context), runtime);
          if (goals.length === 0) {
            await settle(runtime, context, again, { status: "completed", result: { nudges } });
            return;
          }
          // One request id per nudge: a nudge retried after a crash is the same submission.
          const requestId = `goal:${runtime.taskId}:${nudges + 1}`;
          const content = `${timestampPrefix(new Date(now()), timeZone)} ${goalNudge(goals)}`;
          const submission = await conversation.submit({ type: "input", content, whenBusy: "followUp", requestId }, context);
          const settled = await submission.wait(context);
          const reason = String(settled?.reason ?? "");
          if (settled?.status === "unanswered" && /abort|cancel|interrupt|withdr/i.test(reason)) {
            // The operator stopped the agent: the goals stop too, rather than restarting it.
            await endAll(runtime, context, { status: "completed", result: { nudges: nudges + 1, interrupted: true } });
            return;
          }
          const failed = settled?.status !== "done";
          const failures = failed ? (Number(checkpoint.failures) || 0) + 1 : 0;
          if (failures >= GOAL_MAX_FAILURES) {
            await endAll(runtime, context, { status: "completed", result: { nudges: nudges + 1, failed: reason || "the agent's runs failed" } });
            return;
          }
          const at = now();
          const nudged = new Set(goals.map((goal) => String(goal.number)));
          const checkpointNext = { phase: "watch", nudges: nudges + 1, failures };
          const next = failed && typeof runtime.sleepUntil === "function"
            ? { status: "sleeping", until: at + GOAL_FAILURE_BACKOFF_MS, checkpoint: checkpointNext }
            : { status: "running", checkpoint: checkpointNext };
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(LOOPS_DOC);
            for (const [number, entry] of Object.entries(doc.loops ?? {})) {
              if (entry?.kind !== "goal" || String(entry.taskId) !== String(runtime.taskId)) continue;
              if (entry.stopped === true) { delete doc.loops[number]; continue; }
              if (!nudged.has(number)) continue;
              entry.nudges = (Number(entry.nudges) || 0) + 1;
              entry.lastAt = at;
              // A goal at its nudge limit ends; the others go on.
              if (entry.nudges >= (Number(entry.maxNudges) || DEFAULT_GOAL_MAX_NUDGES)) delete doc.loops[number];
            }
            if (mine(doc, runtime).length > 0) return next;
            return { status: "terminal", outcome: { status: "completed", result: { nudges: nudges + 1 } } };
          }, context);
        },
      },
      async abort(_task, runtime, context) {
        await endAll(runtime, context, { status: "aborted", reason: "goals stopped" });
      },
    },
  };
}

/** Goal operations over a Durable commit (a module command's harness, or a tool's api). */
export function goalOperations({ task, now = () => Date.now() }) {
  return {
    /**
     * Add a goal to `conversationId`: nudged by the conversation's goal task (created with its
     * first goal). `{ number, open }`: its number, and how many goals the conversation has open.
     */
    async start(commit, conversationId, { goal, maxNudges }) {
      return commit(async (tx) => {
        const doc = await tx.doc(LOOPS_DOC);
        const open = Object.values(doc.loops ?? {}).filter((entry) => entry && entry.stopped !== true).length;
        if (open >= MAX_LOOPS) throw new Error(`at most ${MAX_LOOPS} loops and goals run at once; end one first`);
        const siblings = liveGoals(doc, conversationId);
        const at = now();
        // A live goal of this conversation means its task is live: it ends only in a commit that
        // finds no open goal of its own.
        const taskId = siblings[0]?.taskId ?? String(await tx.createTask(task, { conversationId, startedAt: at }, { ownership: { kind: "conversation" }, conversationId, background: true }));
        const number = (Number(doc.last) || 0) + 1;
        doc.last = number;
        doc.loops[String(number)] = { taskId: String(taskId), kind: "goal", prompt: goal, maxNudges, nudges: 0, startedAt: at, conversationId };
        return { number, open: siblings.length + 1 };
      });
    },
    /** The conversation's open goals (copies). */
    async list(commit, conversationId) {
      return commit(async (tx) => JSON.parse(JSON.stringify(liveGoals(await tx.doc(LOOPS_DOC), conversationId))));
    },
    /**
     * End goals: `which` a number (any conversation's), "all" (this conversation's), or undefined
     * (this conversation's only goal; several are `{ ambiguous }`). As done (`done`: `{ summary,
     * blocked, by }`) or stopped. `{ ended, idle }`: the goals ended, and the tasks left with no
     * open goal (to abort now rather than after their run).
     */
    async end(commit, conversationId, which, done) {
      return commit(async (tx) => {
        const doc = await tx.doc(LOOPS_DOC);
        const own = liveGoals(doc, conversationId);
        let targets;
        if (which === "all") targets = own;
        else if (which === undefined) {
          if (own.length > 1) return { ended: [], idle: [], ambiguous: JSON.parse(JSON.stringify(own)) };
          targets = own;
        } else targets = liveGoals(doc).filter((goal) => goal.number === which);
        for (const goal of targets) {
          const entry = doc.loops[String(goal.number)];
          entry.stopped = true;
          if (done !== undefined) entry.done = { ...done, at: now() };
        }
        const idle = [...new Set(targets.map((goal) => String(goal.taskId)))].filter((taskId) => liveGoals(doc, undefined, taskId).length === 0);
        return { ended: targets.map((goal) => ({ number: goal.number, taskId: goal.taskId, prompt: goal.prompt })), idle };
      });
    },
    /** Forget goals whose task is gone (it ended without cleaning up). */
    async reconcile(commit, liveTaskIds) {
      return commit(async (tx) => {
        const doc = await tx.doc(LOOPS_DOC);
        for (const [number, entry] of Object.entries(doc.loops ?? {})) {
          if (entry?.kind === "goal" && !liveTaskIds.has(String(entry.taskId))) delete doc.loops[number];
        }
      });
    },
  };
}

/** How a goal reads in /goal and /loop list. */
export function describeGoal(goal, now = Date.now()) {
  const nudges = Number(goal.nudges) || 0;
  const running = Math.max(0, now - (Number(goal.startedAt) || now));
  const age = running >= 3_600_000 ? `${Math.floor(running / 3_600_000)}h` : running >= 60_000 ? `${Math.floor(running / 60_000)}m` : `${Math.floor(running / 1000)}s`;
  return `#${goal.number}: goal — "${summarize(goal.prompt, 80)}" (${nudges} nudge${nudges === 1 ? "" : "s"} of ${Number(goal.maxNudges) || DEFAULT_GOAL_MAX_NUDGES}, running ${age})`;
}

/** `N`, `#N` or `all` (or nothing): a goal selector, or `{ error }`. */
function parseWhich(text) {
  const value = String(text ?? "").trim().toLowerCase().replace(/^#/, "");
  if (value === "") return { which: undefined };
  if (value === "all") return { which: "all" };
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || String(number) !== value) return { error: `Not a goal number: ${text}. ${USAGE}` };
  return { which: number };
}

/**
 * Parse `/goal` arguments: `{ verb: "list" }`, `{ verb: "done"|"stop", which }`, `{ goal, maxNudges }`
 * to add one, or `{ error }`.
 */
export function parseGoalArgs(args) {
  const text = String(args ?? "").trim();
  if (text === "" || /^(status|show|list|ls)$/i.test(text)) return { verb: "list" };
  const verb = /^(done|stop|off|clear|cancel|end)(?:\s+(.*))?$/i.exec(text);
  if (verb !== null) {
    const which = parseWhich(verb[2]);
    if (which.error) return which;
    return { verb: verb[1].toLowerCase() === "done" ? "done" : "stop", which: which.which };
  }
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
  const abort = async (ctx, taskIds) => {
    if (typeof ctx.harness.abortTask !== "function") return;
    for (const taskId of taskIds) await Promise.resolve(ctx.harness.abortTask(Number(taskId), ctx.context)).catch(() => undefined);
  };
  // Goals whose task is gone are forgotten first, so a new goal never joins a dead task.
  const prune = async (ctx) => {
    if (typeof ctx.harness.inspect !== "function") return;
    const tasks = (await ctx.harness.inspect(ctx.context)).tasks.filter((entry) => entry.record.kind === GOAL_TASK && !entry.record.abortRequested);
    await ops.reconcile(commitOf(ctx), new Set(tasks.map((entry) => String(entry.record.id))));
  };
  const listText = (goals) =>
    goals.length === 0 ? "No goals. Add one with /goal <what done looks like>." : goals.map((goal) => describeGoal(goal, now())).join("\n");
  return {
    goal: {
      description: "Goals the agent is nudged toward whenever it goes idle, until it calls goal_done: /goal <what done looks like> [--max N] adds one; /goal lists them; /goal done [N|all], /goal stop [N|all]",
      async getArgumentCompletions(prefix, ctx) {
        const text = String(prefix ?? "").trimStart();
        const pick = /^(done|stop)\s+(\S*)$/i.exec(text);
        if (pick !== null) {
          let goals = [];
          try {
            const doc = typeof ctx?.harness?.snapshot === "function" ? await ctx.harness.snapshot(LOOPS_DOC, ctx.context) : undefined;
            goals = liveGoals(doc, ctx?.conversationId);
          } catch {}
          return [
            { value: `${pick[1]} all`, label: "all", description: `${pick[1] === "done" ? "Mark" : "Stop"} every goal here` },
            ...goals.map((goal) => ({ value: `${pick[1]} ${goal.number}`, label: `#${goal.number}`, description: summarize(goal.prompt) })),
          ].filter((item) => item.value.slice(pick[1].length + 1).startsWith(pick[2].replace(/^#/, "")));
        }
        if (/\s/.test(text)) return null;
        return [
          { value: "list", label: "list", description: "This conversation's goals" },
          { value: "done ", label: "done", description: "Mark a goal done yourself" },
          { value: "stop ", label: "stop", description: "Stop a goal" },
        ].filter((item) => item.value.startsWith(text.toLowerCase()));
      },
      async run(args, ctx) {
        if (typeof ctx.harness?.commit !== "function") return ctx.notify("/goal needs pi-daemon 1.10 or later (module commands with the Durable harness).");
        const parsed = parseGoalArgs(args);
        if (parsed.error) return ctx.notify(parsed.error);
        await prune(ctx);
        if (parsed.verb === "list") return ctx.notify(listText(await ops.list(commitOf(ctx), ctx.conversationId)));
        if (parsed.verb === "stop" || parsed.verb === "done") {
          const done = parsed.verb === "done" ? { summary: "marked done by the operator", by: "operator" } : undefined;
          const result = await ops.end(commitOf(ctx), ctx.conversationId, parsed.which, done);
          if (result.ambiguous) {
            return ctx.notify(`${result.ambiguous.length} goals are open: /goal ${parsed.verb} N, or /goal ${parsed.verb} all.\n${listText(result.ambiguous)}`);
          }
          await abort(ctx, result.idle);
          if (result.ended.length === 0) return ctx.notify(parsed.which === undefined || parsed.which === "all" ? "No goal to end." : `No open goal #${parsed.which}.`);
          return ctx.notify(result.ended.map((goal) => `Goal #${goal.number} ${parsed.verb === "done" ? "marked done" : "stopped"}: "${summarize(goal.prompt)}".`).join("\n"));
        }
        let started;
        try {
          started = await ops.start(commitOf(ctx), ctx.conversationId, parsed);
        } catch (error) {
          return ctx.notify(error?.message ?? String(error));
        }
        const others = started.open > 1 ? ` ${started.open} goals are open; each nudge lists them all.` : "";
        ctx.notify(`Goal #${started.number} added: "${summarize(parsed.goal)}". The agent is nudged whenever it goes idle, at most ${parsed.maxNudges} times, until it calls goal_done.${others} /goal lists them; /goal done ${started.number} or /goal stop ${started.number} ends this one.`);
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
        "End one of this conversation's goals (set by the operator with /goal) once it is fully done and checked, with a short summary; or, if it cannot be done, with blocked: true and the reason. Pass its id (the #N in the goal list); it may be left out when only one goal is open. Without it the goal keeps nudging you whenever you stop.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "The goal's number (#N). Optional when only one goal is open." },
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
        const which = args.id === undefined || args.id === null ? undefined : Number(args.id);
        if (which !== undefined && !Number.isInteger(which)) return { ...text(`Not a goal id: ${args.id}.`), isError: true };
        const commit = (change) => api.commit(change, context);
        // Only this conversation's goals: a goal id from elsewhere is not the agent's to end.
        if (which !== undefined) {
          const own = await ops.list(commit, api.conversationId);
          if (!own.some((goal) => goal.number === which)) {
            return { ...text(`No open goal #${which} in this conversation.${own.length ? ` Open: ${own.map((goal) => `#${goal.number}`).join(", ")}.` : ""}`), isError: true };
          }
        }
        // A tool cannot abort a task: the goal task sees the goal ended once this run ends.
        const result = await ops.end(commit, api.conversationId, which, { summary, blocked, by: "agent" });
        if (result.ambiguous) {
          return { ...text(`Several goals are open; pass the id of the one that is done:\n${result.ambiguous.map((goal) => `#${goal.number}: ${summarize(goal.prompt, 80)}`).join("\n")}`), isError: true };
        }
        if (result.ended.length === 0) return { ...text("There is no open goal in this conversation."), isError: true };
        const left = (await ops.list(commit, api.conversationId)).length;
        return text(
          `Goal #${result.ended.map((goal) => goal.number).join(", #")} ${blocked ? "ended as blocked" : "done"}.${left > 0 ? ` ${left} goal${left === 1 ? "" : "s"} still open.` : " No more nudges."}`,
          { goals: result.ended.map((goal) => goal.number), blocked, open: left },
        );
      },
    },
  ];
}

/** The `goal` system prompt section: the conversation's open goals, so the agent knows them between nudges. */
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
      return [
        goals.length === 1 ? "The operator set a goal for this conversation:" : `The operator set ${goals.length} goals for this conversation:`,
        ...goals.map((goal) => `- #${goal.number}: ${goal.prompt}`),
        "Keep working toward them. Call goal_done with a goal's id and a summary only once it is fully done and checked (or with blocked: true if it cannot be done). Until then you are nudged to continue whenever you stop.",
      ].join("\n");
    },
  };
}
