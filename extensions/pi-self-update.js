import { spawn } from "node:child_process";

import { ToolSchema } from "./lib/tool-schema.js";

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 12_000;

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

function runPiUpdateWithSpawn(signal) {
  return new Promise((resolve) => {
    const child = spawn("pi", ["update"], { stdio: ["ignore", "pipe", "pipe"] });
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
      finish({ code: null, stdout, stderr: `${stderr}\npi update timed out after ${UPDATE_TIMEOUT_MS}ms`, killed: true });
    }, UPDATE_TIMEOUT_MS);
    signal?.addEventListener?.("abort", () => {
      try { child.kill("SIGTERM"); } catch {}
      finish({ code: null, stdout, stderr: `${stderr}\npi update aborted`, killed: true });
    }, { once: true });
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ code: null, stdout, stderr: `${stderr}\n${error.message}`, killed: false }));
    child.on("close", (code) => finish({ code, stdout, stderr, killed: false }));
  });
}

async function runPiUpdate(pi, signal) {
  if (typeof pi.exec === "function") {
    return pi.exec("pi", ["update"], { timeout: UPDATE_TIMEOUT_MS, signal });
  }
  return runPiUpdateWithSpawn(signal);
}

function formatUpdateResult(result, { reload, reloadWorthy }) {
  const code = result?.code ?? (result?.killed ? "killed" : "unknown");
  const stdout = truncateOutput(result?.stdout || "").trim();
  const stderr = truncateOutput(result?.stderr || "").trim();
  return [
    `pi update exited with code ${code}`,
    reload ? (reloadWorthy ? "reload: requested after package update" : "reload: requested after update attempt") : "reload: skipped (--no-reload)",
    stdout ? `\nstdout:\n${stdout}` : "",
    stderr ? `\nstderr:\n${stderr}` : "",
  ].filter(Boolean).join("\n");
}

export default function piSelfUpdateExtension(pi) {
  let updateRunning = false;

  pi.registerCommand("update", {
    description: "Run `pi update`, then reload extensions/resources when successful. Use /update --no-reload to skip reload.",
    handler: async (args, ctx) => {
      const options = parseUpdateArgs(args);
      if (options.help) {
        ctx.ui.notify("Usage: /update [--no-reload] — run pi update, then reload on success.", "info");
        return;
      }
      if (updateRunning) {
        ctx.ui.notify("pi update is already running in this session", "warning");
        return;
      }
      updateRunning = true;
      try {
        ctx.ui.notify("Running pi update...", "info");
        const result = await runPiUpdate(pi);
        const ok = Number(result?.code || 0) === 0 && !result?.killed;
        const reloadWorthy = updateLooksReloadWorthy(result);
        ctx.ui.notify(formatUpdateResult(result, { ...options, reloadWorthy }), ok || reloadWorthy ? "info" : "error");
        if (options.reload) {
          ctx.ui.notify(reloadWorthy
            ? "pi update completed package work; reloading Pi runtime..."
            : "pi update did not report package success, but /update reloads after attempts; reloading Pi runtime...", "info");
          await ctx.reload();
          return;
        }
      } catch (error) {
        ctx.ui.notify(`pi update failed: ${error.message || String(error)}`, "error");
      } finally {
        updateRunning = false;
      }
    },
  });

  if (typeof pi.registerTool === "function") {
    pi.registerTool({
      name: "pi_self_update",
      label: "Pi Self Update",
      description: "Run `pi update`, then queue /reload so updated packages are loaded in the current Pi session.",
      promptSnippet: "Queue a Pi package self-update and reload when newly landed extension/tool changes are needed in the running session.",
      promptGuidelines: ["Use pi_self_update when the user asks to update Pi packages or when a newly landed agent-utils extension/tool needs to appear in the current Pi session."],
      parameters: ToolSchema.object({
        skipReload: ToolSchema.optional(ToolSchema.boolean({ description: "Queue /update --no-reload instead of reloading after a successful update." })),
        dryRun: ToolSchema.optional(ToolSchema.boolean({ description: "Only report the command that would be queued; do not queue it." })),
      }),
      async execute(_toolCallId, params = {}) {
        const result = await runPiUpdate(pi);
        const reloadCommand = params.skipReload ? null : "/reload";
        const reloadWorthy = updateLooksReloadWorthy(result);
        if (params.dryRun) {
          return { content: [{ type: "text", text: `Would run pi update${reloadCommand ? ` and queue ${reloadCommand}` : " without reload"}.` }], details: { reloadCommand, queued: false } };
        }
        if (reloadCommand) pi.sendUserMessage?.(reloadCommand, { deliverAs: "followUp" });
        return {
          content: [{ type: "text", text: `${formatUpdateResult(result, { reload: !params.skipReload, reloadWorthy })}\n\n${reloadCommand ? `Queued ${reloadCommand} as a follow-up command.` : "Reload skipped."}` }],
          details: { reloadCommand, queued: !!reloadCommand, updateExitCode: result?.code ?? null, reloadWorthy },
        };
      },
    });
  }
}
