import { writeFile } from "node:fs/promises";
import path from "node:path";

function summarizeResult(result = {}) {
  const summary = {
    index: result.index,
    kind: result.kind,
    status: result.status,
  };
  if (result.code != null) summary.code = result.code;
  if (result.authRequired) summary.authRequired = true;
  if (result.authRequiredPath) summary.authRequiredPath = result.authRequiredPath;
  if (result.snapshotStatus) summary.snapshotStatus = result.snapshotStatus;
  if (result.syncStatus) summary.syncStatus = result.syncStatus;
  if (result.count != null) summary.count = result.count;
  if (result.counts) summary.counts = result.counts;
  if (result.outputs) summary.outputs = result.outputs;
  if (result.outputPath) summary.outputPath = result.outputPath;
  if (result.extractionError) summary.extractionError = result.extractionError;
  if (result.reason) summary.reason = result.reason;
  return summary;
}

export function buildSafeRunManifest({ plan, run, now = new Date() } = {}) {
  return {
    version: 1,
    app: plan?.app?.id,
    action: plan?.action?.id,
    status: run?.status || "unknown",
    reason: run?.reason,
    writtenAt: now.toISOString(),
    results: (run?.results || []).map(summarizeResult),
  };
}

export async function writeLatestRunManifest(snapshotDir, manifest) {
  const outputPath = path.join(snapshotDir, "latest-run.json");
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return outputPath;
}
