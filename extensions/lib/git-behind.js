// Generic checkout-behind-default-branch warning logic (bd-27072e).
//
// Cacophony's git-check mixin used to PostToolUse-nudge a managed agent when its
// checkout fell behind main; that nudge was effectively lost when managed Pi
// moved to the pi-home-override path. This module is the GENERIC, reusable
// replacement: it lets ANY Pi agent be warned when its checkout is significantly
// behind the origin default branch, decoupled from daemon-checkout specifics.
//
// Design constraints (from the bead):
//   - Configurable: behind-threshold N, default-branch auto-detect (via
//     origin/HEAD) or explicit override, remote, enable/disable, cadence.
//   - ASYNC + THROTTLED, not per-message: turn-cadence (every N turns) and/or
//     git-tool-triggered (the "pre-git hook" idea). Never blocks a tool call.
//   - Fetch CACHED so back-to-back git calls don't each fetch.
//   - Check = fetch origin default + `git rev-list --count HEAD..origin/<def>`,
//     warn when behind >= threshold with a rebase nudge.
//   - Graceful no-op on fetch-fail / detached-HEAD / non-git.
//   - Advisory warning, not a hard error.
//
// Everything here is pure over injected probes (env, settings, and an injected
// `runGit(args)` runner) so it is unit-testable without a real repository or
// network. Only makeGitRunner() performs real side effects.

import { execFile } from "node:child_process";

export const DEFAULT_THRESHOLD = 25;
export const DEFAULT_REMOTE = "origin";
export const DEFAULT_EVERY_TURNS = 10;
export const DEFAULT_COOLDOWN_MS = 10 * 60_000; // 10 minutes between active nudges
export const DEFAULT_FETCH_CACHE_MS = 3 * 60_000; // don't re-fetch within 3 minutes

export const ENV = {
  enabled: "AGENT_UTILS_GIT_BEHIND_WARNING",
  threshold: "AGENT_UTILS_GIT_BEHIND_THRESHOLD",
  branch: "AGENT_UTILS_GIT_BEHIND_BRANCH",
  remote: "AGENT_UTILS_GIT_BEHIND_REMOTE",
  everyTurns: "AGENT_UTILS_GIT_BEHIND_EVERY_TURNS",
  cooldownMs: "AGENT_UTILS_GIT_BEHIND_COOLDOWN_MS",
  fetchCacheMs: "AGENT_UTILS_GIT_BEHIND_FETCH_CACHE_MS",
  nudge: "AGENT_UTILS_GIT_BEHIND_NUDGE",
};

const FALSE_RE = /^(0|false|off|no|disabled)$/i;
const TRUE_RE = /^(1|true|on|yes|enabled)$/i;

export const CUSTOM_TYPE = "agent-utils.git-behind-warning";

/**
 * Parse a boolean-ish env/setting value. Returns fallback when undefined/blank
 * or unrecognized.
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function parseBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim();
  if (!text) return fallback;
  if (TRUE_RE.test(text)) return true;
  if (FALSE_RE.test(text)) return false;
  return fallback;
}

/**
 * Parse a positive integer (>= min). Returns fallback when invalid.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} [min]
 * @returns {number}
 */
export function parsePositiveInt(value, fallback, min = 1) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return fallback;
  return i;
}

