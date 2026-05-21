import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

import { ToolSchema } from "./lib/tool-schema.js";

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 12_000;
const UPDATE_CWD = homedir();

const PI_RESTART_ENV_FLAG = "PI_RESTARTED_WITHOUT_INITIAL_PROMPT";
const PI_RESTART_SESSION_ENV = "PI_RESTART_SESSION_FILE";
const PI_RESTART_ENTRY_TYPE = "agent-utils.pi-restart";
const PI_RESTART_PREFER_PATH = "pi";

const VALUE_FLAGS = new Set([
  "--mode",
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--models",
  "--tools",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
  "--list-models",
]);

const BOOLEAN_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--no-tools",
  "--print",
  "-p",
  "--no-extensions",
  "-ne",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--verbose",
  "--offline",
]);

const SESSION_VALUE_FLAGS = new Set(["--session", "--fork", "--session-dir"]);
const SESSION_BOOLEAN_FLAGS = new Set(["--continue", "-c", "--resume", "-r", "--no-session"]);

function truncateOutput(text, limit = OUTPUT_LIMIT) {
  const s = String(text || "");
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n\n[truncated ${s.length - limit} chars]`;
}

function parseUpdateArgs(args) {
  const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
  return {
    reload: !tokens.includes("--no-reload") && !tokens.includes("no-reload"),
    help: tokens.includes("--help") || tokens.includes("help") || tokens.includes("-h"),
  };
}

function updateLooksReloadWorthy(result) {
  if (result?.killed) return false;
  if (Number(result?.code || 0) === 0) return true;
  const combined = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  if (/Updated packages/i.test(combined)) return true;
  if (/pi cannot self-update this installation/i.test(combined) && /install path is not writable/i.test(combined)) return true;
  return false;
}

function updateActuallyChangedPackages(result) {
  const combined = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  // `pi update --extensions` always prints "Updated packages" even when
  // nothing changed. Treat the run as a real change only when there is
  // affirmative evidence: a git pull moving HEAD, an npm install line,
  // or an explicit "Updated <source>" line.
  if (/is unchanged and points to/i.test(combined)) return false;
  if (/Already up to date/i.test(combined)) return false;
  if (/No (?:changes|updates)/i.test(combined)) return false;
  if (/Updating .* -> /i.test(combined)) return true;
  if (/Updated (?:npm:|git:)/i.test(combined)) return true;
  if (/installed (?:npm:|git:)/i.test(combined)) return true;
  if (/Fast-forward|files? changed/i.test(combined)) return true;
  return false;
}

function envFlagFalse(value) {
  return /^(0|false|off|no|disabled)$/i.test(String(value || "").trim());
}

function envFlagTrue(value) {
  return /^(1|true|on|yes|enabled|force)$/i.test(String(value || "").trim());
}

function shouldAutoReloadAfterUpdate({ env = process.env, settings = {} } = {}) {
  if (envFlagTrue(env.PI_AUTO_RELOAD_AFTER_UPDATE)) return true;
  if (envFlagFalse(env.PI_AUTO_RELOAD_AFTER_UPDATE)) return false;
  const cfg = settings?.piSelfUpdate ?? settings?.agentUtils?.piSelfUpdate ?? {};
  const value = cfg.autoReloadAfterUpdate;
  if (value === false) return false;
  return value !== undefined ? Boolean(value) : true;
}

function shouldAutoUpdateOnStartup({ env = process.env, settings = {} } = {}) {
  if (envFlagTrue(env.PI_AUTO_UPDATE_ON_STARTUP)) return true;
  if (envFlagFalse(env.PI_AUTO_UPDATE_ON_STARTUP)) return false;
  if (envFlagTrue(env.PI_OFFLINE)) return false;
  const cfg = settings?.piSelfUpdate ?? settings?.agentUtils?.piSelfUpdate ?? {};
  const value = cfg.autoUpdateOnStartup;
  if (value === false) return false;
  return value !== undefined ? Boolean(value) : true;
}

function readAgentSettings(env = process.env) {
  try {
    const dir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const path = join(dir, "settings.json");
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return {}; }
}

function piUpdateExecOptions(signal) {
  return { timeout: UPDATE_TIMEOUT_MS, signal, cwd: UPDATE_CWD };
}

const UPDATE_ARGS = ["update", "--extensions"];
const UPDATE_DISPLAY = "pi update --extensions";

function runPiUpdateWithSpawn(signal) {
  return new Promise((resolve) => {
    const child = spawn("pi", UPDATE_ARGS, { stdio: ["ignore", "pipe", "pipe"], cwd: UPDATE_CWD });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish({ code: null, stdout, stderr: `${stderr}\n${UPDATE_DISPLAY} timed out after ${UPDATE_TIMEOUT_MS}ms`, killed: true });
    }, UPDATE_TIMEOUT_MS);
    signal?.addEventListener?.("abort", () => {
      try { child.kill("SIGTERM"); } catch {}
      finish({ code: null, stdout, stderr: `${stderr}\n${UPDATE_DISPLAY} aborted`, killed: true });
    }, { once: true });
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ code: null, stdout, stderr: `${stderr}\n${error.message}`, killed: false }));
    child.on("close", (code) => finish({ code, stdout, stderr, killed: false }));
  });
}

async function runPiUpdate(pi, signal) {
  if (typeof pi.exec === "function") {
    return pi.exec("pi", UPDATE_ARGS, piUpdateExecOptions(signal));
  }
  return runPiUpdateWithSpawn(signal);
}

function formatUpdateResult(result, { reload, reloadWorthy }) {
  const code = result?.code ?? (result?.killed ? "killed" : "unknown");
  const stdout = truncateOutput(result?.stdout || "").trim();
  const stderr = truncateOutput(result?.stderr || "").trim();
  return [
    `${UPDATE_DISPLAY} exited with code ${code}`,
    reload ? (reloadWorthy ? "reload: requested after package update" : "reload: requested after update attempt") : "reload: skipped (--no-reload)",
    stdout ? `\nstdout:\n${stdout}` : "",
    stderr ? `\nstderr:\n${stderr}` : "",
  ].filter(Boolean).join("\n");
}

function parseReloadToolsArgs(args) {
  const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
  return {
    activateOnly: tokens.includes("--activate"),
    noReload: tokens.includes("--no-reload") || tokens.includes("no-reload"),
    help: tokens.includes("--help") || tokens.includes("help") || tokens.includes("-h"),
  };
}

function parseRestartArgs(args) {
  const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
  return {
    dryRun: tokens.includes("--dry-run") || tokens.includes("dry-run"),
    help: tokens.includes("--help") || tokens.includes("help") || tokens.includes("-h"),
  };
}

function findExecutableOnPath(command, env = process.env) {
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return undefined;
    }
  }
  const pathValue = env.PATH || "";
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

function redactSensitiveArgs(args) {
  const redacted = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--api-key") {
      redacted.push(arg);
      if (i + 1 < args.length) {
        redacted.push("<redacted>");
        i += 1;
      }
      continue;
    }
    if (/^--api-key=/.test(arg)) {
      redacted.push("--api-key=<redacted>");
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}

function stripPromptArgs(rawArgs) {
  const preserved = [];
  const dropped = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--") {
      dropped.push(...rawArgs.slice(i));
      break;
    }
    if (SESSION_VALUE_FLAGS.has(arg)) {
      dropped.push(arg);
      if (i + 1 < rawArgs.length) dropped.push(rawArgs[++i]);
      continue;
    }
    if (SESSION_BOOLEAN_FLAGS.has(arg)) {
      dropped.push(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      preserved.push(arg);
      if (i + 1 < rawArgs.length) preserved.push(rawArgs[++i]);
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      preserved.push(arg);
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      preserved.push(arg);
      continue;
    }
    if (arg.startsWith("--") || arg.startsWith("-")) {
      preserved.push(arg);
      continue;
    }
    dropped.push(arg);
  }
  return { preserved, dropped };
}

export function buildPiRestartPlan({
  argv = process.argv,
  env = process.env,
  sessionFile,
  sessionDir,
  cwd = process.cwd(),
  command = PI_RESTART_PREFER_PATH,
} = {}) {
  if (!sessionFile) {
    throw new Error("/restart requires a persistent session file; current Pi session is ephemeral or not yet persisted");
  }
  const rawArgs = argv.slice(2);
  const { preserved, dropped } = stripPromptArgs(rawArgs);
  const restartArgs = [...preserved];
  if (sessionDir) restartArgs.push("--session-dir", sessionDir);
  restartArgs.push("--session", sessionFile);
  const executable = findExecutableOnPath(command, env) || argv[1] || command;
  const execArgv = [command, ...restartArgs];
  return {
    executable,
    args: execArgv,
    restartArgs,
    droppedArgs: dropped,
    sessionFile,
    sessionDir,
    cwd,
    env: {
      ...env,
      [PI_RESTART_ENV_FLAG]: "1",
      [PI_RESTART_SESSION_ENV]: sessionFile,
    },
  };
}

export function executePiRestartPlan(plan, { execve = process.execve, spawnImpl = spawn, exit = process.exit } = {}) {
  if (typeof execve === "function") {
    execve(plan.executable, plan.args, plan.env);
    return { method: "execve" };
  }
  const child = spawnImpl(plan.executable, plan.args.slice(1), {
    cwd: plan.cwd,
    env: plan.env,
    stdio: "inherit",
  });
  child.on?.("exit", (code, signal) => {
    if (signal) exit(128);
    exit(typeof code === "number" ? code : 0);
  });
  child.on?.("error", () => exit(1));
  return { method: "spawn" };
}

function formatRestartPlan(plan) {
  const displayArgs = redactSensitiveArgs(plan.args).map((arg) => JSON.stringify(arg)).join(" ");
  return [
    `restart executable: ${plan.executable}`,
    `restart argv: ${displayArgs}`,
    `session: ${plan.sessionFile}`,
    plan.droppedArgs.length > 0
      ? `suppressed startup prompt/file args: ${plan.droppedArgs.length}`
      : "suppressed startup prompt/file args: 0",
  ].join("\n");
}

function getToolNames(pi) {
  if (typeof pi.getAllTools !== "function") return [];
  return pi.getAllTools()
    .map((tool) => typeof tool === "string" ? tool : tool?.name)
    .filter((name) => typeof name === "string" && name.length > 0);
}

function activateAllTools(pi) {
  if (typeof pi.setActiveTools !== "function") {
    return { ok: false, reason: "pi.setActiveTools is not available in this runtime", count: 0, names: [], refreshed: false, activeCount: null };
  }
  let refreshed = false;
  if (typeof pi.refreshTools === "function") {
    pi.refreshTools();
    refreshed = true;
  }
  const names = [...new Set(getToolNames(pi))];
  pi.setActiveTools(names);
  const activeNames = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : null;
  return { ok: true, count: names.length, names, refreshed, activeCount: Array.isArray(activeNames) ? activeNames.length : null };
}

function queueFollowUpCommand(pi, queuedFollowUps, command) {
  if (queuedFollowUps.has(command)) return { queued: false, duplicate: true, command };
  queuedFollowUps.add(command);
  pi.sendUserMessage?.(command, { deliverAs: "followUp", streamingBehavior: "followUp" });
  return { queued: true, duplicate: false, command };
}

function clearQueuedFollowUp(queuedFollowUps, command) {
  queuedFollowUps.delete(command);
}

function queueReloadToolsActivate(pi, queuedFollowUps) {
  return queueFollowUpCommand(pi, queuedFollowUps, "/reload-tools --activate");
}

export default async function piSelfUpdateExtension(pi) {
  let updateRunning = false;
  let autoUpdateStarted = false;
  const queuedFollowUps = new Set();

  async function runAutoUpdateBlocking() {
    if (autoUpdateStarted) return null;
    autoUpdateStarted = true;
    if (!shouldAutoUpdateOnStartup({ env: process.env, settings: readAgentSettings() })) return null;
    updateRunning = true;
    try {
      const result = await runPiUpdate(pi);
      return result;
    } catch {
      return null;
    } finally {
      updateRunning = false;
    }
  }

  // Block extension load on pi update --extensions so Pi's own package-update
  // banner does not flash before we have actually pulled. The factory promise
  // resolves before pi continues startup and runs its checkForPackageUpdates.
  let blockingUpdatePromise = null;
  if (shouldAutoUpdateOnStartup({ env: process.env, settings: readAgentSettings() })) {
    blockingUpdatePromise = runAutoUpdateBlocking();
  }

  async function maybeReloadAfterStartupUpdate(ctx) {
    if (!blockingUpdatePromise) return;
    const result = await blockingUpdatePromise.catch(() => null);
    blockingUpdatePromise = null;
    if (!result) return;
    const reloadWorthy = updateLooksReloadWorthy(result);
    const changed = updateActuallyChangedPackages(result);
    if (!(reloadWorthy && changed)) return;
    const autoReload = shouldAutoReloadAfterUpdate({ env: process.env, settings: readAgentSettings() });
    if (autoReload && typeof ctx?.reload === "function") {
      try { await ctx.reload(); } catch {}
      try { activateAllTools(pi); } catch {}
      return;
    }
    try {
      ctx?.ui?.notify?.(
        "pi extension auto-update installed new packages. Run /reload (or /reload-tools) to activate the updated extensions in this session.",
        "info",
      );
    } catch {}
  }

  pi.on?.("session_start", async (_event, ctx) => {
    // Reuse the blocking update result if it ran during extension load;
    // otherwise no-op.
    maybeReloadAfterStartupUpdate(ctx);
  });

  pi.registerCommand("update", {
    description: "Run `pi update --extensions`, then reload extensions/resources and refresh active tools. Use /update --no-reload to skip reload.",
    handler: async (args, ctx) => {
      const options = parseUpdateArgs(args);
      if (options.help) {
        ctx.ui.notify("Usage: /update [--no-reload] — run pi update --extensions, then reload and refresh active tools.", "info");
        return;
      }
      if (updateRunning && blockingUpdatePromise) {
        ctx.ui.notify("Background pi update --extensions is already running; awaiting it...", "info");
        const bgResult = await blockingUpdatePromise.catch(() => null);
        blockingUpdatePromise = null;
        const ok = bgResult && Number(bgResult.code || 0) === 0 && !bgResult.killed;
        const reloadWorthy = updateLooksReloadWorthy(bgResult || {});
        if (bgResult) ctx.ui.notify(formatUpdateResult(bgResult, { ...options, reloadWorthy }), ok || reloadWorthy ? "info" : "error");
        if (options.reload) {
          queueReloadToolsActivate(pi, queuedFollowUps);
          ctx.ui.notify("Reloading Pi runtime and refreshing tools after background update...", "info");
          await ctx.reload();
        }
        return;
      }
      if (updateRunning) {
        ctx.ui.notify("pi extension update is already running in this session", "warning");
        return;
      }
      updateRunning = true;
      try {
        ctx.ui.notify("Running pi update --extensions from home directory...", "info");
        const result = await runPiUpdate(pi);
        const ok = Number(result?.code || 0) === 0 && !result?.killed;
        const reloadWorthy = updateLooksReloadWorthy(result);
        ctx.ui.notify(formatUpdateResult(result, { ...options, reloadWorthy }), ok || reloadWorthy ? "info" : "error");
        if (options.reload) {
          queueReloadToolsActivate(pi, queuedFollowUps);
          ctx.ui.notify(reloadWorthy
            ? "pi extension update completed package work; reloading Pi runtime and refreshing tools..."
            : "pi extension update did not report package success, but /update reloads after attempts; reloading Pi runtime and refreshing tools...", "info");
          await ctx.reload();
          return;
        }
      } catch (error) {
        ctx.ui.notify(`${UPDATE_DISPLAY} failed: ${error.message || String(error)}`, "error");
      } finally {
        updateRunning = false;
      }
    },
  });

  pi.registerCommand("reload-tools", {
    description: "Reload Pi extensions/resources, then activate every registered tool so newly loaded tools are model-visible.",
    handler: async (args, ctx) => {
      const options = parseReloadToolsArgs(args);
      if (options.help) {
        ctx.ui.notify("Usage: /reload-tools [--no-reload] — reload extensions, then activate all registered tools. Internal: /reload-tools --activate", "info");
        return;
      }
      clearQueuedFollowUp(queuedFollowUps, "/reload-tools");
      clearQueuedFollowUp(queuedFollowUps, "/reload-tools --activate");
      if (options.activateOnly || options.noReload || typeof ctx.reload !== "function") {
        const result = activateAllTools(pi);
        if (result.ok) {
          ctx.ui.notify(`Activated ${result.count} registered tools for future agent turns${result.refreshed ? " after refreshing the tool registry" : ""}${result.activeCount === null ? "" : ` (active:${result.activeCount})`}.`, "info");
        } else {
          ctx.ui.notify(`Could not refresh active tools: ${result.reason}`, "warning");
        }
        return;
      }
      const queued = queueReloadToolsActivate(pi, queuedFollowUps);
      ctx.ui.notify(queued.duplicate
        ? "Reloading Pi runtime; tool activation is already queued after reload..."
        : "Reloading Pi runtime; refreshed tools will be activated immediately after reload...", "info");
      await ctx.reload();
    },
  });

  pi.registerCommand("restart", {
    description: "Re-exec the current Pi process against the same session, preserving runtime flags but suppressing initial prompt/file arguments.",
    handler: async (args, ctx) => {
      const options = parseRestartArgs(args);
      if (options.help) {
        ctx.ui.notify("Usage: /restart [--dry-run] — re-exec Pi with the current session via --session, omitting initial prompt and @file args so startup instructions are not replayed.", "info");
        return;
      }
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      const sessionDir = ctx.sessionManager?.getSessionDir?.();
      let plan;
      try {
        plan = buildPiRestartPlan({ sessionFile, sessionDir, cwd: ctx.cwd });
      } catch (error) {
        ctx.ui.notify(error.message || String(error), "error");
        return;
      }
      if (options.dryRun) {
        ctx.ui.notify(formatRestartPlan(plan), "info");
        return;
      }
      await ctx.waitForIdle?.();
      pi.appendEntry?.(PI_RESTART_ENTRY_TYPE, {
        at: new Date().toISOString(),
        executable: plan.executable,
        args: redactSensitiveArgs(plan.args),
        sessionFile: plan.sessionFile,
        sessionDir: plan.sessionDir,
        droppedArgCount: plan.droppedArgs.length,
      });
      ctx.ui.notify("Restarting Pi process with the current session; startup prompt/file args are suppressed.", "info");
      executePiRestartPlan(plan);
    },
  });

  if (typeof pi.registerTool === "function") {
    pi.registerTool({
      name: "pi_self_update",
      label: "Pi Self Update",
      description: "Run `pi update --extensions`, then queue /reload-tools so updated packages and tools are loaded in the current Pi session.",
      promptSnippet: "Run a Pi extension/package update and queue a reload-tools pass when newly landed extension/tool changes are needed in the running session.",
      promptGuidelines: ["Use pi_self_update when the user asks to update Pi packages or when a newly landed agent-utils extension/tool needs to appear in the current Pi session."],
      parameters: ToolSchema.object({
        skipReload: ToolSchema.optional(ToolSchema.boolean({ description: "Run pi update --extensions without queueing /reload-tools afterward." })),
        dryRun: ToolSchema.optional(ToolSchema.boolean({ description: "Only report what would run; do not run pi update --extensions or queue a reload." })),
      }),
      async execute(_toolCallId, params = {}) {
        const reloadCommand = params.skipReload ? null : "/reload-tools";
        if (params.dryRun) {
          return { content: [{ type: "text", text: `Would run ${UPDATE_DISPLAY} from ${UPDATE_CWD}${reloadCommand ? ` and queue ${reloadCommand}` : " without reload"}.` }], details: { reloadCommand, queued: false, cwd: UPDATE_CWD, updateArgs: UPDATE_ARGS } };
        }
        const result = await runPiUpdate(pi);
        const reloadWorthy = updateLooksReloadWorthy(result);
        const queued = reloadCommand ? queueFollowUpCommand(pi, queuedFollowUps, reloadCommand) : { queued: false, duplicate: false };
        return {
          content: [{ type: "text", text: `${formatUpdateResult(result, { reload: !params.skipReload, reloadWorthy })}\n\n${reloadCommand ? (queued.duplicate ? `${reloadCommand} is already queued; not adding a duplicate.` : `Queued ${reloadCommand} as a follow-up command.`) : "Reload skipped."}` }],
          details: { reloadCommand, queued: queued.queued, duplicate: queued.duplicate, updateExitCode: result?.code ?? null, reloadWorthy, cwd: UPDATE_CWD, updateArgs: UPDATE_ARGS },
        };
      },
    });

    pi.registerTool({
      name: "pi_reload_tools",
      label: "Pi Reload Tools",
      description: "Activate every registered Pi tool inline so newly added tools become model-visible without queueing a slash command for the user.",
      promptSnippet: "Refresh the active Pi tool list inline when newly updated extension tools are not visible yet.",
      promptGuidelines: ["Use pi_reload_tools when newly added Pi tools should become model-visible immediately, without sending a /reload-tools user message back to the agent."],
      parameters: ToolSchema.object({
        dryRun: ToolSchema.optional(ToolSchema.boolean({ description: "Only report the command that would be queued; do not queue it." })),
      }),
      async execute(_toolCallId, params = {}) {
        const reloadCommand = "/reload-tools";
        if (params.dryRun) {
          return {
            content: [{ type: "text", text: `Would activate registered tools (equivalent to ${reloadCommand} --activate).` }],
            details: { reloadCommand, queued: false, dryRun: true },
          };
        }
        const result = activateAllTools(pi);
        const text = result.ok
          ? `Activated ${result.count} registered tools for future agent turns${result.refreshed ? " after refreshing the tool registry" : ""}${result.activeCount === null ? "" : ` (active:${result.activeCount})`}.`
          : `Could not refresh active tools: ${result.reason}`;
        return {
          content: [{ type: "text", text }],
          details: { reloadCommand, queued: false, activated: result.ok, count: result.count, refreshed: result.refreshed, activeCount: result.activeCount },
        };
      },
    });

    pi.registerTool({
      name: "pi_restart",
      label: "Pi Restart",
      description: "Queue /restart so Pi re-execs the current process against the current session while suppressing initial prompt/file arguments.",
      promptSnippet: "Queue a Pi process restart when a full re-exec is needed to pick up newly installed runtime/tool injections without replaying startup prompts.",
      promptGuidelines: ["Use pi_restart when /reload-tools is insufficient and the user wants the current Pi session re-execed in place."],
      parameters: ToolSchema.object({
        dryRun: ToolSchema.optional(ToolSchema.boolean({ description: "Queue /restart --dry-run instead of restarting." })),
      }),
      async execute(_toolCallId, params = {}) {
        const restartCommand = params.dryRun ? "/restart --dry-run" : "/restart";
        queueFollowUpCommand(pi, queuedFollowUps, restartCommand);
        return {
          content: [{ type: "text", text: `Queued ${restartCommand} as a follow-up command.` }],
          details: { restartCommand, queued: true },
        };
      },
    });
  }
}
