import { randomUUID } from "node:crypto";

import {
  AFTER_ENTRY_TYPE,
  formatAfterDelay,
  parseAfterCommand,
  pendingAfterRecords,
  restoreAfterRecords,
} from "./lib/after.js";

export function createAfterExtension({
  now = () => Date.now(),
  makeId = () => `after-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  return function afterExtension(pi) {
    const records = new Map();
    const timers = new Map();
    let sessionCtx = null;

    const append = (record) => {
      records.set(record.id, { ...record });
      pi.appendEntry?.(AFTER_ENTRY_TYPE, { ...record });
    };

    const clearRuntimeTimer = (id) => {
      const timer = timers.get(id);
      if (timer) clearTimer(timer);
      timers.delete(id);
    };

    const deliver = async (id) => {
      const record = records.get(id);
      if (!record || record.status !== "scheduled" || !sessionCtx) return false;
      clearRuntimeTimer(id);
      // The durable delivering fence is written before dispatch. A crash cannot
      // replay the same prompt/command after restart; at worst it leaves an
      // explicit indeterminate receipt rather than duplicating operator intent.
      append({ ...record, status: "delivering", deliveringAt: now() });
      try {
        if (/^\/compact(?:\s|$)/i.test(record.payload)) {
          const customInstructions = record.payload.replace(/^\/compact\s*/i, "").trim();
          sessionCtx.compact?.({
            ...(customInstructions ? { customInstructions } : {}),
            onError(error) {
              try { sessionCtx?.ui?.notify?.(`/after ${id}: compact failed: ${error?.message || String(error)}`, "warning"); } catch {}
            },
          });
        } else {
          pi.sendUserMessage(record.payload, {
            deliverAs: "followUp",
            expandPromptTemplates: record.payload.startsWith("/"),
          });
        }
        append({ ...record, status: "delivered", deliveredAt: now() });
        try { sessionCtx.ui?.notify?.(`/after ${id}: delivered`, "info"); } catch {}
        return true;
      } catch (error) {
        append({ ...record, status: "failed", failedAt: now(), error: error?.message || String(error) });
        try { sessionCtx.ui?.notify?.(`/after ${id}: ${error?.message || String(error)}`, "warning"); } catch {}
        return false;
      }
    };

    const arm = (record) => {
      clearRuntimeTimer(record.id);
      if (record.status !== "scheduled") return;
      const delay = Math.max(0, Number(record.dueAt || 0) - now());
      const timer = setTimer(() => { void deliver(record.id); }, delay);
      timer?.unref?.();
      timers.set(record.id, timer);
    };

    const cancel = (id) => {
      const targets = id === "all"
        ? pendingAfterRecords(records)
        : [records.get(id)].filter((record) => record?.status === "scheduled");
      for (const record of targets) {
        clearRuntimeTimer(record.id);
        append({ ...record, status: "cancelled", cancelledAt: now() });
      }
      return targets.length;
    };

    pi.registerCommand("after", {
      description: "Deliver a prompt or slash command once after a delay. Usage: /after 10m <text>, /after status, /after cancel <id|all>",
      handler: async (args, ctx) => {
        let parsed;
        try { parsed = parseAfterCommand(args); }
        catch (error) { ctx.ui?.notify?.(error?.message || String(error), "warning"); return; }
        if (parsed.action === "help") {
          ctx.ui?.notify?.("Usage: /after <duration> <prompt-or-command> | /after status | /after cancel <id|all>", "info");
          return;
        }
        if (parsed.action === "status") {
          const pending = pendingAfterRecords(records);
          const message = pending.length === 0
            ? "/after: no pending deliveries"
            : pending.map((record) => `${record.id} in ${formatAfterDelay(record.dueAt - now())}: ${record.payload}`).join("\n");
          ctx.ui?.notify?.(message, "info");
          return;
        }
        if (parsed.action === "cancel") {
          const count = cancel(parsed.id);
          ctx.ui?.notify?.(count ? `/after: cancelled ${count}` : `/after: no pending timer matched ${parsed.id}`, count ? "info" : "warning");
          return;
        }
        const createdAt = now();
        const record = {
          version: 1,
          id: makeId(),
          status: "scheduled",
          createdAt,
          dueAt: createdAt + parsed.delayMs,
          payload: parsed.payload,
        };
        append(record);
        arm(record);
        ctx.ui?.notify?.(`/after ${record.id}: scheduled in ${formatAfterDelay(parsed.delayMs)}`, "info");
      },
    });

    pi.on("session_start", (_event, ctx) => {
      sessionCtx = ctx;
      records.clear();
      let entries = [];
      try { entries = ctx.sessionManager?.getBranch?.() || ctx.sessionManager?.getEntries?.() || []; } catch {}
      for (const [id, record] of restoreAfterRecords(entries)) records.set(id, record);
      for (const record of pendingAfterRecords(records)) arm(record);
    });

    pi.on("session_shutdown", () => {
      sessionCtx = null;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
    });
  };
}

export default createAfterExtension();
