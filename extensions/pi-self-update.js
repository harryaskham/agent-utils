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

function formatUpdateResult(result, { reload }) {
  const code = result?.code ?? (result?.killed ? "killed" : "unknown");
  const stdout = truncateOutput(result?.stdout || "").trim();
  const stderr = truncateOutput(result?.stderr || "").trim();
  return [
    `pi update exited with code ${code}`,
    reload ? "reload: requested after successful update" : "reload: skipped (--no-reload)",
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
        ctx.ui.notify(formatUpdateResult(result, options), ok ? "info" : "error");
        if (!ok) return;
        if (options.reload) {
          ctx.ui.notify("pi update succeeded; reloading Pi runtime...", "info");
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
      description: "Queue /update so Pi runs `pi update` and reloads extensions/resources on success.",
      promptSnippet: "Queue a Pi package self-update and reload when newly landed extension/tool changes are needed in the running session.",
      promptGuidelines: ["Use pi_self_update when the user asks to update Pi packages or when a newly landed agent-utils extension/tool needs to appear in the current Pi session."],
      parameters: ToolSchema.object({
        skipReload: ToolSchema.optional(ToolSchema.boolean({ description: "Queue /update --no-reload instead of reloading after a successful update." })),
        dryRun: ToolSchema.optional(ToolSchema.boolean({ description: "Only report the command that would be queued; do not queue it." })),
      }),
      async execute(_toolCallId, params = {}) {
        const command = params.skipReload ? "/update --no-reload" : "/update";
        if (params.dryRun) {
          return { content: [{ type: "text", text: `Would queue ${command}.` }], details: { command, queued: false } };
        }
        pi.sendUserMessage?.(command, { deliverAs: "followUp" });
        return {
          content: [{ type: "text", text: `Queued ${command} as a follow-up command. It will run pi update and ${params.skipReload ? "skip reload" : "reload on success"}.` }],
          details: { command, queued: true },
        };
      },
    });
  }
}
