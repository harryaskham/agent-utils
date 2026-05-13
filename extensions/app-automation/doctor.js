import { readFile } from "node:fs/promises";
import path from "node:path";

import { displayPath } from "./display-path.js";

function compactDoctorValue(value, limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function statusCounts(entries = [], field = "status") {
  const counts = {};
  for (const entry of entries) {
    const status = compactDoctorValue(entry?.[field], 80);
    if (!status) continue;
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function renderStatusCounts(counts = {}) {
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status}=${count}`).join(",");
}

export async function readLatestMsDevRefreshSummary(root, { now = new Date() } = {}) {
  const manifestPath = path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json");
  const raw = await readFile(manifestPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!raw) return { status: "missing", manifestPath };
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    return { status: "invalid", manifestPath, error: compactDoctorValue(error.message, 180) };
  }
  const capturedMs = new Date(manifest.capturedAt || "").getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const ageMinutes = Number.isFinite(capturedMs) && Number.isFinite(nowMs) ? Math.max(0, Math.round((nowMs - capturedMs) / 60000)) : undefined;
  const failed = Array.isArray(manifest.failed) ? manifest.failed : [];
  const snapshots = Array.isArray(manifest.snapshots) ? manifest.snapshots : [];
  const config = manifest.config && typeof manifest.config === "object" ? manifest.config : {};
  const cdpPort = Number.parseInt(String(config.cdpPort || ""), 10);
  const sshConnectTimeoutSeconds = Number.parseInt(String(config.sshConnectTimeoutSeconds || ""), 10);
  const preflightAttempts = Number.parseInt(String(config.preflightAttempts || ""), 10);
  const hasSshTargetConfigured = Object.prototype.hasOwnProperty.call(config, "sshTargetConfigured");
  return {
    status: compactDoctorValue(manifest.status, 80) || "unknown",
    capturedAt: manifest.capturedAt || null,
    ageMinutes,
    manifestPath,
    snapshots: snapshots.length,
    failed: failed.length,
    failureStatuses: statusCounts(failed),
    failureErrorKinds: statusCounts(failed, "errorKind"),
    snapshotStatuses: statusCounts(snapshots),
    sshTargetConfigured: hasSshTargetConfigured ? Boolean(config.sshTargetConfigured) : undefined,
    cdpPort: Number.isFinite(cdpPort) ? cdpPort : undefined,
    sshConnectTimeoutSeconds: Number.isFinite(sshConnectTimeoutSeconds) ? sshConnectTimeoutSeconds : undefined,
    preflightAttempts: Number.isFinite(preflightAttempts) ? preflightAttempts : undefined,
  };
}

export function renderDoctorReport({ rootSummary, catalog, playwrightCli, tendrilBridge, tendrilProbe, actionDiagnostics = [], cliCheck, msDevCdpRefresh }) {
  const failureStatuses = renderStatusCounts(msDevCdpRefresh?.failureStatuses);
  const failureErrorKinds = renderStatusCounts(msDevCdpRefresh?.failureErrorKinds);
  const lines = [
    `app automation doctor stateRoot=${displayPath(rootSummary.root, { root: rootSummary.root })} exists=${rootSummary.exists}`,
    `playwrightCli=${playwrightCli}`,
    `tendrilBridge command=${tendrilBridge.command} remote=${tendrilBridge.remote || "none"} wslTunnel=${tendrilBridge.wslTunnel}`,
    tendrilProbe ? `tendrilProbe=${tendrilProbe.status}${tendrilProbe.targets != null ? ` targets=${tendrilProbe.targets}` : ""}${tendrilProbe.error ? ` error=${tendrilProbe.error}` : ""}` : null,
    msDevCdpRefresh ? `msDevCdpRefresh=${msDevCdpRefresh.status}${msDevCdpRefresh.ageMinutes != null ? ` age=${msDevCdpRefresh.ageMinutes}m` : ""}${msDevCdpRefresh.snapshots != null ? ` snapshots=${msDevCdpRefresh.snapshots}` : ""}${msDevCdpRefresh.failed != null ? ` failed=${msDevCdpRefresh.failed}` : ""}${failureStatuses ? ` failureStatuses=${failureStatuses}` : ""}${failureErrorKinds ? ` failureErrorKinds=${failureErrorKinds}` : ""}${msDevCdpRefresh.sshTargetConfigured != null ? ` sshTargetConfigured=${msDevCdpRefresh.sshTargetConfigured}` : ""}${msDevCdpRefresh.cdpPort != null ? ` cdpPort=${msDevCdpRefresh.cdpPort}` : ""}${msDevCdpRefresh.sshConnectTimeoutSeconds != null ? ` connectTimeout=${msDevCdpRefresh.sshConnectTimeoutSeconds}s` : ""}${msDevCdpRefresh.preflightAttempts != null ? ` preflightAttempts=${msDevCdpRefresh.preflightAttempts}` : ""}${msDevCdpRefresh.error ? ` error=${msDevCdpRefresh.error}` : ""}` : null,
    `catalogApps=${catalog.apps.map((app) => app.id).join(",")}`,
  ].filter(Boolean);
  if (catalog.external?.errors?.length) {
    lines.push(`catalogErrors=${catalog.external.errors.length}`);
    lines.push(...catalog.external.errors.slice(0, 5).map((error) => `- ${error.source || "external"}: ${error.error || error.message || String(error)}`));
  } else {
    lines.push("catalogErrors=0");
  }
  if (cliCheck) lines.push(`cliCheck=${cliCheck.status}${cliCheck.version ? ` version=${cliCheck.version}` : ""}${cliCheck.error ? ` error=${cliCheck.error}` : ""}`);
  lines.push("actions:");
  lines.push(...actionDiagnostics.map((entry) => `- ${entry.app}.${entry.action}: ${entry.executable ? "executable" : "not-executable"}${entry.missingParams?.length ? ` missing=${entry.missingParams.join(",")}` : ""}${entry.blockedSteps?.length ? ` blocked=${entry.blockedSteps.map((step) => step.kind).join(",")}` : ""}`));
  return lines.join("\n");
}
