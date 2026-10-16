// Tendril screenshot capture core shared by the TUI `tendril_pi_*` tools
// (extensions/tendril-share.js) and the Durable media adaptor
// (extensions/lib/durable-media.js). Host-neutral: every Tendril invocation goes
// through an injected `exec(command, args, { signal, timeout })` returning
// `{ code, stdout, stderr }` (Pi's `pi.exec` shape), and nothing here touches a
// Pi TUI API.
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildTendrilCommand, tendrilSourceMachine } from "../tendril-command.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const PNG_MIME = "image/png";
// Label used when a capture comes from the bridge on this host rather than a
// --remote host, so source-machine attribution is always populated.
export const LOCAL_SOURCE_MACHINE = "local";

export function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function sanitizeFilenamePart(value) {
  return String(value || "target")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "target";
}

export function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function parseJsonEnvelope(stdout, commandName = "tendril") {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) throw new Error(`${commandName} returned no JSON output.`);
  try { return JSON.parse(trimmed); }
  catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`${commandName} returned invalid JSON: ${error.message}`);
  }
}

/// Resolve the source machine for a capture from the effective Tendril bridge
/// config: the remote host for --remote captures, otherwise "local".
export function resolveSourceMachine(override, env = process.env) {
  const resolved = tendrilSourceMachine(env, override || {});
  return {
    host: resolved.isRemote ? resolved.machine : LOCAL_SOURCE_MACHINE,
    remote: resolved.isRemote,
    source: resolved.source,
  };
}

export function sourceMachineLabel(sourceMachine) {
  if (!sourceMachine) return LOCAL_SOURCE_MACHINE;
  return sourceMachine.remote ? sourceMachine.host : LOCAL_SOURCE_MACHINE;
}

export function targetLabel(target) {
  return [target.title, target.name, target.app_name].filter(Boolean).join(" — ") || target.id || "unknown";
}

export function targetSearchText(target) {
  return [target.id, target.title, target.name, target.app_name].filter(Boolean).join(" ").toLowerCase();
}

export function formatTarget(target) {
  const caps = target.capabilities?.capture ? "capture" : "no-capture";
  return `${target.kind || "?"} ${target.id || "?"} [${caps}] ${targetLabel(target)}`;
}

export function listTargetsText(envelope) {
  const targets = Array.isArray(envelope.data?.targets) ? envelope.data.targets : [];
  if (!targets.length) return "Tendril targets: none";
  return ["Tendril targets:", ...targets.map((target) => `- ${formatTarget(target)}`)].join("\n");
}

/// Run `tendril <args>` through `exec` and return its parsed JSON envelope.
export async function runTendrilJsonWith(exec, args, { signal, timeout = DEFAULT_TIMEOUT_MS, override, env = process.env } = {}) {
  const tendril = buildTendrilCommand(args, env, override || {});
  const result = await exec(tendril.command, tendril.args, { signal, timeout });
  if (result.code !== 0 && !String(result.stdout || "").trim()) {
    const message = result.stderr || `tendril exited with code ${result.code}`;
    throw new Error(`tendril ${args[0] || "command"} failed: ${message}`);
  }
  const envelope = parseJsonEnvelope(result.stdout, `tendril ${args[0] || ""}`);
  if (result.code !== 0 || envelope.status === "error") {
    const message = envelope.error?.message || result.stderr || `tendril exited with code ${result.code}`;
    const code = envelope.error?.code ? ` (${envelope.error.code})` : "";
    throw new Error(`tendril ${args[0] || "command"} failed${code}: ${message}`);
  }
  return envelope;
}

function captureTargets(envelope, kind) {
  return (Array.isArray(envelope?.data?.targets) ? envelope.data.targets : [])
    .filter((candidate) => (!kind || candidate.kind === kind) && candidate.id && candidate.capabilities?.capture);
}