function normalizeString(value) {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

/**
 * Extract the git-behind settings slice from a full settings.json object.
 * Honors `agentUtils.gitBehindWarning`.
 * @param {object} [settings]
 * @returns {object}
 */
export function extractGitBehindSettings(settings = {}) {
  const agentUtils = settings?.agentUtils || {};
  return agentUtils.gitBehindWarning || agentUtils.gitBehind || {};
}

/**
 * Resolve effective config from env (highest precedence), a settings slice, and
 * built-in defaults. Pure.
 *
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {object} [options.settings] the agentUtils.gitBehindWarning slice
 * @returns {{enabled:boolean, threshold:number, defaultBranch:(string|undefined), remote:string, everyTurns:number, cooldownMs:number, fetchCacheMs:number, nudge:boolean}}
 */
export function resolveConfig({ env = {}, settings = {} } = {}) {
  const pick = (envName, settingKey) => {
    const e = env[envName];
    if (e !== undefined && e !== "") return e;
    return settings[settingKey];
  };

  const enabled = parseBool(pick(ENV.enabled, "enabled"), settings.enabled === undefined ? true : parseBool(settings.enabled, true));
  const threshold = parsePositiveInt(pick(ENV.threshold, "threshold"), DEFAULT_THRESHOLD, 1);
  const defaultBranch = normalizeString(pick(ENV.branch, "defaultBranch") ?? settings.branch);
  const remote = normalizeString(pick(ENV.remote, "remote")) || DEFAULT_REMOTE;
  const everyTurns = parsePositiveInt(pick(ENV.everyTurns, "everyTurns"), DEFAULT_EVERY_TURNS, 1);
  const cooldownMs = parsePositiveInt(pick(ENV.cooldownMs, "cooldownMs"), DEFAULT_COOLDOWN_MS, 0);
  const fetchCacheMs = parsePositiveInt(pick(ENV.fetchCacheMs, "fetchCacheMs"), DEFAULT_FETCH_CACHE_MS, 0);
  const nudge = parseBool(pick(ENV.nudge, "nudge"), true);

  return { enabled, threshold, defaultBranch, remote, everyTurns, cooldownMs, fetchCacheMs, nudge };
}

/**
 * Fresh mutable runtime/throttle state. One per session.
 */
export function createRuntimeState() {
  return {
    lastFetchAt: null,
    lastWarnAt: null,
    lastCheckedAt: null,
    lastBehind: null,
    lastBranch: null,
    turnsSinceCheck: 0,
    inFlight: false,
  };
}

/**
 * Heuristic: does this bash command invoke git? Loose on purpose — a false
 * positive only triggers a cheap, throttled, cached no-op check; turn cadence
 * still covers any false negative. Avoids matching substrings like "digit" or
 * "legitimate" by anchoring `git` at a command position.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isGitCommand(command) {
  const text = String(command ?? "");
  if (!text) return false;
  return /(?:^|[\s;&|(){}`]|&&|\|\|)(?:sudo\s+)?git(?:\s|$)/.test(text);
}

/**
 * Strip a remote prefix from a ref. Handles both fully-qualified
 * `refs/remotes/<remote>/<branch>` and abbreviated `<remote>/<branch>` forms.
 * @param {string} ref
 * @param {string} remote
 * @returns {string|undefined}
 */
export function stripRemotePrefix(ref, remote) {
  const text = String(ref ?? "").trim();
  if (!text) return undefined;
  const full = `refs/remotes/${remote}/`;
  if (text.startsWith(full)) return text.slice(full.length) || undefined;
  const abbrev = `${remote}/`;
  if (text.startsWith(abbrev)) return text.slice(abbrev.length) || undefined;
  return undefined;
}

/**
 * Parse the integer behind-count from `git rev-list --count` stdout.
 * @param {string} stdout
 * @returns {number|null}
 */
export function parseBehindCount(stdout) {
  const text = String(stdout ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

/**
 * Should we fetch now, or is the cached remote-tracking ref still fresh?
 * @param {number} now
 * @param {number|null} lastFetchAt
 * @param {number} fetchCacheMs
 * @returns {boolean}
 */
export function decideFetch(now, lastFetchAt, fetchCacheMs) {
  if (lastFetchAt === null || lastFetchAt === undefined) return true;
  return now - lastFetchAt >= fetchCacheMs;
}

/**
 * Should we surface an active warning now, or is the cooldown still in effect?
 * @param {number} now
 * @param {number|null} lastWarnAt
 * @param {number} cooldownMs
 * @returns {boolean}
 */
export function decideWarn(now, lastWarnAt, cooldownMs) {
  if (lastWarnAt === null || lastWarnAt === undefined) return true;
  return now - lastWarnAt >= cooldownMs;
}

/**
 * Should the turn-cadence trigger fire on this turn?
 * @param {number} turnsSinceCheck
 * @param {number} everyTurns
 * @returns {boolean}
 */
export function decideTurnTrigger(turnsSinceCheck, everyTurns) {
  return turnsSinceCheck >= everyTurns;
}

/**
 * Resolve the remote's default branch. Honors an explicit override; otherwise
 * auto-detects via origin/HEAD (symbolic-ref, then abbrev-ref), then falls back
 * to probing common names (main, master). Pure over the injected runGit.
 *
 * @param {object} options
 * @param {(args:string[], opts?:object)=>Promise<{code:number, stdout:string, stderr:string}>} options.runGit
 * @param {string} options.remote
 * @param {string} [options.override]
 * @returns {Promise<{branch:string, source:string}|null>}
 */
export async function resolveDefaultBranch({ runGit, remote, override }) {
  const ov = normalizeString(override);
  if (ov) return { branch: ov, source: "override" };

  // origin/HEAD as a symbolic ref -> refs/remotes/origin/<branch>
  const sym = await runGit(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  if (sym.code === 0) {
    const branch = stripRemotePrefix(sym.stdout.trim(), remote);
    if (branch) return { branch, source: "symbolic-ref" };
  }

  // abbrev-ref fallback -> <remote>/<branch>
  const abbrev = await runGit(["rev-parse", "--abbrev-ref", `${remote}/HEAD`]);
  if (abbrev.code === 0) {
    const branch = stripRemotePrefix(abbrev.stdout.trim(), remote);
    if (branch) return { branch, source: "abbrev-ref" };
  }

  // probe common defaults via existing remote-tracking refs (no network)
  for (const candidate of ["main", "master"]) {
    const ref = await runGit(["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${candidate}`]);
    if (ref.code === 0) return { branch: candidate, source: "probe" };
  }

  return null;
}

/**
 * Format the advisory warning text (generic git + optional managed-checkout
 * hint). Advisory only — never a hard error.
 * @param {{behind:number, remote:string, branch:string, threshold:number}} result
 * @returns {string}
 */
export function formatWarning(result) {
  const { behind, remote, branch } = result;
  const target = `${remote}/${branch}`;
  return [
    `Checkout is ${behind} commit${behind === 1 ? "" : "s"} behind ${target}.`,
    `Consider rebasing soon to avoid drift: \`git fetch ${remote} && git rebase ${target}\``,
    `(in a managed Cacophony checkout, prefer \`caco agent rebase --id "$CACO_AGENT_ID"\`).`,
    `This is an advisory nudge, not a blocker.`,
  ].join(" ");
}

/**
 * Run one full behind-check. Mostly pure: side effects are confined to the
 * injected runGit and to mutating the passed runtime `state` timestamps/cache.
 * Returns a discriminated result; the caller decides how to surface it.
 *
 * Statuses: "disabled", "not-a-git-repo", "detached-head", "no-default-branch",
 * "no-upstream", "ok".
 *
 * @param {object} options
 * @param {(args:string[], opts?:object)=>Promise<{code:number, stdout:string, stderr:string}>} options.runGit
 * @param {ReturnType<typeof resolveConfig>} options.config
 * @param {ReturnType<typeof createRuntimeState>} options.state
 * @param {number} [options.now]
 * @returns {Promise<object>}
 */
export async function runGitBehindCheck({ runGit, config, state, now = Date.now() }) {
  if (!config.enabled) return { status: "disabled" };

  const inside = await runGit(["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { status: "not-a-git-repo" };
  }

  // Detached HEAD: a rebase nudge does not apply to a non-branch checkout.
  const head = await runGit(["symbolic-ref", "--quiet", "HEAD"]);
  if (head.code !== 0) return { status: "detached-head" };

  const branchInfo = await resolveDefaultBranch({ runGit, remote: config.remote, override: config.defaultBranch });
  if (!branchInfo) return { status: "no-default-branch", remote: config.remote };
  const branch = branchInfo.branch;

  // Fetch is cached so back-to-back git calls don't each hit the network.
  let fetched = false;
  let fetchFailed = false;
  if (decideFetch(now, state.lastFetchAt, config.fetchCacheMs)) {
    const f = await runGit(["fetch", "--quiet", config.remote, branch], { timeoutMs: 20_000 });
    if (f.code === 0) {
      fetched = true;
      state.lastFetchAt = now;
    } else {
      // Graceful: fall back to the cached remote-tracking ref if any.
      fetchFailed = true;
    }
  }

  const rl = await runGit(["rev-list", "--count", `HEAD..${config.remote}/${branch}`]);
  const behind = parseBehindCount(rl.stdout);
  if (behind === null) {
    return { status: "no-upstream", branch, remote: config.remote, fetched, fetchFailed };
  }

  state.lastBehind = behind;
  state.lastBranch = branch;
  state.lastCheckedAt = now;

  const overThreshold = behind >= config.threshold;
  const warn = overThreshold && decideWarn(now, state.lastWarnAt, config.cooldownMs);
  if (warn) state.lastWarnAt = now;

  return {
    status: "ok",
    behind,
    branch,
    remote: config.remote,
    threshold: config.threshold,
    branchSource: branchInfo.source,
    fetched,
    fetchFailed,
    overThreshold,
    warn,
  };
}

/**
 * Build a real git runner bound to a working directory. The returned function
 * never throws: it resolves with the exit code, stdout, and stderr so callers
 * can branch on status without try/catch. ENOENT (git missing) maps to 127.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {typeof execFile} [options.execImpl]
 * @returns {(args:string[], opts?:{timeoutMs?:number})=>Promise<{code:number, stdout:string, stderr:string}>}
 */
export function makeGitRunner({ cwd = process.cwd(), execImpl = execFile } = {}) {
  return (args, { timeoutMs = 5_000 } = {}) =>
    new Promise((resolve) => {
      execImpl(
        "git",
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === "number" ? error.code : 127;
            resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? error.message ?? "") });
            return;
          }
          resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
}

/**
 * One-line human summary of a check result, for /git-behind status and logs.
 * @param {object} result
 * @returns {string}
 */
export function summarizeResult(result) {
  if (!result) return "no check has run yet";
  switch (result.status) {
    case "disabled":
      return "disabled";
    case "not-a-git-repo":
      return "not a git repository (no-op)";
    case "detached-head":
      return "detached HEAD (no-op)";
    case "no-default-branch":
      return `could not resolve ${result.remote}'s default branch (no-op)`;
    case "no-upstream":
      return `no upstream ${result.remote}/${result.branch} tracking ref (no-op)`;
    case "ok":
      return result.overThreshold
        ? `behind ${result.behind} of ${result.remote}/${result.branch} (>= threshold)`
        : `up to date enough: ${result.behind} behind ${result.remote}/${result.branch}`;
    default:
      return String(result.status || "unknown");
  }
}
