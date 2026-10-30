// /cron for TUI Pi: a prompt or command on a five-field cron schedule in a time zone. Each
// schedule holds one timer, to its next occurrence (worked out once per firing, never polled), and
// lives in the session's entries, so it comes back with the session. An occurrence missed while
// the session was closed runs once when it opens, as Durable /cron's does in pi-daemon. Each run
// saves the next occurrence before it delivers, so a crash skips a run rather than repeating it.
//
//   /cron '0 9 * * 1-5' [tz=Europe/London] <prompt or /command>   (or @daily …)
//   /cron list (or status)      /cron stop <id|all>
//
// Delivery as /after's: /compact compacts, another /command runs, anything else is a prompt.
import { localTimeZone, nextCronAt, parseCronArgs } from "./lib/cron.js";
import { dispatchScheduled } from "./lib/scheduled-dispatch.js";

export const CRON_ENTRY_TYPE = "agent-utils-cron";
/** The longest setTimeout delay; a later occurrence takes one more timer on the way. */
const MAX_TIMER_MS = 2_147_483_647;
const USAGE = "Usage: /cron '<min hour day month weekday>' [tz=Zone] <prompt or /command> (or @hourly, @daily, @weekly …) | /cron list | /cron stop <id|all>";

function shortIn(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d`;
}

export function createCronExtension({ now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, defaultTimeZone } = {}) {
  return function cronExtension(pi) {
    const records = new Map();
    const timers = new Map();
    let sessionCtx = null;

    const save = (record) => {
      records.set(record.id, { ...record });
      pi.appendEntry?.(CRON_ENTRY_TYPE, { ...record });
    };
    const disarm = (id) => {
      const timer = timers.get(id);
      if (timer) clearTimer(timer);
      timers.delete(id);
    };
    const active = () => [...records.values()].filter((record) => record.status === "active").sort((a, b) => Number(a.id) - Number(b.id));

    const fire = (id) => {
      const record = records.get(id);
      if (!record || record.status !== "active" || !sessionCtx) return;
      timers.delete(id);
      const at = now();
      // The next occurrence after this one (missed ones are not replayed), saved before the
      // delivery, as /after's fence: a crash in between skips this run rather than repeating it.
      const nextAt = nextCronAt(record.expression, record.timeZone, Math.max(at, Number(record.nextAt) || 0));
      save(nextAt === undefined ? { ...record, status: "done", lastAt: at } : { ...record, nextAt, lastAt: at });
      try {
        dispatchScheduled(pi, sessionCtx, record.payload, {
          deliverAs: "followUp",
          onCompactError(error) {
            try { sessionCtx?.ui?.notify?.(`/cron ${id}: compact failed: ${error?.message || String(error)}`, "warning"); } catch {}
          },
        });
      } catch (error) {
        try { sessionCtx.ui?.notify?.(`/cron ${id}: ${error?.message || String(error)}`, "warning"); } catch {}
      }
      if (nextAt !== undefined) arm(records.get(id));
    };

    const arm = (record) => {
      disarm(record.id);
      if (record.status !== "active") return;
      const delay = Math.max(0, Number(record.nextAt) - now());
      // Beyond setTimeout's reach: wake on the way and arm again, once per ~24 days.
      const timer = delay > MAX_TIMER_MS ? setTimer(() => arm(records.get(record.id)), MAX_TIMER_MS) : setTimer(() => fire(record.id), delay);
      timer?.unref?.();
      timers.set(record.id, timer);
    };

    const describe = (record) =>
      `#${record.id}: ${record.expression} (${record.timeZone}), next in ${shortIn(Number(record.nextAt) - now())} — ${record.payload}`;

    pi.registerCommand("cron", {
      description: "Run a prompt or command on a cron schedule: /cron '0 9 * * 1-5' [tz=Zone] <text>, /cron list, /cron stop <id|all>",
      handler: async (args, ctx) => {
        sessionCtx = ctx;
        const text = String(args || "").trim();
        if (!text) return ctx.ui?.notify?.(USAGE, "info");
        const verb = /^(list|status|stop|off|end|cancel)\b\s*(.*)$/i.exec(text);
        if (verb && /^(list|status)$/i.test(verb[1])) {
          const list = active();
          return ctx.ui?.notify?.(list.length === 0 ? "/cron: no schedules" : list.map(describe).join("\n"), "info");
        }
        if (verb) {
          const target = (verb[2] || "all").trim().replace(/^#/, "");
          const targets = target === "all" ? active() : [records.get(target)].filter((record) => record?.status === "active");
          for (const record of targets) {
            disarm(record.id);
            save({ ...record, status: "stopped", stoppedAt: now() });
          }
          return ctx.ui?.notify?.(targets.length ? `/cron: stopped ${targets.length}` : `/cron: no schedule ${target}`, targets.length ? "info" : "warning");
        }
        let parsed;
        try {
          parsed = parseCronArgs(text);
        } catch (error) {
          return ctx.ui?.notify?.(`${error?.message || String(error)}. ${USAGE}`, "warning");
        }
        const timeZone = parsed.timeZone ?? defaultTimeZone ?? process.env.PI_LOOP_TZ ?? localTimeZone();
        const nextAt = nextCronAt(parsed.expression, timeZone, now());
        if (nextAt === undefined) return ctx.ui?.notify?.(`/cron: "${parsed.expression}" never fires`, "warning");
        const id = String(Math.max(0, ...[...records.keys()].map(Number).filter(Number.isFinite)) + 1);
        const record = { version: 1, id, status: "active", expression: parsed.expression, timeZone, payload: parsed.prompt, createdAt: now(), nextAt };
        save(record);
        arm(record);
        ctx.ui?.notify?.(`/cron #${id}: ${record.expression} (${timeZone}), next in ${shortIn(nextAt - now())}. Stop with /cron stop ${id}.`, "info");
      },
    });

    pi.on("session_start", (_event, ctx) => {
      sessionCtx = ctx;
      for (const id of [...timers.keys()]) disarm(id);
      records.clear();
      let entries = [];
      try { entries = ctx.sessionManager?.getBranch?.() || ctx.sessionManager?.getEntries?.() || []; } catch {}
      for (const entry of entries) {
        if (entry?.type !== "custom" || entry.customType !== CRON_ENTRY_TYPE || typeof entry.data?.id !== "string") continue;
        records.set(entry.data.id, { ...entry.data });
      }
      // Missed while closed: the timer fires at once, then the next occurrence.
      for (const record of active()) arm(record);
    });

    pi.on("session_shutdown", () => {
      sessionCtx = null;
      for (const id of [...timers.keys()]) disarm(id);
    });
  };
}

export default createCronExtension();
