// /loop for pi-daemon (Durable) sessions: a repeating prompt as a Durable background task.
//
// Durable has no clock: a task can wait for other tasks, not for a time. So a loop is a background
// task of its conversation whose one phase sleeps until `nextAt` in the session's worker, delivers
// the prompt, and commits the next `nextAt`: the schedule is durable (it survives a crash or a
// restart, and pi-daemon resumes sessions with live background tasks at startup), the timer is the
// worker's. Missed ticks are skipped, not replayed. The loop shows in the task graph (/tasks) and
// stops when the task is aborted (/loop stop N).
//
// The commands match the TUI /loop (Collective's commands.js): several loops at once, numbered
// #1, #2, … per session; each fires at once and then every interval; /loop list (or status)
// lists them by number; /loop stop N stops one, /loop stop (or all) every one, with /loop off
// and /loop end as aliases. Delivery: an idle conversation starts a turn; a busy one gets the
// prompt once, as a follow-up when its work ends (or, with --steer, as a steer at once). Each
// delivery starts with the wall-clock time. Nothing here imports Durable or Pi.

export const LOOP_TASK = "agent-utils.loop";
export const DEFAULT_MIN_INTERVAL_SECS = 30;

const USAGE = "Usage: /loop <interval> [--steer] <prompt> | /loop list (or /loops) | /loop stop [id|all] (off and end too); e.g. /loop 5m Check the inbox";

/** `5m`, `1h30m`, `90s`, `1d`, or a bare number of minutes (as the TUI /loop), as seconds (at least `minSecs`), or null. */
export function parseIntervalSpec(value, minSecs = DEFAULT_MIN_INTERVAL_SECS) {
  let compact = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (/^\d+$/u.test(compact)) compact = `${compact}m`;
  if (!compact || !/^(\d+[smhd])+$/u.test(compact)) return null;
  const unit = { s: 1, m: 60, h: 3600, d: 86400 };
  let total = 0;
  for (const [, amount, suffix] of compact.matchAll(/(\d+)([smhd])/gu)) {
    const count = Number.parseInt(amount, 10);
    if (!Number.isFinite(count) || count <= 0) return null;
    total += count * unit[suffix];
  }
  return Math.max(minSecs, total);
}

export function formatInterval(secs) {
  if (secs % 86400 === 0) return `${secs / 86400}d`;
  if (secs % 3600 === 0) return `${secs / 3600}h`;
  if (secs % 60 === 0) return `${secs / 60}m`;
  return `${secs}s`;
}

/** `[YYYY-MM-DD HH:MM:SS TZ]`, in `timeZone` (default: the worker's). */
export function timestampPrefix(now = new Date(), timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(now);
    const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
    const zone = get("timeZoneName");
    return `[${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}${zone ? ` ${zone}` : ""}]`;
  } catch {
    return `[${now.toISOString()}]`;
  }
}

/** The first tick after `now` on the schedule `previousAt + k × intervalMs` (missed ticks skipped). */
export function nextFireAt(previousAt, intervalMs, now) {
  if (previousAt + intervalMs > now) return previousAt + intervalMs;
  return previousAt + (Math.floor((now - previousAt) / intervalMs) + 1) * intervalMs;
}

/** Wait `ms`, or reject when `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * The loop task (a Durable task definition as a plain object). Input: `{ prompt, intervalSecs,
 * deliverAs, firstAt }`; checkpoint: `{ phase: "wait", nextAt, fired, lastAt? }`.
 */
/**
 * The session's loops (a Durable session document): the number counter and each live loop, so
 * the /loop command and the agent's create_loop/list_loops/stop_loop tools share numbers, and a
 * stop reaches the loop's task (it watches the document). A plain token object, as Durable's
 * defineDoc returns.
 */
export const LOOPS_DOC = {
  definition: {
    kind: "agent-utils.loops",
    version: 1,
    scope: "session",
    initial: () => ({ last: 0, loops: {} }),
  },
};

/** At most this many loops are live in one session. */
export const MAX_LOOPS = 32;

function stoppedIn(doc, number) {
  return doc?.loops?.[String(number)]?.stopped === true;
}

/** Remove a loop's registry entry (in a transaction). */
async function forget(tx, number) {
  if (number === undefined) return;
  const doc = await tx.doc(LOOPS_DOC);
  delete doc.loops[String(number)];
}

/**
 * The loop task (a Durable task definition as a plain object). Input: `{ number, prompt,
 * intervalSecs, deliverAs, firstAt, startedAt }`; checkpoint: `{ phase: "wait", nextAt, fired,
 * lastAt? }`. A stop in the registry wakes it at once and ends it without delivering.
 */
