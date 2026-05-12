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
  const snapshotRoot = assertInside(root, app ? path.join("snapshots", String(app)) : "snapshots");
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
