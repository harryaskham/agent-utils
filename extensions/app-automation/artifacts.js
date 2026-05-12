import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const READABLE_EXTENSIONS = new Set([".json", ".md", ".txt", ".html"]);

function relativeTo(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function assertInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate || ".");
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("snapshot path must stay inside the app automation state root");
  }
  return resolved;
}

function normalizeSnapshotAppSelector(app) {
  const value = String(app || "").trim();
  return ["", "all", "*"].includes(value.toLowerCase()) ? undefined : value;
}

async function walkFiles(root, { depth = 4 } = {}, current = root, currentDepth = 0, out = []) {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (currentDepth < depth) await walkFiles(root, { depth }, fullPath, currentDepth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!READABLE_EXTENSIONS.has(extension)) continue;
    const info = await stat(fullPath).catch(() => null);
    if (!info) continue;
    out.push({ path: fullPath, relativePath: relativeTo(root, fullPath), size: info.size, modifiedAt: info.mtime.toISOString(), extension });
  }
  return out;
}

export async function listSnapshotArtifacts({ root, app, limit = 100 } = {}) {
  if (!root) throw new Error("root is required");
  const appSelector = normalizeSnapshotAppSelector(app);
  const snapshotRoot = assertInside(root, appSelector ? path.join("snapshots", appSelector) : "snapshots");
  const exists = await stat(snapshotRoot).then((info) => info.isDirectory(), () => false);
  if (!exists) return { root, snapshotRoot, exists: false, artifacts: [] };
  const artifacts = await walkFiles(root, {}, snapshotRoot);
  artifacts.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.relativePath.localeCompare(b.relativePath));
  return { root, snapshotRoot, exists: true, artifacts: artifacts.slice(0, Math.max(1, Number(limit) || 100)) };
}

export async function readSnapshotArtifact({ root, file, maxBytes = 64_000 } = {}) {
  if (!root) throw new Error("root is required");
  if (!file) throw new Error("file is required");
  const fullPath = assertInside(root, file);
  const extension = path.extname(fullPath).toLowerCase();
  if (!READABLE_EXTENSIONS.has(extension)) throw new Error(`unsupported snapshot artifact extension: ${extension || "none"}`);
  const info = await stat(fullPath);
  if (!info.isFile()) throw new Error("snapshot artifact is not a file");
  const buffer = await readFile(fullPath);
  const limit = Math.max(0, Number(maxBytes) || 64_000);
  const truncated = buffer.length > limit;
  const content = buffer.subarray(0, limit).toString("utf8");
  return { path: fullPath, relativePath: relativeTo(root, fullPath), size: info.size, modifiedAt: info.mtime.toISOString(), truncated, content, extension };
}

function linkedRows(value) {
  const rows = [];
  if (Array.isArray(value.items)) rows.push(...value.items);
  if (Array.isArray(value.notifications)) rows.push(...value.notifications);
  return rows;
}

function rowUrls(row) {
  const urls = new Set();
  if (row?.url) urls.add(row.url);
  if (Array.isArray(row?.urls)) {
    for (const url of row.urls) if (url) urls.add(url);
  }
  return [...urls];
}

function countSnapshotLinks(value) {
  let links = 0;
  let linkItems = 0;
  for (const row of linkedRows(value)) {
    const urls = rowUrls(row);
    if (urls.length) {
      linkItems += 1;
      links += urls.length;
    }
  }
  return { links, linkItems };
}