export function createLoopTask({ now = () => Date.now(), wait = sleep, timeZone } = {}) {
  const finish = (runtime, task, context, outcome) =>
    runtime.commit(async (tx) => {
      await forget(tx, task.input.number);
      return { status: "terminal", outcome };
    }, context);
  return {
    definition: {
      name: LOOP_TASK,
      version: 1,
      initial: (input) => ({ phase: "wait", nextAt: input.firstAt, fired: 0 }),
      phases: {
        async wait(task, runtime, context) {
          const { number, prompt, intervalSecs, deliverAs } = task.input;
          const checkpoint = task.state.checkpoint;
          // Sleep until the tick, or until the registry says this loop stopped.
          const watch = typeof runtime.watchDoc === "function" ? await runtime.watchDoc(LOOPS_DOC, context).catch(() => undefined) : undefined;
          let stopped = stoppedIn(watch?.value, number);
          if (!stopped) {
            const wake = new AbortController();
            const onAbort = () => wake.abort(runtime.signal.reason);
            runtime.signal?.addEventListener?.("abort", onAbort, { once: true });
            watch?.start(async (value) => {
              if (stoppedIn(value, number)) {
                stopped = true;
                wake.abort();
              }
            });
            try {
              await wait(checkpoint.nextAt - now(), wake.signal);
            } catch (error) {
              if (!stopped) throw error;
            } finally {
              runtime.signal?.removeEventListener?.("abort", onAbort);
              await watch?.stop().catch(() => undefined);
            }
          } else {
            await watch?.stop().catch(() => undefined);
          }
          if (stopped) {
            await finish(runtime, task, context, { status: "completed", result: { stopped: true } });
            return;
          }
          const conversation = await runtime.conversation(runtime.conversationId, context);
          if (conversation !== undefined) {
            const content = `${timestampPrefix(new Date(now()), timeZone)} ${prompt}`;
            // One request id per tick: a tick retried after a crash is the same submission.
            const requestId = `loop:${runtime.taskId}:${checkpoint.fired + 1}`;
            if (deliverAs === "steer") {
              await conversation.submit({ type: "input", content, whenBusy: "steer", requestId }, context);
            } else {
              try {
                await conversation.submit({ type: "input", content, whenBusy: "reject", requestId }, context);
              } catch (error) {
                if (error?.name !== "ConversationBusy") throw error;
                // Busy: deliver once, when its work ends; no ticks pile up meanwhile.
                await conversation.waitForIdle(context);
                await conversation.submit({ type: "input", content, whenBusy: "followUp", requestId }, context);
              }
            }
          }
          const at = now();
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: { phase: "wait", nextAt: nextFireAt(checkpoint.nextAt, intervalSecs * 1000, at), fired: checkpoint.fired + 1, lastAt: at },
            }),
            context,
          );
        },
      },
      async abort(task, runtime, context) {
        await finish(runtime, task, context, { status: "aborted", reason: "loop stopped" });
      },
    },
  };
}

