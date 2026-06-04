// Opt-in Xvfb orchestration for headless Linux nodes (bd-a0e836).
//
// Follow-up to the bd-44d94e detection helper (./headless-display.js), which
// classifies display availability but explicitly does NOT spawn anything. This
// module adds the orchestration slice: on a headless Linux node it can spawn an
// Xvfb virtual display and export DISPLAY so display-dependent extensions
// (tendril capture, android screenshots, app-automation browser) can run, then
// tear the process down on session shutdown.
//
// Safety constraints (from the bead):
//   - Opt-in / guarded: never spawn unprompted. Callers invoke ensureXvfb()
//     explicitly; planXvfb() refuses unless the node is genuinely headless.
//   - Detect availability: refuse cleanly if the Xvfb binary is not on PATH.
//   - Unique display number: pick a free :N by probing /tmp/.X11-unix so we do
//     not collide with another agent's display on the same host.
//   - Lifecycle cleanup: the spawned process is tracked and stopped on
//     session_shutdown.
//
// The policy / display-selection / command-construction layer is pure over its
// injected probes (env, platform, commandPath, fileExists) so it is trivially
// unit-testable without spawning or touching the real filesystem. Only
// spawnXvfb()/stopXvfb() perform real side effects.

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { detectHeadlessDisplay, DISPLAY_HEADLESS } from "./headless-display.js";

export const DEFAULT_XVFB_SCREEN = "1920x1080x24";
// Range of X display numbers we are willing to allocate. :0–:9 are commonly
// taken by real sessions / WSLg, so we start at :99 and walk upward, which also
// matches the hint string emitted by headless-display.js.
export const XVFB_DISPLAY_MIN = 99;
export const XVFB_DISPLAY_MAX = 1099;

/**
 * Locate the Xvfb executable on PATH (or accept an absolute/relative path).
 * Mirrors the PATH-probe convention used elsewhere in the package.
 *
 * @param {string} [command] binary name or path (defaults to "Xvfb")
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|undefined} resolved path, or undefined if not executable
 */
export function xvfbCommandPath(command = "Xvfb", env = process.env) {
  if (!command) return undefined;
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return undefined;
    }
  }
  const pathValue = env?.PATH || "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

// Default existence probe: an X display :N holds a lock socket at
// /tmp/.X11-unix/XN while in use. Treat the presence of that socket as "in
// use" so concurrent agents on the same host do not pick the same number.
function defaultDisplayLockExists(displayNumber) {
  return existsSync(`/tmp/.X11-unix/X${displayNumber}`);
}

/**
 * Whether an X display number currently appears to be in use.
 *
 * @param {number} displayNumber
 * @param {(displayNumber: number) => boolean} [fileExists] injectable probe
 * @returns {boolean}
 */
export function displayInUse(displayNumber, fileExists = defaultDisplayLockExists) {
  return Boolean(fileExists(displayNumber));
}

/**
 * Pick the lowest free X display number in [min, max], skipping any whose lock
 * socket already exists. Returns null if the whole range is occupied.
 *
 * @param {object} [options]
 * @param {number} [options.min]
 * @param {number} [options.max]
 * @param {(displayNumber: number) => boolean} [options.fileExists]
 * @returns {number|null}
 */
export function pickFreeDisplay({ min = XVFB_DISPLAY_MIN, max = XVFB_DISPLAY_MAX, fileExists = defaultDisplayLockExists } = {}) {
  for (let n = min; n <= max; n += 1) {
    if (!displayInUse(n, fileExists)) return n;
  }
  return null;
}

/**
 * Build the Xvfb argv for a display number and screen geometry.
 *
 * @param {number} displayNumber
 * @param {object} [options]
 * @param {string} [options.screen] e.g. "1920x1080x24"
 * @returns {string[]}
 */
export function buildXvfbArgs(displayNumber, { screen = DEFAULT_XVFB_SCREEN } = {}) {
  return [`:${displayNumber}`, "-screen", "0", screen, "-nolisten", "tcp"];
}

