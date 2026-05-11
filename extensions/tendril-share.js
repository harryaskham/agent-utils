import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const PNG_MIME = "image/png";
const USAGE = `Usage:
/tendril list                         list Tendril windows/displays
/tendril window <id> [prompt]          capture a window and send it to the model
/tendril display <id> [prompt]         capture a display and send it to the model
/tendril screen <id> [prompt]          alias for /tendril display
/tendril help                         show this help`;

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function sanitizeFilenamePart(value) {
  return String(value || "target")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "target";
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function parseJsonEnvelope(stdout, commandName = "tendril") {
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

async function runTendrilJson(pi, args, { signal, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const result = await pi.exec("tendril", args, { signal, timeout });
  const envelope = parseJsonEnvelope(result.stdout, `tendril ${args[0] || ""}`);
  if (result.code !== 0 || envelope.status === "error") {
    const message = envelope.error?.message || result.stderr || `tendril exited with code ${result.code}`;
    const code = envelope.error?.code ? ` (${envelope.error.code})` : "";
    throw new Error(`tendril ${args[0] || "command"} failed${code}: ${message}`);
  }
  return envelope;
}

function getCaptureDir(ctx) {
  if (process.env.TENDRIL_SHARE_SCREENSHOT_DIR) return path.resolve(ctx.cwd || process.cwd(), process.env.TENDRIL_SHARE_SCREENSHOT_DIR);
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (sessionFile) {
    const sessionId = sanitizeFilenamePart(path.basename(sessionFile).replace(/\.jsonl?$/i, ""));
    return path.join(path.dirname(sessionFile), "tendril-share-screenshots", sessionId);
  }
  return path.join(os.tmpdir(), "pi-tendril-share", `pid-${process.pid}`);
}

function targetLabel(target) {
  return [target.title, target.name, target.app_name].filter(Boolean).join(" — ") || target.id || "unknown";
}

function formatTarget(target) {
  const caps = target.capabilities?.capture ? "capture" : "no-capture";
  return `${target.kind || "?"} ${target.id || "?"} [${caps}] ${targetLabel(target)}`;
}

function listTargetsText(envelope) {
  const targets = Array.isArray(envelope.data?.targets) ? envelope.data.targets : [];
  if (!targets.length) return "Tendril targets: none";
  return ["Tendril targets:", ...targets.map((target) => `- ${formatTarget(target)}`)].join("\n");
}

function parseCaptureArgs(args) {
  const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
  const subcommand = (tokens.shift() || "help").toLowerCase();
  if (subcommand === "window" || subcommand === "display" || subcommand === "screen") {
    const id = tokens.shift();
    return { action: "capture", kind: subcommand === "screen" ? "display" : subcommand, id, prompt: tokens.join(" ") };
  }
  return { action: subcommand };
}

async function captureTarget(pi, ctx, { kind, id, prompt }, signal) {
  if (!id) throw new Error(`Missing ${kind} id. Use /tendril ${kind} <id> [prompt].`);
  const dir = getCaptureDir(ctx);
  await mkdir(dir, { recursive: true });
  const outputPath = path.join(dir, `${timestampForFilename()}-${sanitizeFilenamePart(kind)}-${sanitizeFilenamePart(id)}.png`);
  const args = [
    "capture",
    "--json",
    "--format", "png",
    "--output", outputPath,
    "--timeout-ms", String(clampInteger(process.env.TENDRIL_SHARE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 120_000)),
    kind === "window" ? "--window" : "--display", String(id),
  ];
  const envelope = await runTendrilJson(pi, args, { signal, timeout: DEFAULT_TIMEOUT_MS + 5_000 });
  const data = await readFile(outputPath, "base64");
  const defaultPrompt = `Please inspect this Tendril ${kind} screenshot (${id}).`;
  const text = prompt?.trim() || defaultPrompt;
  const content = [
    { type: "text", text },
    { type: "image", source: { type: "base64", mediaType: PNG_MIME, data } },
  ];
  const options = ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined;
  pi.sendUserMessage(content, options);
  return { outputPath, envelope, queued: !!options };
}

export default function tendrilShareExtension(pi) {
  pi.registerCommand("tendril", {
    description: "Share Tendril windows/displays with the model. Usage: /tendril list|window <id>|display <id>",
    handler: async (args, ctx) => {
      const parsed = parseCaptureArgs(args);
      try {
        if (["help", "usage", "?"].includes(parsed.action)) {
          ctx.ui.notify(USAGE, "info");
          return;
        }
        if (parsed.action === "list") {
          const envelope = await runTendrilJson(pi, ["list", "--json"], { signal: ctx.signal, timeout: DEFAULT_TIMEOUT_MS });
          ctx.ui.notify(listTargetsText(envelope), "info");
          return;
        }
        if (parsed.action === "capture") {
          const result = await captureTarget(pi, ctx, parsed, ctx.signal);
          ctx.ui.notify(`${result.queued ? "Queued" : "Sent"} Tendril ${parsed.kind} ${parsed.id} screenshot to the model: ${result.outputPath}`, "info");
          return;
        }
        ctx.ui.notify(USAGE, "warning");
      } catch (error) {
        ctx.ui.notify(error.message || String(error), "error");
      }
    },
  });
}

export const __tendrilShareTest = {
  parseCaptureArgs,
  listTargetsText,
  parseJsonEnvelope,
};