function summarize(prompt, max = 60) {
  const text = String(prompt).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How long a loop has run, as the TUI /loop says it (`5m`, `2h`). */
function formatRunning(ms) {
  if (ms >= 3_600_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

/**
 * Loop operations over a Durable commit (a module command's harness, or a tool's api): start,
 * list and stop, sharing the session's registry.
 */
export function loopOperations({ task, now = () => Date.now() }) {
  const live = (doc) =>
    Object.entries(doc.loops ?? {})
      .filter(([, entry]) => entry.stopped !== true)
      .map(([number, entry]) => ({ number: Number(number), ...entry }))
      .sort((a, b) => a.number - b.number);
  return {
    async start(commit, conversationId, { prompt, intervalSecs, deliverAs }) {
      return commit(async (tx) => {
        const doc = await tx.doc(LOOPS_DOC);
        if (live(doc).length >= MAX_LOOPS) throw new Error(`at most ${MAX_LOOPS} loops run at once; stop one first`);
        const number = (Number(doc.last) || 0) + 1;
        const at = now();
        // Like the TUI /loop, the first prompt goes at once.
        const taskId = await tx.createTask(
          task,
          { number, prompt, intervalSecs, deliverAs, firstAt: at, startedAt: at },
          { ownership: { kind: "conversation" }, conversationId, background: true },
        );
        doc.last = number;
        doc.loops[String(number)] = { taskId: String(taskId), prompt, intervalSecs, deliverAs, startedAt: at, conversationId };
        return number;
      });
    },
    async list(commit) {
      return commit(async (tx) => live(await tx.doc(LOOPS_DOC)));
    },
    /** Stop one loop (by number) or all; the numbers stopped. */
    async stop(commit, which) {
      return commit(async (tx) => {
        const doc = await tx.doc(LOOPS_DOC);
        const targets = live(doc).filter((loop) => which === "all" || loop.number === which);
        for (const loop of targets) doc.loops[String(loop.number)].stopped = true;
        return targets.map((loop) => loop.number);
      });
    },
    /**
     * Match the registry to the live loop tasks: drop entries whose task is gone (it ended without
     * cleaning up), and adopt live loops it does not know (started before the registry existed),
     * keeping their numbers.
     */
    async reconcile(commit, liveTasks) {
      return commit(async (tx) => {
        const doc = await tx.doc(LOOPS_DOC);
        const ids = new Set(liveTasks.map((entry) => String(entry.id)));
        for (const [number, entry] of Object.entries(doc.loops ?? {})) if (!ids.has(entry.taskId)) delete doc.loops[number];
        const known = new Set(Object.values(doc.loops ?? {}).map((entry) => entry.taskId));
        for (const entry of liveTasks) {
          const input = entry.input ?? {};
          if (known.has(String(entry.id)) || !Number.isInteger(input.number) || doc.loops[String(input.number)] !== undefined) continue;
          doc.loops[String(input.number)] = {
            taskId: String(entry.id),
            prompt: String(input.prompt ?? ""),
            intervalSecs: Number(input.intervalSecs) || 0,
            deliverAs: input.deliverAs === "steer" ? "steer" : "followUp",
            startedAt: Number(input.startedAt) || now(),
            conversationId: entry.conversationId,
          };
          doc.last = Math.max(Number(doc.last) || 0, input.number);
        }
      });
    },
  };
}

function describeLoop(loop, now) {
  return `#${loop.number}: every ${formatInterval(loop.intervalSecs)}${loop.deliverAs === "steer" ? " (steer)" : ""} — "${summarize(loop.prompt)}" (running ${formatRunning(now - (loop.startedAt ?? now))})`;
}

function listText(loops, now) {
  return loops.length === 0 ? "No active loops." : loops.map((loop) => describeLoop(loop, now)).join("\n");
}

function stopText(stopped, which) {
  if (which === "all") return stopped.length > 0 ? `Stopped ${stopped.length} loop(s).` : "No active loops to stop.";
  return stopped.length > 0 ? `Loop #${which} stopped.` : `No loop #${which} found.`;
}

/** The `/loop` and `/loops` commands over a module command context with `harness` (pi-daemon ≥ 1.10). */
export function createLoopCommands({ task, now = () => Date.now(), minSecs = DEFAULT_MIN_INTERVAL_SECS, defaultDelivery = "followUp" } = {}) {
  const ops = loopOperations({ task, now });
  const commitOf = (ctx) => (change) => ctx.harness.commit(change, ctx.context);
  const ready = (ctx) => {
    if (typeof ctx.harness?.commit === "function") return true;
    ctx.notify("/loop needs pi-daemon 1.10 or later (module commands with the Durable harness).");
    return false;
  };
  // A command can see the live tasks: the registry is matched to them first.
  const prune = async (ctx) => {
    if (typeof ctx.harness.inspect !== "function") return;
    const tasks = (await ctx.harness.inspect(ctx.context)).tasks
      .filter((entry) => entry.record.kind === LOOP_TASK && !entry.record.abortRequested)
      .map((entry) => ({ id: entry.record.id, input: entry.record.input, conversationId: entry.record.conversationId }));
    await ops.reconcile(commitOf(ctx), tasks);
  };
  const list = async (ctx) => {
    await prune(ctx);
    ctx.notify(listText(await ops.list(commitOf(ctx)), now()));
  };

  return {
    loop: {
      description: "Run a prompt on a recurring interval: /loop <interval> <prompt>, /loop list (or /loops), /loop stop [id|all] (off, end)",
      async run(args, ctx) {
        if (!ready(ctx)) return;
        const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        const verb = (parts[0] ?? "").toLowerCase();
        if (verb === "list" || verb === "status") return list(ctx);
        if (verb === "stop" || verb === "off" || verb === "end") {
          const target = (parts[1] ?? "all").toLowerCase().replace(/^#/, "");
          const which = target === "all" ? "all" : Number.parseInt(target, 10);
          if (which !== "all" && (!Number.isInteger(which) || String(which) !== target)) {
            ctx.notify(`Invalid loop id "${parts[1]}".`);
            return;
          }
          await prune(ctx);
          ctx.notify(stopText(await ops.stop(commitOf(ctx), which), which));
          return;
        }
        const intervalSecs = parseIntervalSpec(parts[0], minSecs);
        let words = parts.slice(1);
        let deliverAs = defaultDelivery === "steer" ? "steer" : "followUp";
        if (words[0] === "--steer" || words[0] === "--follow-up") {
          deliverAs = words[0] === "--steer" ? "steer" : "followUp";
          words = words.slice(1);
        }
        const prompt = words.join(" ").trim();
        if (parts.length === 0 || prompt === "") {
          ctx.notify(USAGE);
          return;
        }
        if (intervalSecs === null) {
          ctx.notify(`Invalid interval "${parts[0]}". Use e.g. 30s, 5m, 1h.`);
          return;
        }
        await prune(ctx);
        const number = await ops.start(commitOf(ctx), ctx.conversationId, { prompt, intervalSecs, deliverAs });
        ctx.notify(`Loop #${number} started: "${summarize(prompt)}" every ${formatInterval(intervalSecs)}${deliverAs === "steer" ? " (steer while busy)" : ""}. Stop with /loop stop ${number}`);
      },
    },
    loops: {
      description: "List this session's loops (as /loop list)",
      async run(_args, ctx) {
        if (!ready(ctx)) return;
        await list(ctx);
      },
    },
  };
}

/** The agent's own loop tools, as in TUI Pi: create_loop, list_loops, stop_loop. */
export function createLoopTools({ task, now = () => Date.now(), minSecs = DEFAULT_MIN_INTERVAL_SECS, defaultDelivery = "followUp" } = {}) {
  const ops = loopOperations({ task, now });
  const text = (value, details) => ({ content: [{ type: "text", text: value }], ...(details === undefined ? {} : { details }) });
  const commitOf = (api, context) => (change) => api.commit(change, context);
  return [
    {
      name: "create_loop",
      description:
        "Create a recurring loop that sends a prompt to this conversation at a fixed interval (the first at once). It runs as a durable background task, survives restarts and is listed and stopped by number.",
      parameters: {
        type: "object",
        properties: {
          interval: { type: "string", description: 'Repeat interval like "30s", "5m", "1h" or "1h30m" (a bare number is minutes).' },
          prompt: { type: "string", description: "Prompt to send on each interval." },
          steer: { type: "boolean", description: "While the agent is busy, steer it at once instead of waiting until its work ends." },
        },
        required: ["interval", "prompt"],
        additionalProperties: false,
      },
      async execute(args, api, context) {
        const intervalSecs = parseIntervalSpec(args.interval, minSecs);
        if (intervalSecs === null) return { ...text(`Invalid interval "${args.interval}". Use e.g. 30s, 5m, 1h.`), isError: true };
        const prompt = String(args.prompt ?? "").trim();
        if (prompt === "") return { ...text("Loop prompt cannot be empty."), isError: true };
        const deliverAs = args.steer === true ? "steer" : args.steer === false ? "followUp" : defaultDelivery === "steer" ? "steer" : "followUp";
        const number = await ops.start(commitOf(api, context), api.conversationId, { prompt, intervalSecs, deliverAs });
        return text(`Loop #${number} started: "${summarize(prompt)}" every ${formatInterval(intervalSecs)}. Stop with stop_loop {"id": ${number}}.`, { id: number, intervalSecs, deliverAs });
      },
    },
    {
      name: "list_loops",
      description: "List this session's active loops with their ids, intervals, prompts and how long they have run.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, api, context) {
        const loops = await ops.list(commitOf(api, context));
        return text(listText(loops, now()), { loops: loops.map(({ number, intervalSecs, prompt, deliverAs, startedAt }) => ({ id: number, intervalSecs, prompt, deliverAs, startedAt })) });
      },
    },
    {
      name: "stop_loop",
      description: "Stop one loop by id, or every loop with all: true.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Loop id to stop. Omit when stopping all loops." },
          all: { type: "boolean", description: "Stop all active loops instead of a single loop." },
        },
        additionalProperties: false,
      },
      async execute(args, api, context) {
        const which = args.all === true || args.id === undefined ? "all" : Number(args.id);
        if (which !== "all" && !Number.isInteger(which)) return { ...text(`Invalid loop id "${args.id}".`), isError: true };
        const stopped = await ops.stop(commitOf(api, context), which);
        return text(stopText(stopped, which), { stopped });
      },
    },
  ];
}
