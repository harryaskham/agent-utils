export const AFTER_ENTRY_TYPE = "agent-utils-after";
export const MAX_AFTER_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

const UNIT_MS = Object.freeze({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 });

export function parseAfterDuration(input, { maxMs = MAX_AFTER_DELAY_MS } = {}) {
  const raw = String(input || "").trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw);
  if (!match) throw new Error("/after: duration must be a number followed by ms, s, m, or h (for example 120s or 10m)");
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  if (!Number.isFinite(ms) || ms < 10) throw new Error("/after: duration must be at least 10ms");
  if (ms > maxMs) throw new Error(`/after: duration must not exceed ${Math.floor(maxMs / 86_400_000)} days`);
  return Math.round(ms);
}

export function parseAfterCommand(args) {
  const raw = String(args || "").trim();
  if (!raw) return { action: "help" };
  if (/^status$/i.test(raw)) return { action: "status" };
  const cancel = /^cancel(?:\s+(.+))?$/i.exec(raw);
  if (cancel) return { action: "cancel", id: String(cancel[1] || "all").trim() || "all" };
  const match = /^(\S+)\s+([\s\S]+)$/.exec(raw);
  if (!match) throw new Error("Usage: /after <duration> <prompt-or-command> | /after status | /after cancel <id|all>");
  return { action: "schedule", delayMs: parseAfterDuration(match[1]), payload: match[2].trim() };
}

export function restoreAfterRecords(entries = []) {
  const latest = new Map();
  for (const entry of entries || []) {
    if (entry?.type !== "custom" || entry.customType !== AFTER_ENTRY_TYPE) continue;
    const data = entry.data;
    if (!data || typeof data.id !== "string" || typeof data.status !== "string") continue;
    latest.set(data.id, { ...data });
  }
  return latest;
}

export function pendingAfterRecords(records) {
  return [...records.values()]
    .filter((record) => record.status === "scheduled")
    .sort((a, b) => Number(a.dueAt || 0) - Number(b.dueAt || 0));
}

export function formatAfterDelay(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${Math.ceil(value / 1000)}s`;
  if (value < 3_600_000) return `${Math.ceil(value / 60_000)}m`;
  return `${Math.ceil(value / 3_600_000)}h`;
}