/// Resolve an id or unique name/title/app substring against `tendril list`.
/// An unlisted target is used verbatim as an explicit id.
export async function resolveTendrilTargetWith(exec, { kind, target, override, env = process.env }, signal) {
  if (!target) throw new Error(`Missing ${kind} target. Use /tendril ${kind} <id-or-name> [prompt].`);
  const fallback = { kind, id: String(target), label: String(target), source: "explicit" };
  let envelope;
  try {
    envelope = await runTendrilJsonWith(exec, ["list", "--json"], { signal, timeout: DEFAULT_TIMEOUT_MS, override, env });
  } catch {
    return fallback;
  }
  const targets = captureTargets(envelope, kind);
  const needle = String(target).toLowerCase();
  const exact = targets.find((candidate) => String(candidate.id).toLowerCase() === needle)
    || targets.find((candidate) => targetLabel(candidate).toLowerCase() === needle);
  if (exact) return { ...exact, id: String(exact.id), label: targetLabel(exact), source: "list" };
  const matches = targets.filter((candidate) => targetSearchText(candidate).includes(needle));
  if (matches.length === 1) return { ...matches[0], id: String(matches[0].id), label: targetLabel(matches[0]), source: "list" };
  if (matches.length > 1) {
    throw new Error(`Ambiguous Tendril ${kind} target "${target}". Matches: ${matches.map(formatTarget).join("; ")}`);
  }
  return fallback;
}

/// The first capture-capable display in `tendril list`, for captures that name
/// no target.
export async function firstCaptureDisplayWith(exec, { override, env = process.env } = {}, signal) {
  const envelope = await runTendrilJsonWith(exec, ["list", "--json"], { signal, timeout: DEFAULT_TIMEOUT_MS, override, env });
  const display = captureTargets(envelope, "display")[0];
  if (!display) throw new Error("Tendril lists no capture-capable display; name a window or display target.");
  return { ...display, id: String(display.id), label: targetLabel(display), source: "list" };
}

/// Capture a PNG of a Tendril window/display into `dir` and return its bytes as
/// base64 with the resolved target and source machine. `target` may be an
/// already-resolved target object.
export async function captureTendrilPngWith(exec, { dir, kind, target, maxWidth, maxHeight, override, env = process.env, now = () => new Date() }, signal) {
  const resolved = target && typeof target === "object"
    ? target
    : await resolveTendrilTargetWith(exec, { kind, target, override, env }, signal);
  const sourceMachine = resolveSourceMachine(override, env);
  await mkdir(dir, { recursive: true });
  // Include the source-machine label in the filename so multiple concurrent
  // remote captures (different hosts, same target id) cannot collide on disk.
  const outputPath = path.join(
    dir,
    `${timestampForFilename(now())}-${sanitizeFilenamePart(sourceMachineLabel(sourceMachine))}-${sanitizeFilenamePart(kind)}-${sanitizeFilenamePart(resolved.id)}.png`,
  );
  const args = [
    "capture",
    "--json",
    "--format", "png",
    "--output", outputPath,
    "--timeout-ms", String(clampInteger(env.TENDRIL_SHARE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 120_000)),
    kind === "window" ? "--window" : "--display", String(resolved.id),
  ];
  if (maxWidth !== undefined) args.push("--max-width", String(maxWidth));
  if (maxHeight !== undefined) args.push("--max-height", String(maxHeight));
  const envelope = await runTendrilJsonWith(exec, args, { signal, timeout: DEFAULT_TIMEOUT_MS + 5_000, override, env });
  const data = await readFile(outputPath, "base64");
  return { outputPath, envelope, data, target: resolved, sourceMachine };
}

/// `exec` over child_process for hosts without `pi.exec`: never rejects on a
/// nonzero exit, so callers see `{ code, stdout, stderr }` like `pi.exec`.
export function createNodeExec({ execFileImpl = execFile, env = process.env, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return (command, args, { signal, timeout } = {}) => new Promise((resolve) => {
    execFileImpl(command, args, { signal, timeout, env, maxBuffer, encoding: "utf8" }, (error, stdout = "", stderr = "") => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const code = typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") || String(error.message || error) });
    });
  });
}
