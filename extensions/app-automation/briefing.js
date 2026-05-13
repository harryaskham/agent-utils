import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BRIEFING_ACTIONS = [
  { app: "slack", action: "notifications.snapshot" },
  { app: "calendar", action: "events.snapshot" },
  { app: "outlook", action: "notifications.snapshot" },
  { app: "outlook", action: "calendar.snapshot" },
  { app: "teams", action: "notifications.snapshot" },
  { app: "teams", action: "calendar.snapshot" },
];

function safeKind(action) {
  return String(action || "snapshot").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function compact(value, limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function freshnessFor(timestamp, { staleAfterMinutes = 15, now = new Date() } = {}) {
  const threshold = Math.max(1, Number(staleAfterMinutes) || 15);
  const thenMs = new Date(timestamp || "").getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return { freshness: "unknown", staleAfterMinutes: threshold };
  const ageMinutes = Math.max(0, Math.round((nowMs - thenMs) / 60000));
  return { freshness: ageMinutes > threshold ? "stale" : "fresh", ageMinutes, staleAfterMinutes: threshold };
}

function summarizeItem(item = {}) {
  return {
    text: compact(item.text || item.label || item.title),
    source: compact(item.source),
    from: compact(item.from || item.sender || item.organizer || item.author),
    time: compact(item.time || item.timestamp || item.start || item.date || item.when),
    url: compact(item.url),
  };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function calendarDateParts(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    weekday: WEEKDAYS[date.getDay()],
    weekdayShort: WEEKDAYS[date.getDay()].slice(0, 3),
    month: MONTHS[date.getMonth()],
    monthShort: MONTHS[date.getMonth()].slice(0, 3),
    day: String(date.getDate()),
    year: String(date.getFullYear()),
  };
}

function calendarTodayScore(item = {}, now = new Date()) {
  const parts = calendarDateParts(now);
  if (!parts) return 0;
  const text = compact([item.text, item.label, item.title, item.time, item.date, item.when, item.start].filter(Boolean).join(" "), 600) || "";
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  if (/\btoday\b/i.test(text)) score += 40;
  const day = parts.day.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const weekday = parts.weekday.toLowerCase();
  const weekdayShort = parts.weekdayShort.toLowerCase();
  const month = parts.month.toLowerCase();
  const monthShort = parts.monthShort.toLowerCase();
  if ((lower.includes(weekday) || lower.includes(weekdayShort)) && new RegExp(`\\b${day}\\b`).test(lower)) score += 90;
  if ((lower.includes(month) || lower.includes(monthShort)) && new RegExp(`\\b${day}\\b`).test(lower)) score += 70;
  if (lower.includes(parts.year) && new RegExp(`\\b${day}\\b`).test(lower)) score += 30;
  return score;
}

function sampleItemsForAction(items = [], { action, now, sampleLimit = 5 } = {}) {
  const limit = Math.max(0, Number(sampleLimit) || 0);
  const source = Array.isArray(items) ? items : [];
  if (!/calendar|events/.test(String(action || ""))) return source.slice(0, limit);
  return source
    .map((item, index) => ({ item, index, score: calendarTodayScore(item, now) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, limit)
    .map((entry) => entry.item);
}

function snapshotPathCandidates(root, app, action) {
  const base = path.join(root, "snapshots", app);
  const candidates = [path.join(base, `${safeKind(action)}.json`)];
  if (app === "slack" && action === "notifications.snapshot") candidates.push(path.join(base, "notifications.json"));
  return candidates;
}

async function readSnapshot(root, app, action) {
  const candidates = snapshotPathCandidates(root, app, action);
  let lastPath = candidates[0];
  for (const snapshotPath of candidates) {
    lastPath = snapshotPath;
    const raw = await readFile(snapshotPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!raw) continue;
    try {
      return { app, action, status: "ok", path: snapshotPath, snapshot: JSON.parse(raw) };
    } catch (error) {
      return { app, action, status: "invalid", path: snapshotPath, error: error.message };
    }
  }
  return { app, action, status: "missing", path: lastPath };
}

async function readLatestRefreshAttempts(root, { staleAfterMinutes = 15, now = new Date() } = {}) {
  const manifestPath = path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json");
  const raw = await readFile(manifestPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!raw) return new Map();
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return new Map();
  }
  const attempts = new Map();
  const attemptFreshness = freshnessFor(manifest.capturedAt, { staleAfterMinutes, now });
  for (const entry of [...(manifest.snapshots || []), ...(manifest.failed || [])]) {
    if (!entry?.app || !entry?.action) continue;
    attempts.set(`${entry.app}:${entry.action}`, {
      status: entry.status || "unknown",
      capturedAt: manifest.capturedAt || null,
      source: manifest.source || "ms-dev-chrome-cdp",
      skippedWrite: Boolean(entry.skippedWrite),
      reason: compact(entry.reason, 180),
      error: compact(entry.error, 180),
      rawCount: Number.isFinite(entry.rawCount) ? entry.rawCount : undefined,
      ...attemptFreshness,
    });
  }
  return attempts;
}

export async function buildWorkBriefingIndex({ root, apps, actions = DEFAULT_BRIEFING_ACTIONS, staleAfterMinutes = 15, sampleLimit = 5, now = new Date() } = {}) {
  const wantedApps = new Set((apps || []).map((app) => String(app)));
  const selected = wantedApps.size ? actions.filter((entry) => wantedApps.has(entry.app)) : actions;
  const latestAttempts = await readLatestRefreshAttempts(root, { staleAfterMinutes, now });
  const entries = [];
  for (const { app, action } of selected) {
    const latestRefresh = latestAttempts.get(`${app}:${action}`);
    const loaded = await readSnapshot(root, app, action);
    if (loaded.status !== "ok") {
      entries.push({ app, action, status: loaded.status, path: loaded.path, error: loaded.error || null, freshness: "unknown", itemCount: 0, samples: [], ...(latestRefresh ? { latestRefresh } : {}) });
      continue;
    }
    const snapshot = loaded.snapshot;
    const items = Array.isArray(snapshot.items) ? snapshot.items : (Array.isArray(snapshot.notifications) ? snapshot.notifications : []);
    const freshness = freshnessFor(snapshot.capturedAt, { staleAfterMinutes, now });
    entries.push({
      app,
      action,
      status: snapshot.authRequired ? "auth_required" : (snapshot.status || "unknown"),
      path: loaded.path,
      capturedAt: snapshot.capturedAt || null,
      ...freshness,
      itemCount: Number.isFinite(snapshot.count) ? snapshot.count : (Number.isFinite(snapshot.counts?.items) ? snapshot.counts.items : items.length),
      authRequired: Boolean(snapshot.authRequired),
      ...(latestRefresh ? { latestRefresh } : {}),
      samples: sampleItemsForAction(items, { action, now, sampleLimit }).map(summarizeItem),
    });
  }
  const preservedStale = entries.filter((entry) => entry.freshness === "stale" && entry.latestRefresh?.status === "filtered_empty" && entry.latestRefresh?.skippedWrite).length;
  const index = {
    version: 1,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root,
    staleAfterMinutes: Math.max(1, Number(staleAfterMinutes) || 15),
    totals: {
      actions: entries.length,
      fresh: entries.filter((entry) => entry.freshness === "fresh").length,
      stale: entries.filter((entry) => entry.freshness === "stale").length,
      preservedStale,
      effectiveStale: Math.max(0, entries.filter((entry) => entry.freshness === "stale").length - preservedStale),
      filteredEmptyRefresh: entries.filter((entry) => entry.latestRefresh?.status === "filtered_empty").length,
      missing: entries.filter((entry) => entry.status === "missing").length,
      authRequired: entries.filter((entry) => entry.authRequired || entry.status === "auth_required").length,
      items: entries.reduce((sum, entry) => sum + (entry.itemCount || 0), 0),
    },
    entries,
  };
  const indexDir = path.join(root, "indexes");
  await mkdir(indexDir, { recursive: true });
  const indexPath = path.join(indexDir, "work-briefing.json");
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return { ...index, indexPath };
}

export function renderWorkBriefingIndex(index = {}) {
  const totals = index.totals || {};
  const lines = [
    `work briefing generated=${index.generatedAt || "unknown"} staleAfter=${index.staleAfterMinutes || "unknown"}m actions=${totals.actions || 0} fresh=${totals.fresh || 0} stale=${totals.stale || 0}${totals.preservedStale ? ` preservedStale=${totals.preservedStale} effectiveStale=${totals.effectiveStale || 0}` : ""}${totals.filteredEmptyRefresh ? ` filteredEmptyRefresh=${totals.filteredEmptyRefresh}` : ""} missing=${totals.missing || 0} authRequired=${totals.authRequired || 0} items=${totals.items || 0}`,
  ];
  if (index.indexPath) lines.push(`index=${index.indexPath}`);
  for (const entry of index.entries || []) {
    const age = entry.ageMinutes != null ? ` age=${entry.ageMinutes}m` : "";
    const auth = entry.authRequired ? " authRequired=true" : "";
    const refresh = entry.latestRefresh ? ` latestRefresh=${entry.latestRefresh.status}${entry.latestRefresh.ageMinutes != null ? `/${entry.latestRefresh.ageMinutes}m` : ""}${entry.latestRefresh.skippedWrite ? "/skippedWrite" : ""}` : "";
    lines.push(`${entry.app}.${entry.action}: status=${entry.status} freshness=${entry.freshness}${age} items=${entry.itemCount || 0}${auth}${refresh}`);
    for (const sample of entry.samples || []) {
      const context = [sample.source ? `source=${JSON.stringify(sample.source)}` : null, sample.from ? `from=${JSON.stringify(sample.from)}` : null, sample.time ? `time=${JSON.stringify(sample.time)}` : null].filter(Boolean).join(" ");
      lines.push(`  - ${sample.text || "(untitled)"}${context ? ` (${context})` : ""}`);
    }
  }
  return lines.join("\n");
}