function compactContextValue(value, limit = 80) {
  if (typeof value === "boolean") return null;
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function snapshotLinkLabel(row, fallback = "snapshot item") {
  const candidates = [row?.label, row?.title, row?.subject, row?.summary, row?.name, row?.channel, row?.from, row?.text];
  const label = candidates.map((value) => compactContextValue(value, 120)).find(Boolean) || fallback;
  return label;
}

function snapshotLinkContext(row = {}) {
  const context = {};
  const source = [row.channel, row.team, row.folder, row.calendar, row.source].map((value) => compactContextValue(value)).find(Boolean);
  const from = [row.from, row.sender, row.organizer, row.author].map((value) => compactContextValue(value)).find(Boolean);
  const time = [row.time, row.timestamp, row.start, row.startTime, row.date, row.when].map((value) => compactContextValue(value)).find(Boolean);
  if (source) context.source = source;
  if (from) context.from = from;
  if (time) context.time = time;
  return context;
}

function snapshotTimestamp(value = {}) {
  return [value.capturedAt, value.detectedAt, value.writtenAt, value.syncedAt]
    .map((entry) => String(entry || "").trim())
    .find(Boolean) || null;
}

function summarizeJson(value) {
  const parts = [];
  if (value.app) parts.push(`app=${value.app}`);
  if (value.action) parts.push(`action=${value.action}`);
  if (value.kind) parts.push(`kind=${value.kind}`);
  if (value.status) parts.push(`status=${value.status}`);
  if (value.reason) parts.push(`reason=${String(value.reason).slice(0, 80)}`);
  if (value.count != null) parts.push(`count=${value.count}`);
  if (value.counts && typeof value.counts === "object") {
    const counts = Object.entries(value.counts).map(([key, count]) => `${key}=${count}`).join(",");
    if (counts) parts.push(`counts=${counts}`);
  }
  if (Array.isArray(value.items)) parts.push(`items=${value.items.length}`);
  const linkCounts = countSnapshotLinks(value);
  if (linkCounts.links) parts.push(`links=${linkCounts.links}`, `linkItems=${linkCounts.linkItems}`);
  if (Array.isArray(value.results)) {
    parts.push(`results=${value.results.length}`);
    const authRequired = value.results.filter((result) => result?.authRequired).length;
    if (authRequired) parts.push(`authRequired=${authRequired}`);
    const statuses = value.results.reduce((counts, result) => {
      const status = result?.status || "unknown";
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {});
    const statusText = Object.entries(statuses).map(([status, count]) => `${status}=${count}`).join(",");
    if (statusText) parts.push(`resultStatuses=${statusText}`);
  }
  if (value.authRequiredPath) parts.push(`authRequiredPath=${value.authRequiredPath}`);
  if (value.detectedAt) parts.push(`detectedAt=${value.detectedAt}`);
  if (value.writtenAt) parts.push(`writtenAt=${value.writtenAt}`);
  if (value.syncedAt) parts.push(`syncedAt=${value.syncedAt}`);
  return parts.join(" ") || "JSON snapshot";
}

function summarizeText(content) {
  const line = String(content || "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) || "empty snapshot";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function summarizeArtifact(artifact) {
  if (artifact.extension === ".json") {
    try {
      return summarizeJson(JSON.parse(artifact.content));
    } catch {
      return "unparseable JSON snapshot";
    }
  }
  return summarizeText(artifact.content);
}

export async function digestSnapshotArtifacts({ root, app, limit = 20, maxBytes = 16_000 } = {}) {
  const listed = await listSnapshotArtifacts({ root, app, limit });
  const artifacts = [];
  for (const artifact of listed.artifacts) {
    const read = await readSnapshotArtifact({ root, file: artifact.relativePath, maxBytes });
    artifacts.push({ ...artifact, truncated: read.truncated, summary: summarizeArtifact(read) });
  }
  return { ...listed, artifacts };
}

function linkMatchesQuery(link, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return [link.app, link.kind, link.artifact, link.label, link.url, ...Object.values(link.context || {})]
    .some((value) => String(value || "").toLowerCase().includes(needle));
}

function linkMatchesFreshness(link, freshness) {
  const wanted = String(freshness || "").trim().toLowerCase();
  if (!wanted) return true;
  return link.freshness === wanted;
}

function normalizeLinkKind(kind) {
  const value = String(kind || "").trim().toLowerCase();
  if (!value) return null;
  const aliases = {
    event: "events.snapshot",
    events: "events.snapshot",
    notification: "notifications.snapshot",
    notifications: "notifications.snapshot",
    calendar: "calendar.snapshot",
  };
  return aliases[value] || value;
}

function linkMatchesKind(link, kind) {
  const wanted = normalizeLinkKind(kind);
  if (!wanted) return true;
  return normalizeLinkKind(link.kind || "unknown") === wanted;
}

function normalizeLinkSort(sort) {
  const value = String(sort || "").trim().toLowerCase();
  return ["newest", "oldest", "freshest", "stalest", "app", "kind"].includes(value) ? value : null;
}

function linkTimestampMs(link = {}) {
  const timestamp = link.snapshotAt || link.artifactModifiedAt;
  const ms = new Date(timestamp || "").getTime();
  return Number.isFinite(ms) ? ms : null;
}

function compareSnapshotLinks(sort) {
  const mode = normalizeLinkSort(sort);
  if (!mode) return null;
  return (a, b) => {
    if (mode === "app") {
      return String(a.app || "").localeCompare(String(b.app || ""))
        || String(a.kind || "").localeCompare(String(b.kind || ""))
        || String(a.label || "").localeCompare(String(b.label || ""))
        || String(a.url || "").localeCompare(String(b.url || ""));
    }
    if (mode === "kind") {
      return String(a.kind || "").localeCompare(String(b.kind || ""))
        || String(a.app || "").localeCompare(String(b.app || ""))
        || String(a.label || "").localeCompare(String(b.label || ""))
        || String(a.url || "").localeCompare(String(b.url || ""));
    }
    if (mode === "freshest" || mode === "stalest") {
      const aAge = Number.isFinite(a.ageMinutes) ? a.ageMinutes : null;
      const bAge = Number.isFinite(b.ageMinutes) ? b.ageMinutes : null;
      if (aAge == null && bAge == null) return String(a.url || "").localeCompare(String(b.url || ""));
      if (aAge == null) return 1;
      if (bAge == null) return -1;
      return mode === "freshest" ? aAge - bAge : bAge - aAge;
    }
    const aTime = linkTimestampMs(a);
    const bTime = linkTimestampMs(b);
    if (aTime == null && bTime == null) return String(a.url || "").localeCompare(String(b.url || ""));
    if (aTime == null) return 1;
    if (bTime == null) return -1;
    return mode === "oldest" ? aTime - bTime : bTime - aTime;
  };
}

function linkFreshness({ snapshotAt, artifactModifiedAt, staleAfterMinutes = 60, now = new Date() } = {}) {
  const threshold = Math.max(1, Number(staleAfterMinutes) || 60);
  const timestamp = snapshotAt || artifactModifiedAt;
  const thenMs = new Date(timestamp || "").getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return { freshness: "unknown", staleAfterMinutes: threshold };
  const ageMinutes = Math.max(0, Math.round((nowMs - thenMs) / 60000));
  return { freshness: ageMinutes > threshold ? "stale" : "fresh", ageMinutes, staleAfterMinutes: threshold };
}

function summarizeLinkFreshness(links = []) {
  const counts = { total: links.length, fresh: 0, stale: 0, unknown: 0 };
  for (const link of links) {
    const key = ["fresh", "stale", "unknown"].includes(link.freshness) ? link.freshness : "unknown";
    counts[key] += 1;
  }
  return counts;
}

function summarizeLinkApps(links = []) {
  const counts = {};
  for (const link of links) {
    const key = String(link.app || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summarizeLinkKinds(links = []) {
  const counts = {};
  for (const link of links) {
    const key = String(link.kind || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export async function collectSnapshotLinks({ root, app, query, freshness, kind, sort, artifactLimit = 100, linkLimit = 100, maxBytes = 64_000, staleAfterMinutes = 60, now = new Date() } = {}) {
  const appSelector = normalizeSnapshotAppSelector(app);
  const normalizedKind = normalizeLinkKind(kind);
  const normalizedSort = normalizeLinkSort(sort);
  const listed = await listSnapshotArtifacts({ root, app: appSelector, limit: artifactLimit });
  const links = [];
  for (const artifact of listed.artifacts.filter((entry) => entry.extension === ".json")) {
    const read = await readSnapshotArtifact({ root, file: artifact.relativePath, maxBytes });
    let value;
    try { value = JSON.parse(read.content); }
    catch { continue; }
    let rowIndex = 0;
    for (const row of linkedRows(value)) {
      rowIndex += 1;
      const urls = rowUrls(row);
      for (const url of urls) {
        const snapshotAt = snapshotTimestamp(value);
        const artifactModifiedAt = artifact.modifiedAt;
        const link = {
          app: value.app || appSelector || artifact.relativePath.split("/")[1] || "unknown",
          kind: value.kind || value.action || null,
          artifact: artifact.relativePath,
          row: rowIndex,
          label: snapshotLinkLabel(row, `${artifact.relativePath}#${rowIndex}`),
          url,
          context: snapshotLinkContext(row),
          snapshotAt,
          artifactModifiedAt,
          ...linkFreshness({ snapshotAt, artifactModifiedAt, staleAfterMinutes, now }),
        };
        if (!linkMatchesQuery(link, query) || !linkMatchesFreshness(link, freshness) || !linkMatchesKind(link, normalizedKind)) continue;
        links.push(link);
      }
    }
  }
  const compare = compareSnapshotLinks(normalizedSort);
  if (compare) links.sort(compare);
  const limit = Math.max(1, Number(linkLimit) || 100);
  const limitedLinks = links.slice(0, limit);
  return {
    ...listed,
    query: query || null,
    freshness: freshness || null,
    kind: normalizedKind,
    sort: normalizedSort,
    matchedCount: links.length,
    returnedCount: limitedLinks.length,
    freshnessCounts: summarizeLinkFreshness(limitedLinks),
    appCounts: summarizeLinkApps(limitedLinks),
    kindCounts: summarizeLinkKinds(limitedLinks),
    links: limitedLinks,
    truncated: links.length > limit,
  };
}

export function aggregateSnapshotLinkSummaries({ root, snapshotRoot, summaries = [], query, freshness, kind, sort } = {}) {
  const normalizedKind = normalizeLinkKind(kind);
  const normalizedSort = normalizeLinkSort(sort);
  const links = summaries.flatMap((summary) => summary.links || []);
  const compare = compareSnapshotLinks(normalizedSort);
  if (compare) links.sort(compare);
  return {
    root,
    snapshotRoot,
    exists: summaries.some((summary) => summary.exists),
    links,
    query: query || null,
    freshness: freshness || null,
    kind: normalizedKind,
    sort: normalizedSort,
    matchedCount: summaries.reduce((total, summary) => total + (summary.matchedCount ?? summary.links?.length ?? 0), 0),
    returnedCount: links.length,
    freshnessCounts: summarizeLinkFreshness(links),
    appCounts: summarizeLinkApps(links),
    kindCounts: summarizeLinkKinds(links),
    truncated: summaries.some((summary) => summary.truncated),
  };
}

export function renderArtifactList(summary) {
  if (!summary.exists) return `No snapshots found at ${summary.snapshotRoot}.`;
  if (!summary.artifacts.length) return `No readable snapshot artifacts found at ${summary.snapshotRoot}.`;
  return summary.artifacts.map((artifact) => `${artifact.relativePath} (${artifact.size} bytes, ${artifact.modifiedAt})`).join("\n");
}

export function renderSnapshotDigest(summary) {
  if (!summary.exists) return `No snapshots found at ${summary.snapshotRoot}.`;
  if (!summary.artifacts.length) return `No readable snapshot artifacts found at ${summary.snapshotRoot}.`;
  return summary.artifacts.map((artifact) => `${artifact.relativePath}: ${artifact.summary}${artifact.truncated ? " (truncated)" : ""}`).join("\n");
}

function renderSnapshotLinkFilters(summary = {}) {
  const filters = [];
  if (summary.freshness) filters.push(`freshness=${summary.freshness}`);
  if (summary.kind) filters.push(`kind=${summary.kind}`);
  if (summary.query) filters.push(`query=${JSON.stringify(summary.query)}`);
  return filters.length ? ` matching ${filters.join(" ")}` : "";
}

function renderSnapshotLinkContext(context = {}) {
  const entries = Object.entries(context).filter(([, value]) => value);
  return entries.length ? ` context=${entries.map(([key, value]) => `${key}:${JSON.stringify(value)}`).join(" ")}` : "";
}

export function renderSnapshotLinks(summary) {
  if (!summary.exists) return `No snapshots found at ${summary.snapshotRoot}.`;
  if (!summary.links.length) return `No snapshot links${renderSnapshotLinkFilters(summary)} found at ${summary.snapshotRoot} (scanned ${summary.artifacts?.length || 0} artifacts).`;
  const counts = summary.freshnessCounts || summarizeLinkFreshness(summary.links);
  const appCounts = summary.appCounts || summarizeLinkApps(summary.links);
  const kindCounts = summary.kindCounts || summarizeLinkKinds(summary.links);
  const appCountsText = Object.entries(appCounts).sort(([a], [b]) => a.localeCompare(b)).map(([app, count]) => `${app}=${count}`).join(",");
  const kindCountsText = Object.entries(kindCounts).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind}=${count}`).join(",");
  const matchedText = summary.matchedCount != null && summary.matchedCount !== counts.total ? ` matched=${summary.matchedCount}` : "";
  const lines = [`links total=${counts.total}${matchedText} fresh=${counts.fresh} stale=${counts.stale} unknown=${counts.unknown}${summary.sort ? ` sort=${summary.sort}` : ""}${appCountsText ? ` apps=${appCountsText}` : ""}${kindCountsText ? ` kinds=${kindCountsText}` : ""}`];
  lines.push(...summary.links.map((link) => `${link.app}${link.kind ? `.${link.kind}` : ""} ${link.label}: ${link.url} (${link.artifact}${renderSnapshotLinkContext(link.context)}${link.snapshotAt ? ` captured=${link.snapshotAt}` : ""}${link.artifactModifiedAt ? ` modified=${link.artifactModifiedAt}` : ""}${link.freshness ? ` freshness=${link.freshness}` : ""}${link.ageMinutes != null ? ` age=${link.ageMinutes}m` : ""})`));
  if (summary.truncated) lines.push(`truncated at ${summary.links.length}${summary.matchedCount != null ? ` of ${summary.matchedCount}` : ""} links`);
  return lines.join("\n");
}

export async function snapshotStalenessReport({ root, apps = [], staleAfterMinutes = 60, now = new Date() } = {}) {
  if (!root) throw new Error("root is required");
  const threshold = Math.max(1, Number(staleAfterMinutes) || 60);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const entries = [];
  for (const app of apps) {
    const listed = await listSnapshotArtifacts({ root, app, limit: 1 });
    const latest = listed.artifacts[0];
    if (!listed.exists || !latest) {
      entries.push({ app, status: "missing", staleAfterMinutes: threshold, snapshotRoot: listed.snapshotRoot });
      continue;
    }
    const modifiedMs = new Date(latest.modifiedAt).getTime();
    const ageMinutes = Math.max(0, Math.round((nowMs - modifiedMs) / 60000));
    entries.push({
      app,
      status: ageMinutes > threshold ? "stale" : "fresh",
      staleAfterMinutes: threshold,
      latestArtifact: latest.relativePath,
      latestModifiedAt: latest.modifiedAt,
      ageMinutes,
    });
  }
  return { root, staleAfterMinutes: threshold, checkedAt: new Date(nowMs).toISOString(), entries };
}

function targetKey(target = {}) {
  return `${target.app}:${target.action}`;
}

function expectedTargetArtifacts(root, target = {}) {
  const outputs = Array.isArray(target.outputs) && target.outputs.length
    ? target.outputs
    : [`snapshots/${target.app}/${target.action}.json`, `snapshots/${target.app}/${target.action}.md`];
  const seen = new Set();
  const artifacts = [];
  for (const output of outputs) {
    const value = String(output || "");
    const extension = path.extname(value).toLowerCase();
    if (!READABLE_EXTENSIONS.has(extension)) continue;
    const relativePath = value.startsWith("snapshots/") ? value : path.join("snapshots", String(target.app), value).split(path.sep).join("/");
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    artifacts.push({ relativePath, path: assertInside(root, relativePath), extension });
  }
  return artifacts;
}

export async function snapshotTargetStalenessReport({ root, targets = [], staleAfterMinutes = 60, now = new Date() } = {}) {
  if (!root) throw new Error("root is required");
  const threshold = Math.max(1, Number(staleAfterMinutes) || 60);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const entries = [];
  for (const target of targets) {
    const expectedArtifacts = expectedTargetArtifacts(root, target);
    const existing = [];
    for (const artifact of expectedArtifacts) {
      const info = await stat(artifact.path).catch(() => null);
      if (!info?.isFile()) continue;
      existing.push({ ...artifact, size: info.size, modifiedAt: info.mtime.toISOString() });
    }
    existing.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.relativePath.localeCompare(b.relativePath));
    const latest = existing[0];
    if (!latest) {
      entries.push({ app: target.app, action: target.action, key: targetKey(target), status: "missing", staleAfterMinutes: threshold, expectedArtifacts: expectedArtifacts.map((artifact) => artifact.relativePath) });
      continue;
    }
    const modifiedMs = new Date(latest.modifiedAt).getTime();
    const ageMinutes = Math.max(0, Math.round((nowMs - modifiedMs) / 60000));
    const expectedPaths = expectedArtifacts.map((artifact) => artifact.relativePath);
    const existingPaths = existing.map((artifact) => artifact.relativePath);
    const missingArtifacts = expectedPaths.filter((relativePath) => !existingPaths.includes(relativePath));
    entries.push({
      app: target.app,
      action: target.action,
      key: targetKey(target),
      status: missingArtifacts.length ? "partial" : (ageMinutes > threshold ? "stale" : "fresh"),
      staleAfterMinutes: threshold,
      latestArtifact: latest.relativePath,
      latestModifiedAt: latest.modifiedAt,
      ageMinutes,
      expectedArtifacts: expectedPaths,
      existingArtifacts: existingPaths,
      missingArtifacts,
    });
  }
  return { root, staleAfterMinutes: threshold, checkedAt: new Date(nowMs).toISOString(), entries };
}

export function renderSnapshotTargetStaleness(report) {
  if (!report.entries.length) return "No app actions requested for staleness reporting.";
  return report.entries.map((entry) => {
    const label = `${entry.app}.${entry.action}`;
    if (entry.status === "missing") return `${label}: missing expected snapshots ${entry.expectedArtifacts.join(", ") || "none"}`;
    if (entry.status === "partial") return `${label}: partial age=${entry.ageMinutes}m latest=${entry.latestArtifact} missing=${entry.missingArtifacts.join(", ") || "unknown"}`;
    return `${label}: ${entry.status} age=${entry.ageMinutes}m latest=${entry.latestArtifact} modified=${entry.latestModifiedAt}`;
  }).join("\n");
}

export function renderSnapshotStaleness(report) {
  if (!report.entries.length) return "No apps requested for staleness reporting.";
  return report.entries.map((entry) => {
    if (entry.status === "missing") return `${entry.app}: missing snapshots at ${entry.snapshotRoot}`;
    return `${entry.app}: ${entry.status} age=${entry.ageMinutes}m latest=${entry.latestArtifact} modified=${entry.latestModifiedAt}`;
  }).join("\n");
}

export async function planSnapshotCleanup({ root, app, keepLatest = 20, protect = ["latest-run.json", "auth-required.json"] } = {}) {
  const listed = await listSnapshotArtifacts({ root, app, limit: 10_000 });
  const protectedNames = new Set(protect);
  const deletable = listed.artifacts.filter((artifact) => !protectedNames.has(path.basename(artifact.relativePath)));
  const keep = Math.max(0, Number(keepLatest) || 20);
  const candidates = deletable.slice(keep);
  const protectedArtifacts = listed.artifacts.filter((artifact) => protectedNames.has(path.basename(artifact.relativePath)));
  return {
    root,
    app,
    keepLatest: keep,
    protected: [...protectedNames],
    scanned: listed.artifacts.length,
    candidateCount: candidates.length,
    protectedCount: protectedArtifacts.length,
    candidates,
    protectedArtifacts,
  };
}

export function renderSnapshotCleanupPlan(plan) {
  if (!plan.scanned) return `No readable snapshot artifacts found for ${plan.app || "all apps"}.`;
  const lines = [
    `${plan.app || "all apps"}: scanned=${plan.scanned} keepLatest=${plan.keepLatest} candidates=${plan.candidateCount} protected=${plan.protectedCount}`,
  ];
  lines.push(...plan.candidates.slice(0, 20).map((artifact) => `- ${artifact.relativePath} (${artifact.size} bytes, ${artifact.modifiedAt})`));
  if (plan.candidates.length > 20) lines.push(`... ${plan.candidates.length - 20} more candidates`);
  return lines.join("\n");
}
