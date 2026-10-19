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

const USAGE = "Usage: /loop <interval> [--steer] <prompt> | /loop list | /loop stop [id|all] (off and end too); e.g. /loop 5m Check the inbox";

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
export function createLoopTask({ now = () => Date.now(), wait = sleep, timeZone } = {}) {
  return {
    definition: {
      name: LOOP_TASK,
      version: 1,
      initial: (input) => ({ phase: "wait", nextAt: input.firstAt, fired: 0 }),
      phases: {
        async wait(task, runtime, context) {
          const { prompt, intervalSecs, deliverAs } = task.input;
          const checkpoint = task.state.checkpoint;
          await wait(checkpoint.nextAt - now(), runtime.signal);
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
      async abort(_task, runtime, context) {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "loop stopped" } }), context);
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

/** The `/loop` command over a module command context with `harness` (pi-daemon ≥ 1.10). */
export function createLoopCommands({ task, now = () => Date.now(), minSecs = DEFAULT_MIN_INTERVAL_SECS, defaultDelivery = "followUp" } = {}) {
  // This session's loops, by number.
  const loopsOf = async (ctx) =>
    (await ctx.harness.inspect(ctx.context)).tasks
      .filter((entry) => entry.record.kind === LOOP_TASK && !entry.record.abortRequested)
      .sort((a, b) => (a.record.input.number ?? 0) - (b.record.input.number ?? 0));
  const stop = async (ctx, loops) => {
    for (const loop of loops) await ctx.harness.abortTask(loop.record.id, ctx.context);
  };

  return {
    loop: {
      description: "Run a prompt on a recurring interval: /loop <interval> <prompt>, /loop list, /loop stop [id|all] (off, end)",
      async run(args, ctx) {
        if (typeof ctx.harness?.inspect !== "function") {
          ctx.notify("/loop needs pi-daemon 1.10 or later (module commands with the Durable harness).");
          return;
        }
        const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        const verb = (parts[0] ?? "").toLowerCase();

        if (verb === "list" || verb === "status") {
          const loops = await loopsOf(ctx);
          ctx.notify(
            loops.length === 0
              ? "No active loops."
              : loops
                  .map((loop) => {
                    const { number, intervalSecs, prompt, startedAt, deliverAs } = loop.record.input;
                    return `#${number}: every ${formatInterval(intervalSecs)}${deliverAs === "steer" ? " (steer)" : ""} — "${summarize(prompt)}" (running ${formatRunning(now() - (startedAt ?? now()))})`;
                  })
                  .join("\n"),
          );
          return;
        }

        if (verb === "stop" || verb === "off" || verb === "end") {
          const target = (parts[1] ?? "all").toLowerCase();
          const loops = await loopsOf(ctx);
          if (target === "all") {
            await stop(ctx, loops);
            ctx.notify(loops.length > 0 ? `Stopped ${loops.length} loop(s).` : "No active loops to stop.");
            return;
          }
          const number = Number.parseInt(target.replace(/^#/, ""), 10);
          if (!Number.isInteger(number) || String(number) !== target.replace(/^#/, "")) {
            ctx.notify(`Invalid loop id "${parts[1]}".`);
            return;
          }
          const found = loops.filter((loop) => loop.record.input.number === number);
          await stop(ctx, found);
          ctx.notify(found.length > 0 ? `Loop #${number} stopped.` : `No loop #${number} found.`);
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
        // Numbers count up per session, as the TUI /loop's do.
        const number = (Number(await ctx.state.get("lastLoop")) || 0) + 1;
        await ctx.state.set("lastLoop", number);
        const at = now();
        // Like the TUI /loop, the first prompt goes at once.
        await ctx.harness.commit(
          (tx) =>
            tx.createTask(task, { number, prompt, intervalSecs, deliverAs, firstAt: at, startedAt: at }, { ownership: { kind: "conversation" }, conversationId: ctx.conversationId, background: true }),
          ctx.context,
        );
        ctx.notify(`Loop #${number} started: "${summarize(prompt)}" every ${formatInterval(intervalSecs)}${deliverAs === "steer" ? " (steer while busy)" : ""}. Stop with /loop stop ${number}`);
      },
    },
  };
}
