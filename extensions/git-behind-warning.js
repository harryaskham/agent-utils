// Pi extension: warn when this checkout is significantly behind its origin
// default branch (bd-27072e).
//
// Generic, reusable replacement for Cacophony's lost git-check mixin. It warns
// ANY Pi agent — managed or not — when its checkout falls behind the origin
// default branch, so the agent can rebase before drift causes painful conflicts.
//
// Triggers (both async, throttled, never blocking):
//   - tool_call on a bash `git ...` command (the "pre-git hook" idea)
//   - turn_end cadence (every N turns)
//
// All the policy/throttle/parse logic lives in ./lib/git-behind.js and is pure
// over injected probes; this file is the thin event + command + surfacing layer.
// The check runs fire-and-forget so it never delays a tool call, fetches are
// cached, warnings are cooldown-throttled, and every failure path is a graceful
// no-op (advisory only).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  CUSTOM_TYPE,
  createRuntimeState,
  decideTurnTrigger,
  extractGitBehindSettings,
  formatWarning,
  isGitCommand,
  makeGitRunner,
  resolveConfig,
  runGitBehindCheck,
  summarizeResult,
} from "./lib/git-behind.js";

const STATUS_KEY = "git-behind";

function expandHome(path) {
  const text = String(path || "");
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  return text;
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Merge agentUtils.gitBehindWarning from global (~/.pi/agent) then project
// (.pi) settings.json, project overriding global. Mirrors the discovery
// convention used by true-defaults.js.
function loadSettingsSlice({ env = process.env, cwd = process.cwd() } = {}) {
  const globalPath = join(expandHome(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")), "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  const merged = {};
  for (const path of [globalPath, projectPath]) {
    const slice = extractGitBehindSettings(readJson(path) || {});
    if (slice && typeof slice === "object") Object.assign(merged, slice);
  }
  return merged;
}

function resolveEffectiveConfig({ env = process.env, cwd = process.cwd() } = {}) {
  return resolveConfig({ env, settings: loadSettingsSlice({ env, cwd }) });
}

function formatConfig(config) {
  return [
    `enabled=${config.enabled}`,
    `threshold=${config.threshold}`,
    `branch=${config.defaultBranch || "auto-detect"}`,
    `remote=${config.remote}`,
    `everyTurns=${config.everyTurns}`,
    `cooldownMs=${config.cooldownMs}`,
    `fetchCacheMs=${config.fetchCacheMs}`,
    `nudge=${config.nudge}`,
  ].join(" ");
}

export default function gitBehindWarningExtension(pi, options = {}) {
  const state = {
    config: options.config || resolveEffectiveConfig(),
    runtime: createRuntimeState(),
    lastResult: null,
    // Tests may inject a fake runGit to avoid touching a real repo/network.
    runGit: options.runGit || null,
  };

  function getRunner(ctx) {
    return state.runGit || makeGitRunner({ cwd: ctx?.cwd || process.cwd() });
  }

  function updateStatusLine(ctx, result) {
    if (!ctx?.ui?.setStatus) return;
    if (result?.status === "ok" && result.overThreshold) {
      ctx.ui.setStatus(STATUS_KEY, `⚠ ${result.behind} behind ${result.remote}/${result.branch}`);
    } else {
      // Clear the indicator when up to date or on any no-op status.
      ctx.ui.setStatus(STATUS_KEY, "");
    }
  }

  function surface(ctx, result) {
    updateStatusLine(ctx, result);
    if (result?.status !== "ok" || !result.warn) return;
    const message = formatWarning(result);
    try {
      ctx?.ui?.notify?.(message, "warning");
    } catch {}
    if (state.config.nudge) {
      try {
        pi.sendMessage?.(
          {
            customType: CUSTOM_TYPE,
            content: message,
            display: true,
            details: { behind: result.behind, branch: result.branch, remote: result.remote, threshold: result.threshold },
          },
          { deliverAs: "followUp" },
        );
      } catch {}
    }
  }

  // Run one check now, awaiting the result. Used by the command surface.
  async function runCheckNow(ctx) {
    if (state.runtime.inFlight) return state.lastResult;
    state.runtime.inFlight = true;
    try {
      const runGit = getRunner(ctx);
      const result = await runGitBehindCheck({ runGit, config: state.config, state: state.runtime, now: Date.now() });
      state.lastResult = result;
      surface(ctx, result);
      return result;
    } catch {
      // Advisory must never break the session.
      return state.lastResult;
    } finally {
      state.runtime.inFlight = false;
    }
  }

  // Fire-and-forget variant for event triggers so a tool call is never delayed.
  function scheduleCheck(ctx) {
    if (!state.config.enabled || state.runtime.inFlight) return;
    void runCheckNow(ctx);
  }

  pi.on?.("tool_call", (event, ctx) => {
    if (!state.config.enabled) return;
    if (event?.toolName !== "bash") return;
    if (!isGitCommand(event?.input?.command)) return;
    scheduleCheck(ctx);
    // Never block: no return value.
  });

  pi.on?.("turn_end", (_event, ctx) => {
    state.runtime.turnsSinceCheck += 1;
    if (!state.config.enabled) return;
    if (!decideTurnTrigger(state.runtime.turnsSinceCheck, state.config.everyTurns)) return;
    state.runtime.turnsSinceCheck = 0;
    scheduleCheck(ctx);
  });

  pi.on?.("session_start", (_event, ctx) => {
    // Re-resolve config at session start so settings.json edits are picked up,
    // and clear any stale status indicator from a previous session.
    state.config = resolveEffectiveConfig({ cwd: ctx?.cwd || process.cwd() });
    ctx?.ui?.setStatus?.(STATUS_KEY, "");
  });

  pi.on?.("session_shutdown", (_event, ctx) => {
    ctx?.ui?.setStatus?.(STATUS_KEY, "");
  });

  pi.registerCommand?.("git-behind", {
    description: "Warn when this checkout is behind its origin default branch (status | check | on | off | reload).",
    handler: async (args, ctx) => {
      const token = String(args || "").trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() || "status";
      const notify = (msg, level = "info") => ctx?.ui?.notify?.(msg, level);

      if (token === "help" || token === "--help") {
        notify(
          "Usage: /git-behind [status|check|on|off|reload]. Configure via env AGENT_UTILS_GIT_BEHIND_* or settings.json agentUtils.gitBehindWarning.",
          "info",
        );
        return;
      }

      if (token === "on" || token === "off") {
        state.config.enabled = token === "on";
        if (!state.config.enabled) ctx?.ui?.setStatus?.(STATUS_KEY, "");
        notify(`git-behind ${state.config.enabled ? "enabled" : "disabled"} (runtime override).`, "info");
        return;
      }

      if (token === "reload") {
        state.config = resolveEffectiveConfig({ cwd: ctx?.cwd || process.cwd() });
        notify(`git-behind config reloaded: ${formatConfig(state.config)}`, "info");
        return;
      }

      if (token === "check") {
        const result = await runCheckNow(ctx);
        notify(`git-behind check: ${summarizeResult(result)}`, result?.overThreshold ? "warning" : "info");
        return;
      }

      if (token !== "status") {
        notify("Usage: /git-behind [status|check|on|off|reload]", "warning");
        return;
      }

      notify(
        [
          `git-behind: ${formatConfig(state.config)}`,
          `last check: ${summarizeResult(state.lastResult)}`,
        ].join("\n"),
        "info",
      );
    },
  });
}

export const __gitBehindTest = { loadSettingsSlice, resolveEffectiveConfig, formatConfig };
