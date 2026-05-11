import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const PNG_MIME = "image/png";
const DEFAULT_DESCRIBE_MODEL = "litellm-anthropic/claude-opus-4-7";
const IMAGE_DESCRIPTION_PROMPT = "Describe the screenshot objectively for another AI assistant that cannot see it directly. Include visible apps/windows, text, UI state, errors, and any actionable context. Do not speculate beyond the image.";
const USAGE = `Usage:
/tendril list                         list Tendril windows/displays
/tendril window <id> [prompt]          capture a window and send it to the model
/tendril display <id> [prompt]         capture a display and send it to the model
/tendril screen <id> [prompt]          alias for /tendril display
/tendril describe window <id> [prompt] capture, describe with a VLM, and send text context
/tendril describe display <id> [prompt]
/tendril-describe window <id> [prompt] alias for /tendril describe
/tendril help                         show this help`;

let completeForDescribe = null;

async function getCompleteForDescribe() {
  if (completeForDescribe) return completeForDescribe;
  const mod = await import("@mariozechner/pi-ai");
  return mod.complete;
}

export function setTendrilShareCompleteForTest(fn = null) {
  completeForDescribe = fn;
}

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

function parseCaptureArgs(args, forcedAction) {
  const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
  let subcommand = (tokens.shift() || "help").toLowerCase();
  let action = forcedAction || "capture";
  if (subcommand === "describe") {
    action = "describe";
    subcommand = (tokens.shift() || "").toLowerCase();
  }
  if (subcommand === "window" || subcommand === "display" || subcommand === "screen") {
    const id = tokens.shift();
    return { action, kind: subcommand === "screen" ? "display" : subcommand, id, prompt: tokens.join(" ") };
  }
  return { action: subcommand || action };
}

function parseModelSpec(spec) {
  if (!spec) return undefined;
  const slash = String(spec).indexOf("/");
  if (slash <= 0 || slash === String(spec).length - 1) throw new Error(`Vision model must be provider/model, got: ${spec}`);
  return { provider: String(spec).slice(0, slash), modelId: String(spec).slice(slash + 1) };
}

function resolveVisionModel(ctx) {
  const modelSpec = process.env.TENDRIL_SHARE_DESCRIBE_MODEL || DEFAULT_DESCRIBE_MODEL;
  const parsed = parseModelSpec(modelSpec);
  const model = parsed ? ctx.modelRegistry?.find?.(parsed.provider, parsed.modelId) : ctx.model;
  if (!model) throw new Error(`Vision model ${modelSpec} is not registered. Set TENDRIL_SHARE_DESCRIBE_MODEL=provider/model.`);
  if (Array.isArray(model.input) && !model.input.includes("image")) {
    throw new Error(`Model ${model.provider}/${model.id} does not advertise image input support.`);
  }
  return model;
}

async function capturePngTarget(pi, ctx, { kind, id }, signal) {
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
  return { outputPath, envelope, data };
}

async function captureTarget(pi, ctx, { kind, id, prompt }, signal) {
  const captured = await capturePngTarget(pi, ctx, { kind, id }, signal);
  const defaultPrompt = `Please inspect this Tendril ${kind} screenshot (${id}).`;
  const text = prompt?.trim() || defaultPrompt;
  const content = [
    { type: "text", text },
    { type: "image", source: { type: "base64", mediaType: PNG_MIME, data: captured.data } },
  ];
  const options = ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined;
  pi.sendUserMessage(content, options);
  return { ...captured, queued: !!options };
}

async function describeImageData(ctx, { kind, id, prompt, data }, signal) {
  const model = resolveVisionModel(ctx);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  const describeComplete = await getCompleteForDescribe();
  const response = await describeComplete(
    model,
    {
      systemPrompt: "You are a precise visual description assistant. Return only objective visual observations.",
      messages: [{
        role: "user",
        timestamp: Date.now(),
        content: [
          { type: "text", text: `${IMAGE_DESCRIPTION_PROMPT}\n\nTarget: Tendril ${kind} ${id}${prompt ? `\nUser focus: ${prompt}` : ""}` },
          { type: "image", data, mimeType: PNG_MIME },
        ],
      }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      maxTokens: clampInteger(process.env.TENDRIL_SHARE_DESCRIBE_MAX_TOKENS, 1200, 128, 8000),
    },
  );
  if (response.stopReason === "aborted") throw new Error("Tendril screenshot description aborted.");
  const text = (response.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return { text, model: `${model.provider}/${model.id}`, usage: response.usage, stopReason: response.stopReason };
}

async function describeTarget(pi, ctx, { kind, id, prompt }, signal) {
  const captured = await capturePngTarget(pi, ctx, { kind, id }, signal);
  const description = await describeImageData(ctx, { kind, id, prompt, data: captured.data }, signal);
  const focus = prompt?.trim() ? `\n\nUser focus: ${prompt.trim()}` : "";
  const message = `Tendril ${kind} ${id} screenshot description from ${description.model}:${focus}\n\n${description.text}`;
  const options = ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined;
  pi.sendUserMessage(message, options);
  return { ...captured, description, queued: !!options };
}

async function handleTendrilCommand(pi, args, ctx, forcedAction) {
  const parsed = parseCaptureArgs(args, forcedAction);
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
    if (parsed.action === "describe") {
      const result = await describeTarget(pi, ctx, parsed, ctx.signal);
      ctx.ui.notify(`${result.queued ? "Queued" : "Sent"} Tendril ${parsed.kind} ${parsed.id} description from ${result.description.model}: ${result.outputPath}`, "info");
      return;
    }
    ctx.ui.notify(USAGE, "warning");
  } catch (error) {
    ctx.ui.notify(error.message || String(error), "error");
  }
}

export default function tendrilShareExtension(pi) {
  pi.registerCommand("tendril", {
    description: "Share Tendril windows/displays with the model. Usage: /tendril list|window <id>|display <id>|describe window <id>",
    handler: async (args, ctx) => handleTendrilCommand(pi, args, ctx),
  });

  pi.registerCommand("tendril-describe", {
    description: "Capture a Tendril window/display, describe it with a vision model, and send text context to the model.",
    handler: async (args, ctx) => handleTendrilCommand(pi, args, ctx, "describe"),
  });
}

export const __tendrilShareTest = {
  parseCaptureArgs,
  listTargetsText,
  parseJsonEnvelope,
  parseModelSpec,
};
