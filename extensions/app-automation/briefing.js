import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FAILED_REFRESH_STATUSES = new Set(["copy_failed", "run_failed", "parse_failed", "extract_failed", "cdp_unavailable"]);

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

function isBriefingChromeItem(item = {}, { app, action } = {}) {
  const text = compact(item.text || item.label || item.title, 260) || "";
  if (!text) return true;
  if (app === "outlook" && action === "notifications.snapshot") {
    return /^add-ins?\b/i.test(text) || /enhance outlook with apps/i.test(text) || /viva insights/i.test(text);
  }
  return false;
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
  const dayToken = `${day}(?!\\s*:)`;
  const weekday = parts.weekday.toLowerCase();
  const weekdayShort = parts.weekdayShort.toLowerCase();
  const month = parts.month.toLowerCase();
  const monthShort = parts.monthShort.toLowerCase();
  const weekdayDate = new RegExp(`\\b(?:${weekday}|${weekdayShort})\\b[^|\\n]{0,80}\\b${dayToken}\\b|\\b${dayToken}\\b[^|\\n]{0,80}\\b(?:${weekday}|${weekdayShort})\\b`, "i");
  const monthDate = new RegExp(`\\b(?:${month}|${monthShort})\\b\\s+${dayToken}\\b|\\b${dayToken}\\b\\s+(?:${month}|${monthShort})\\b`, "i");
  if (weekdayDate.test(lower)) score += 90;
  if (monthDate.test(lower)) score += 70;
  return score;
}

function sampleItemsForAction(items = [], { action, now, sampleLimit = 5 } = {}) {
  const limit = Math.max(0, Number(sampleLimit) || 0);
  const source = Array.isArray(items) ? items : [];
  if (!/calendar|events/.test(String(action || ""))) return source.slice(0, limit);
  const scored = source.map((item, index) => ({ item, index, score: calendarTodayScore(item, now) }));
  const todayRows = scored.filter((entry) => entry.score > 0);
  return (todayRows.length ? todayRows : scored)
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
      errorKind: compact(entry.errorKind, 80),
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
    const briefingItems = items.filter((item) => !isBriefingChromeItem(item, { app, action }));
    const freshness = freshnessFor(snapshot.capturedAt, { staleAfterMinutes, now });
    const rawItemCount = Number.isFinite(snapshot.count) ? snapshot.count : (Number.isFinite(snapshot.counts?.items) ? snapshot.counts.items : items.length);
    const hiddenChromeCount = Math.max(0, rawItemCount - briefingItems.length);
    entries.push({
      app,
      action,
      status: snapshot.authRequired ? "auth_required" : (snapshot.status || "unknown"),
      path: loaded.path,
      capturedAt: snapshot.capturedAt || null,
      ...freshness,
      itemCount: briefingItems.length,
      ...(hiddenChromeCount ? { rawItemCount, hiddenChromeCount } : {}),
      authRequired: Boolean(snapshot.authRequired),
      ...(latestRefresh ? { latestRefresh } : {}),
      samples: sampleItemsForAction(briefingItems, { action, now, sampleLimit }).map(summarizeItem),
    });
  }
  const preservedStale = entries.filter((entry) => entry.freshness === "stale" && ["filtered_empty", "raw_empty"].includes(entry.latestRefresh?.status) && entry.latestRefresh?.skippedWrite).length;
  const failedRefreshStatuses = {};
  for (const entry of entries) {
    const status = entry.latestRefresh?.status;
    if (!FAILED_REFRESH_STATUSES.has(status)) continue;
    failedRefreshStatuses[status] = (failedRefreshStatuses[status] || 0) + 1;
  }
  const failedRefreshErrorKinds = {};
  for (const entry of entries) {
    const errorKind = entry.latestRefresh?.errorKind;
    if (!errorKind || !FAILED_REFRESH_STATUSES.has(entry.latestRefresh?.status)) continue;
    failedRefreshErrorKinds[errorKind] = (failedRefreshErrorKinds[errorKind] || 0) + 1;
  }
  const failedRefresh = Object.values(failedRefreshStatuses).reduce((sum, count) => sum + count, 0);
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
      failedRefresh,
      ...(failedRefresh ? { failedRefreshStatuses } : {}),
      ...(Object.keys(failedRefreshErrorKinds).length ? { failedRefreshErrorKinds } : {}),
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
  const failedStatuses = Object.entries(totals.failedRefreshStatuses || {}).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status}=${count}`).join(",");
  const failedErrorKinds = Object.entries(totals.failedRefreshErrorKinds || {}).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind}=${count}`).join(",");
  const lines = [
    `work briefing generated=${index.generatedAt || "unknown"} staleAfter=${index.staleAfterMinutes || "unknown"}m actions=${totals.actions || 0} fresh=${totals.fresh || 0} stale=${totals.stale || 0}${totals.preservedStale ? ` preservedStale=${totals.preservedStale} effectiveStale=${totals.effectiveStale || 0}` : ""}${totals.filteredEmptyRefresh ? ` filteredEmptyRefresh=${totals.filteredEmptyRefresh}` : ""}${totals.failedRefresh ? ` failedRefresh=${totals.failedRefresh}` : ""}${failedStatuses ? ` failedRefreshStatuses=${failedStatuses}` : ""}${failedErrorKinds ? ` failedRefreshErrorKinds=${failedErrorKinds}` : ""} missing=${totals.missing || 0} authRequired=${totals.authRequired || 0} items=${totals.items || 0}`,
  ];
  if (index.indexPath) lines.push(`index=${index.indexPath}`);
  for (const entry of index.entries || []) {
    const age = entry.ageMinutes != null ? ` age=${entry.ageMinutes}m` : "";
    const auth = entry.authRequired ? " authRequired=true" : "";
    const refresh = entry.latestRefresh ? ` latestRefresh=${entry.latestRefresh.status}${entry.latestRefresh.ageMinutes != null ? `/${entry.latestRefresh.ageMinutes}m` : ""}${entry.latestRefresh.skippedWrite ? "/skippedWrite" : ""}${entry.latestRefresh.errorKind ? `/${entry.latestRefresh.errorKind}` : ""}` : "";
    const hidden = entry.hiddenChromeCount ? ` rawItems=${entry.rawItemCount || 0} hiddenChrome=${entry.hiddenChromeCount}` : "";
    lines.push(`${entry.app}.${entry.action}: status=${entry.status} freshness=${entry.freshness}${age} items=${entry.itemCount || 0}${hidden}${auth}${refresh}`);
    for (const sample of entry.samples || []) {
      const context = [sample.source ? `source=${JSON.stringify(sample.source)}` : null, sample.from ? `from=${JSON.stringify(sample.from)}` : null, sample.time ? `time=${JSON.stringify(sample.time)}` : null].filter(Boolean).join(" ");
      lines.push(`  - ${sample.text || "(untitled)"}${context ? ` (${context})` : ""}`);
    }
  }
  return lines.join("\n");
}
