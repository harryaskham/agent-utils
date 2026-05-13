import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { ToolSchema } from "./lib/tool-schema.js";

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 12_000;
const UPDATE_CWD = homedir();

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

function getToolNames(pi) {
  if (typeof pi.getAllTools !== "function") return [];
  return pi.getAllTools()
    .map((tool) => typeof tool === "string" ? tool : tool?.name)
    .filter((name) => typeof name === "string" && name.length > 0);
}

function activateAllTools(pi) {
  if (typeof pi.setActiveTools !== "function") {
    return { ok: false, reason: "pi.setActiveTools is not available in this runtime", count: 0, names: [] };
  }
  const names = [...new Set(getToolNames(pi))];
  pi.setActiveTools(names);
  return { ok: true, count: names.length, names };
}

function queueReloadToolsActivate(pi) {
  pi.sendUserMessage?.("/reload-tools --activate", { deliverAs: "followUp" });
}

export default function piSelfUpdateExtension(pi) {
  let updateRunning = false;

  pi.registerCommand("update", {
    description: "Run `pi update --extensions`, then reload extensions/resources and refresh active tools. Use /update --no-reload to skip reload.",
    handler: async (args, ctx) => {
      const options = parseUpdateArgs(args);
      if (options.help) {
        ctx.ui.notify("Usage: /update [--no-reload] — run pi update --extensions, then reload and refresh active tools.", "info");
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
          queueReloadToolsActivate(pi);
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
      if (options.activateOnly || options.noReload || typeof ctx.reload !== "function") {
        const result = activateAllTools(pi);
        if (result.ok) {
          ctx.ui.notify(`Activated ${result.count} registered tools for future agent turns.`, "info");
        } else {
          ctx.ui.notify(`Could not refresh active tools: ${result.reason}`, "warning");
        }
        return;
      }
      queueReloadToolsActivate(pi);
      ctx.ui.notify("Reloading Pi runtime; refreshed tools will be activated immediately after reload...", "info");
      await ctx.reload();
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
        if (reloadCommand) pi.sendUserMessage?.(reloadCommand, { deliverAs: "followUp" });
        return {
          content: [{ type: "text", text: `${formatUpdateResult(result, { reload: !params.skipReload, reloadWorthy })}\n\n${reloadCommand ? `Queued ${reloadCommand} as a follow-up command.` : "Reload skipped."}` }],
          details: { reloadCommand, queued: !!reloadCommand, updateExitCode: result?.code ?? null, reloadWorthy, cwd: UPDATE_CWD, updateArgs: UPDATE_ARGS },
        };
      },
    });

    pi.registerTool({
      name: "pi_reload_tools",
      label: "Pi Reload Tools",
      description: "Queue /reload-tools so Pi reloads extensions/resources and activates newly registered tools for future turns.",
      promptSnippet: "Queue a Pi runtime reload plus active-tool refresh when newly updated extension tools are not visible yet.",
      promptGuidelines: ["Use pi_reload_tools when the user asks to refresh or reload model-visible Pi tools without running pi update --extensions."],
      parameters: ToolSchema.object({
        dryRun: ToolSchema.optional(ToolSchema.boolean({ description: "Only report the command that would be queued; do not queue it." })),
      }),
      async execute(_toolCallId, params = {}) {
        const reloadCommand = "/reload-tools";
        if (!params.dryRun) pi.sendUserMessage?.(reloadCommand, { deliverAs: "followUp" });
        return {
          content: [{ type: "text", text: params.dryRun ? `Would queue ${reloadCommand}.` : `Queued ${reloadCommand} as a follow-up command.` }],
          details: { reloadCommand, queued: !params.dryRun },
        };
      },
    });
  }
}