/**
 * Decide whether and how to spawn Xvfb. Pure over its injected probes; performs
 * no side effects. Returns a discriminated plan:
 *   { ok: false, reason, ... }                       -> do not spawn
 *   { ok: true, display, displayNumber, command, args, screen } -> spawn this
 *
 * Refusal reasons:
 *   - "already-spawned": this session already owns a running Xvfb.
 *   - "display-present": the node already has a usable display (not headless),
 *     unless force=true. We never override a real/WSLg display by default.
 *   - "xvfb-missing": the Xvfb binary is not on PATH.
 *   - "no-free-display": every candidate display number is occupied.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {boolean} [options.force] spawn even if a display is already present
 * @param {string} [options.screen]
 * @param {string} [options.command] Xvfb binary name/path
 * @param {boolean} [options.alreadySpawned] this session already owns one
 * @param {(command: string, env: NodeJS.ProcessEnv) => (string|undefined)} [options.resolveCommand]
 * @param {(displayNumber: number) => boolean} [options.fileExists]
 * @param {number} [options.min]
 * @param {number} [options.max]
 */
export function planXvfb({
  env = process.env,
  platform = process.platform,
  force = false,
  screen = DEFAULT_XVFB_SCREEN,
  command = "Xvfb",
  alreadySpawned = false,
  resolveCommand = xvfbCommandPath,
  fileExists = defaultDisplayLockExists,
  min = XVFB_DISPLAY_MIN,
  max = XVFB_DISPLAY_MAX,
} = {}) {
  if (alreadySpawned) {
    return { ok: false, reason: "already-spawned", hint: "This session already started an Xvfb display; stop it before starting another." };
  }

  const detection = detectHeadlessDisplay({ env, platform });
  if (detection.kind !== DISPLAY_HEADLESS && !force) {
    return {
      ok: false,
      reason: "display-present",
      detection,
      hint: `A display is already available (${detection.kind}); refusing to spawn Xvfb. Pass force to override.`,
    };
  }

  const resolved = resolveCommand(command, env);
  if (!resolved) {
    return {
      ok: false,
      reason: "xvfb-missing",
      hint: "Xvfb is not installed or not on PATH. Install it (e.g. `apt-get install xvfb`) before using this.",
    };
  }

  const displayNumber = pickFreeDisplay({ min, max, fileExists });
  if (displayNumber === null) {
    return {
      ok: false,
      reason: "no-free-display",
      hint: `No free X display number in :${min}–:${max}; another process may be holding them all.`,
    };
  }

  return {
    ok: true,
    display: `:${displayNumber}`,
    displayNumber,
    command: resolved,
    args: buildXvfbArgs(displayNumber, { screen }),
    screen,
  };
}

/**
 * Spawn Xvfb per a successful plan and return a handle. The handle exposes the
 * child, the chosen DISPLAY, and an idempotent stop(). This performs real side
 * effects and should only be called after planXvfb() returns ok:true.
 *
 * The caller is responsible for exporting handle.display into the environment
 * it wants DISPLAY-dependent tools to inherit; this function does not mutate a
 * shared process.env unless exportEnv is provided.
 *
 * @param {ReturnType<typeof planXvfb>} plan
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.exportEnv] if provided, sets exportEnv.DISPLAY
 * @param {(command: string, args: string[], opts: object) => import("node:child_process").ChildProcess} [options.spawnImpl]
 * @returns {{ display: string, displayNumber: number, pid: number|undefined, child: import("node:child_process").ChildProcess, stop: (opts?: { forceAfterMs?: number }) => Promise<void> }}
 */
export function spawnXvfb(plan, { exportEnv, spawnImpl = spawn } = {}) {
  if (!plan || plan.ok !== true) {
    throw new Error(`spawnXvfb requires a successful plan (got reason=${plan?.reason ?? "none"})`);
  }
  const child = spawnImpl(plan.command, plan.args, { stdio: "ignore", detached: false });
  if (exportEnv) exportEnv.DISPLAY = plan.display;

  let stopped = false;
  const stop = async ({ forceAfterMs = 2_000 } = {}) => {
    if (stopped) return;
    stopped = true;
    if (exportEnv && exportEnv.DISPLAY === plan.display) delete exportEnv.DISPLAY;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {}
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        done();
      }, forceAfterMs);
      if (typeof timer.unref === "function") timer.unref();
      child.once("exit", done);
    });
  };

  return { display: plan.display, displayNumber: plan.displayNumber, pid: child?.pid, child, stop };
}

/**
 * Human-readable one-liner describing a plan outcome, for tool results.
 *
 * @param {ReturnType<typeof planXvfb>} plan
 * @returns {string}
 */
export function xvfbPlanSummary(plan) {
  if (plan?.ok) return `Xvfb plan: spawn ${plan.command} ${plan.args.join(" ")} (DISPLAY=${plan.display})`;
  return `Xvfb not started (${plan?.reason ?? "unknown"}): ${plan?.hint ?? ""}`.trim();
}
