import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPngDisplayCommand,
  estimateRowsForImage,
  readPngDimensions,
  stableKittyImageId,
} from "./kitty-graphics.js";
import { buildTendrilCommand, tendrilCommandSummary } from "./tendril-command.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const PNG_MIME = "image/png";
const DEFAULT_DESCRIBE_MODEL = "github-copilot/claude-opus-4.8";
const FALLBACK_DESCRIBE_MODELS = Object.freeze([
  DEFAULT_DESCRIBE_MODEL,
  "github-copilot/claude-opus-4.8-1m-internal",
  "github-copilot/claude-opus-4-8",
  "github-copilot/claude-opus-4-8-1m-internal",
  "github-copilot/claude-opus-4.7",
  "github-copilot/claude-opus-4.7-1m-internal",
  "github-copilot/claude-opus-4-7",
  "github-copilot/claude-opus-4-7-1m-internal",
  "litellm-anthropic/claude-opus-4-7",
]);
const IMAGE_DESCRIPTION_PROMPT = "Describe the screenshot objectively for another AI assistant that cannot see it directly. Include visible apps/windows, text, UI state, errors, and any actionable context. Do not speculate beyond the image.";
const DEFAULT_STREAM_INTERVAL_MS = 30_000;
const MIN_STREAM_INTERVAL_MS = 10_000;
const MAX_STREAM_INTERVAL_MS = 3_600_000;
const STREAM_MAX_WIDTH = 640;
const STREAM_MAX_HEIGHT = 360;
const USAGE = `Usage:
/tendril list                                      list Tendril windows/displays
/tendril window <id-or-name> [prompt]              capture a window and send it to the model
/tendril display <id-or-name> [prompt]             capture a display and send it to the model
/tendril screen <id-or-name> [prompt]              alias for /tendril display
/tendril describe window <id-or-name> [prompt]     capture, describe with a VLM, and send text context
/tendril describe display <id-or-name> [prompt]
/tendril-describe window <id-or-name> [prompt]     alias for /tendril describe
/tendril stream window <id-or-name> [seconds]      low-res periodic screenshot sharing, default 30s
/tendril stream display <id-or-name> [seconds]
/tendril stream status|stop                        inspect or stop active stream
/tendril settings                                  open interactive Tendril settings overlay
Flags: --path-only omits image content; --no-list omits default tendril list context
/tendril help                                      show this help`;

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

export async function runTendrilJson(pi, args, { signal, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const tendril = buildTendrilCommand(args);
  const result = await pi.exec(tendril.command, tendril.args, { signal, timeout });
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

function classifyTendrilBridgeProbe(summary, probe) {
  const error = String(probe?.error || "");
  if (!error) return null;
  if (summary?.wslTunnel && /(?:--wsl-tunnel|wsl.?tunnel)/i.test(error) && /(?:unknown|unexpected|unrecognized|found argument|invalid|not expected)/i.test(error)) {
    return "remote Tendril binary appears stale and does not support --wsl-tunnel; update Tendril on the remote host or unset AGENT_UTILS_TENDRIL_WSL_TUNNEL";
  }
  if (summary?.remote && /(?:connection refused|could not resolve|no route|timed out|ssh|unreachable)/i.test(error)) {
    return "remote Tendril bridge is unreachable; check AGENT_UTILS_TENDRIL_REMOTE, SSH/Tailscale reachability, and that Tendril is installed remotely";
  }
  return null;
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

function targetSearchText(target) {
  return [target.id, target.title, target.name, target.app_name].filter(Boolean).join(" ").toLowerCase();
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

function parseShareFlags(tokens) {
  const flags = { pathOnly: false, includeList: true };
  const remaining = [];
  for (const token of tokens) {
    const normalized = String(token || "").trim().toLowerCase();
    if (["--path-only", "--pathonly", "pathonly", "pathonly=true", "path-only=true", "image=false", "includeimage=false"].includes(normalized)) {
      flags.pathOnly = true;
      continue;
    }
    if (["--image", "image=true", "includeimage=true", "pathonly=false", "path-only=false"].includes(normalized)) {
      flags.pathOnly = false;
      continue;
    }
    if (["--no-list", "--nolist", "includelist=false", "include-list=false", "list=false"].includes(normalized)) {
      flags.includeList = false;
      continue;
    }
    if (["--include-list", "--list", "includelist=true", "include-list=true", "list=true"].includes(normalized)) {
      flags.includeList = true;
      continue;
    }
    remaining.push(token);
  }
  return { tokens: remaining, flags };
}

function parseCaptureArgs(args, forcedAction) {
  const parsed = parseShareFlags(String(args || "").trim().split(/\s+/).filter(Boolean));
  const tokens = parsed.tokens;
  const flags = parsed.flags;
  let subcommand = (tokens.shift() || "help").toLowerCase();
  let action = forcedAction || "capture";
  if (subcommand === "describe") {
    action = "describe";
    subcommand = (tokens.shift() || "").toLowerCase();
  } else if (subcommand === "stream") {
    action = "stream";
    const maybeControl = (tokens[0] || "").toLowerCase();
    if (["stop", "off", "status"].includes(maybeControl)) return { action: `stream-${tokens.shift().toLowerCase()}`, ...flags };
    subcommand = (tokens.shift() || "").toLowerCase();
  }
  if (subcommand === "window" || subcommand === "display" || subcommand === "screen") {
    const target = tokens.shift();
    let intervalSeconds;
    if (action === "stream" && tokens[0] && /^\d+$/.test(tokens[0])) intervalSeconds = Number(tokens.shift());
    return {
      action,
      kind: subcommand === "screen" ? "display" : subcommand,
      target,
      id: target,
      intervalSeconds,
      prompt: tokens.join(" "),
      ...flags,
    };
  }
  return { action: subcommand || action, ...flags };
}

function parseModelSpec(spec) {
  if (!spec) return undefined;
  const slash = String(spec).indexOf("/");
  if (slash <= 0 || slash === String(spec).length - 1) throw new Error(`Vision model must be provider/model, got: ${spec}`);
  return { provider: String(spec).slice(0, slash), modelId: String(spec).slice(slash + 1) };
}

function modelSupportsImage(model) {
  return !Array.isArray(model?.input) || model.input.includes("image");
}

function agentSettingsPath(env = process.env) {
  return path.join(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "settings.json");
}

function readAgentSettings(env = process.env) {
  const settingsPath = agentSettingsPath(env);
  try {
    if (!existsSync(settingsPath)) return {};
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

function saveAgentSettings(settings, env = process.env) {
  const settingsPath = agentSettingsPath(env);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings || {}, null, 2)}\n`, "utf8");
}

function configuredDescribeModelFromSettings(settings = {}) {
  const candidates = [
    settings?.tendril?.describeModel,
    settings?.tendrilShare?.describeModel,
    settings?.agentUtils?.tendril?.describeModel,
    settings?.agentUtils?.tendrilShare?.describeModel,
  ];
  return candidates.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function describeModelConfig(env = process.env) {
  const envValue = String(env.TENDRIL_SHARE_DESCRIBE_MODEL || "").trim();
  if (envValue) return { spec: envValue, source: "TENDRIL_SHARE_DESCRIBE_MODEL" };
  const settings = readAgentSettings(env);
  const settingsValue = configuredDescribeModelFromSettings(settings);
  if (settingsValue) return { spec: settingsValue, source: "settings.json" };
  return { spec: DEFAULT_DESCRIBE_MODEL, source: "default" };
}

function previewConfig(env = process.env) {
  const raw = String(env.TENDRIL_SHARE_PREVIEW || "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return { enabled: false, source: "TENDRIL_SHARE_PREVIEW" };
  if (["1", "true", "yes", "on"].includes(raw)) return { enabled: true, source: "TENDRIL_SHARE_PREVIEW" };
  const settings = readAgentSettings(env);
  const value = settings?.tendril?.preview ?? settings?.tendrilShare?.preview ?? settings?.agentUtils?.tendril?.preview;
  if (value !== undefined) return { enabled: Boolean(value), source: "settings.json" };
  return { enabled: true, source: "default" };
}

function resolveVisionModel(ctx) {
  const config = describeModelConfig();
  const configured = config.source !== "default" ? config.spec : "";
  const specs = configured ? [configured] : FALLBACK_DESCRIBE_MODELS;
  const missing = [];
  const textOnly = [];
  for (const modelSpec of specs) {
    const parsed = parseModelSpec(modelSpec);
    const model = parsed ? ctx.modelRegistry?.find?.(parsed.provider, parsed.modelId) : ctx.model;
    if (!model) { missing.push(modelSpec); continue; }
    if (!modelSupportsImage(model)) { textOnly.push(`${model.provider}/${model.id}`); continue; }
    return model;
  }
  if (configured) {
    throw new Error(`Vision model ${configured} from ${config.source} is not registered or does not advertise image input support. Set TENDRIL_SHARE_DESCRIBE_MODEL=provider/model or tendril.describeModel in settings.json.`);
  }
  throw new Error(`No default Tendril vision model is registered. Tried: ${specs.join(", ")}.${textOnly.length ? ` Text-only matches: ${textOnly.join(", ")}.` : ""}${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}`);
}

async function resolveTendrilTarget(pi, { kind, target }, signal) {
  if (!target) throw new Error(`Missing ${kind} target. Use /tendril ${kind} <id-or-name> [prompt].`);
  const fallback = { kind, id: String(target), label: String(target), source: "explicit" };
  let envelope;
  try {
    envelope = await runTendrilJson(pi, ["list", "--json"], { signal, timeout: DEFAULT_TIMEOUT_MS });
  } catch {
    return fallback;
  }
  const targets = (Array.isArray(envelope.data?.targets) ? envelope.data.targets : [])
    .filter((candidate) => candidate.kind === kind && candidate.id && candidate.capabilities?.capture);
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

function emitCaptureHistory(pi, { action, kind, target, outputPath, queued, descriptionModel }) {
  pi.sendMessage?.({
    customType: "tendril-share",
    display: true,
    content: `${queued ? "Queued" : "Sent"} Tendril ${kind} ${target.id}${target.label && target.label !== target.id ? ` (${target.label})` : ""} ${action}: ${outputPath}`,
    details: { action, kind, target, outputPath, descriptionModel },
  });
}

async function previewInKitty(pngBase64, outputPath, { streamKey } = {}) {
  if (!previewConfig().enabled || !process.stdout?.isTTY) return null;
  try {
    const columns = clampInteger(process.env.TENDRIL_SHARE_PREVIEW_COLUMNS, 64, 8, 200);
    const dims = await readPngDimensions(outputPath).catch(() => ({ width: 1280, height: 720 }));
    const rows = estimateRowsForImage({ imageWidth: dims.width, imageHeight: dims.height, columns, maxRows: 24, minRows: 4 });
    const imageId = stableKittyImageId(streamKey ? `tendril-share-stream:${streamKey}` : `tendril-share:${outputPath}`);
    const sequence = buildPngDisplayCommand({
      imageId,
      placementId: 1,
      pngBase64,
      columns,
      rows,
      passthrough: "auto",
    });
    process.stdout.write(`\n${sequence}\n`);
    return { imageId, columns, rows, outputPath, streamKey: streamKey || null };
  } catch {
    // best-effort preview; ignore failures (non-kitty terminal, etc.)
    return null;
  }
}

async function tendrilListContextText(pi, signal) {
  try {
    const envelope = await runTendrilJson(pi, ["list", "--json"], { signal, timeout: DEFAULT_TIMEOUT_MS });
    return listTargetsText(envelope);
  } catch (error) {
    return `Tendril targets unavailable: ${error.message || String(error)}`;
  }
}

async function buildShareMessageText(pi, signal, { baseText, captured, includeList = true, pathOnly = false }) {
  const lines = [baseText, `Saved screenshot: ${captured.outputPath}`];
  if (pathOnly) lines.push("Image content omitted because pathOnly=true.");
  if (includeList !== false) lines.push("", await tendrilListContextText(pi, signal));
  return lines.join("\n");
}

async function capturePngTarget(pi, ctx, { kind, target, maxWidth, maxHeight }, signal) {
  const resolved = await resolveTendrilTarget(pi, { kind, target }, signal);
  const dir = getCaptureDir(ctx);
  await mkdir(dir, { recursive: true });
  const outputPath = path.join(dir, `${timestampForFilename()}-${sanitizeFilenamePart(kind)}-${sanitizeFilenamePart(resolved.id)}.png`);
  const args = [
    "capture",
    "--json",
    "--format", "png",
    "--output", outputPath,
    "--timeout-ms", String(clampInteger(process.env.TENDRIL_SHARE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 120_000)),
    kind === "window" ? "--window" : "--display", String(resolved.id),
  ];
  if (maxWidth !== undefined) args.push("--max-width", String(maxWidth));
  if (maxHeight !== undefined) args.push("--max-height", String(maxHeight));
  const envelope = await runTendrilJson(pi, args, { signal, timeout: DEFAULT_TIMEOUT_MS + 5_000 });
  const data = await readFile(outputPath, "base64");
  return { outputPath, envelope, data, target: resolved };
}

async function captureTarget(pi, ctx, { kind, target, id, prompt, includeList = true, pathOnly = false }, signal) {
  const captured = await capturePngTarget(pi, ctx, { kind, target: target || id }, signal);
  const defaultPrompt = `Please inspect this Tendril ${kind} screenshot (${captured.target.id}).`;
  const text = await buildShareMessageText(pi, signal, {
    baseText: prompt?.trim() || defaultPrompt,
    captured,
    includeList,
    pathOnly,
  });
  const content = pathOnly
    ? text
    : [
      { type: "text", text },
      { type: "image", data: captured.data, mimeType: PNG_MIME },
    ];
  const options = ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined;
  pi.sendUserMessage(content, options);
  await previewInKitty(captured.data, captured.outputPath);
  emitCaptureHistory(pi, { action: pathOnly ? "screenshot path" : "screenshot", kind, target: captured.target, outputPath: captured.outputPath, queued: !!options });
  return { ...captured, queued: !!options, pathOnly, includeList };
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
      // describe-only call (no kitty preview from VLM request itself)
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

async function describeTarget(pi, ctx, { kind, target, id, prompt, includeList = true }, signal) {
  const captured = await capturePngTarget(pi, ctx, { kind, target: target || id }, signal);
  const description = await describeImageData(ctx, { kind, id: captured.target.id, prompt, data: captured.data }, signal);
  const focus = prompt?.trim() ? `\n\nUser focus: ${prompt.trim()}` : "";
  const base = `Tendril ${kind} ${captured.target.id} screenshot description from ${description.model}:${focus}\n\n${description.text}`;
  const message = await buildShareMessageText(pi, signal, { baseText: base, captured, includeList, pathOnly: false });
  const options = ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined;
  pi.sendUserMessage(message, options);
  await previewInKitty(captured.data, captured.outputPath);
  emitCaptureHistory(pi, { action: "description", kind, target: captured.target, outputPath: captured.outputPath, queued: !!options, descriptionModel: description.model });
  return { ...captured, description, queued: !!options, includeList };
}

async function sendStreamFrame(pi, ctx, stream) {
  stream.frame += 1;
  const captured = await capturePngTarget(pi, ctx, {
    kind: stream.kind,
    target: stream.target.id,
    maxWidth: STREAM_MAX_WIDTH,
    maxHeight: STREAM_MAX_HEIGHT,
  }, ctx.signal);
  const frameText = stream.prompt || `Tendril stream frame ${stream.frame} from ${stream.kind} ${stream.target.id}.`;
  const includeList = stream.includeList !== false && stream.frame === 1;
  const text = await buildShareMessageText(pi, ctx.signal, {
    baseText: frameText,
    captured,
    includeList,
    pathOnly: stream.pathOnly,
  });
  const options = ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined;
  pi.sendUserMessage(stream.pathOnly ? text : [
    { type: "text", text },
    { type: "image", data: captured.data, mimeType: PNG_MIME },
  ], options);
  const preview = await previewInKitty(captured.data, captured.outputPath, { streamKey: `${stream.kind}:${stream.target.id}` });
  emitCaptureHistory(pi, { action: stream.pathOnly ? `stream frame ${stream.frame} path` : `stream frame ${stream.frame}`, kind: stream.kind, target: stream.target, outputPath: captured.outputPath, queued: !!options });
  stream.lastFrameAt = Date.now();
  stream.lastOutputPath = captured.outputPath;
  stream.lastPreview = preview;
  return captured;
}

function streamStatusText(stream) {
  if (!stream) return "No active Tendril stream.";
  const last = stream.lastFrameAt ? new Date(stream.lastFrameAt).toLocaleTimeString() : "never";
  const preview = stream.lastPreview ? `, kitty preview image=${stream.lastPreview.imageId}` : `, kitty preview=${previewConfig().enabled ? "pending" : "off"}`;
  return `Tendril stream active: ${stream.kind} ${stream.target.id} (${stream.target.label || stream.target.id}), every ${Math.round(stream.intervalMs / 1000)}s, frames sent ${stream.frame}, last frame ${last}${preview}.`;
}

function textResult(text, data = undefined) {
  return { content: [{ type: "text", text }], ...(data === undefined ? {} : { data }) };
}

function normalizeKind(kind = "window") {
  const value = String(kind || "window").toLowerCase();
  if (value === "screen") return "display";
  if (value === "window" || value === "display") return value;
  throw new Error(`Unsupported Tendril target kind: ${kind}. Use window, display, or screen.`);
}

function toolContext(signal) {
  return {
    cwd: process.cwd(),
    signal,
    isIdle: () => false,
    ui: { notify() {} },
  };
}

function tendrilImageContent({ data, mimeType = PNG_MIME }) {
  return { type: "image", data, mimeType };
}

export function createTendrilShareState() {
  return { stream: null };
}

async function startStream(pi, ctx, state, { kind, target, id, intervalSeconds, prompt, includeList = true, pathOnly = false }) {
  const resolved = await resolveTendrilTarget(pi, { kind, target: target || id }, ctx.signal);
  if (state.stream?.timer) clearInterval(state.stream.timer);
  const intervalMs = clampInteger(
    intervalSeconds === undefined ? process.env.TENDRIL_SHARE_STREAM_INTERVAL_MS : Number(intervalSeconds) * 1000,
    DEFAULT_STREAM_INTERVAL_MS,
    MIN_STREAM_INTERVAL_MS,
    MAX_STREAM_INTERVAL_MS,
  );
  const stream = {
    kind,
    target: resolved,
    intervalMs,
    prompt: prompt?.trim() || "",
    includeList,
    pathOnly,
    frame: 0,
    lastFrameAt: null,
    lastOutputPath: null,
    timer: null,
  };
  state.stream = stream;
  await sendStreamFrame(pi, ctx, stream);
  stream.timer = setInterval(() => {
    sendStreamFrame(pi, ctx, stream).catch((error) => {
      ctx.ui?.notify?.(`Tendril stream frame failed: ${error.message || String(error)}`, "error");
    });
  }, intervalMs);
  stream.timer.unref?.();
  return stream;
}

function stopStream(state) {
  const stream = state.stream;
  if (stream?.timer) clearInterval(stream.timer);
  state.stream = null;
  return stream;
}

function setSettingByPath(root, dottedPath, value) {
  const parts = String(dottedPath).split(".").filter(Boolean);
  let node = root;
  for (const part of parts.slice(0, -1)) node = (node[part] ||= {});
  node[parts.at(-1)] = value;
}

async function showTendrilSettingsWindow(ctx) {
  const settings = readAgentSettings();
  const modelChoices = [DEFAULT_DESCRIBE_MODEL, "github-copilot/claude-opus-4.7", "litellm-anthropic/claude-opus-4-7"];
  const rows = [
    {
      label: "Describe model",
      description: "Image-capable model used by /tendril describe.",
      values: modelChoices,
      get: () => configuredDescribeModelFromSettings(settings) || DEFAULT_DESCRIBE_MODEL,
      set: (value) => setSettingByPath(settings, "tendril.describeModel", value),
    },
    {
      label: "Kitty preview",
      description: "Show captured screenshots in the terminal preview when stdout is a TTY.",
      values: ["on", "off"],
      get: () => {
        const value = settings?.tendril?.preview ?? settings?.tendrilShare?.preview ?? settings?.agentUtils?.tendril?.preview;
        return value === false ? "off" : "on";
      },
      set: (value) => setSettingByPath(settings, "tendril.preview", value === "on"),
    },
  ];
  let selected = 0;
  const renderLine = (width, text = "") => String(text).slice(0, Math.max(0, width));
  const componentFactory = (_tui, _theme, keybindings, done) => ({
    piGraphics: false,
    __piGraphicsNoWrap: true,
    render(width = 72) {
      const lines = [
        "Tendril settings",
        "Use ↑/↓ or j/k to select, ←/→/space to change, Enter to save, Esc/q to close.",
        "",
      ];
      rows.forEach((row, index) => {
        const marker = index === selected ? "›" : " ";
        lines.push(`${marker} ${row.label}: ${row.get()}`);
        if (index === selected) lines.push(`    ${row.description}`);
      });
      lines.push("", `settings: ${agentSettingsPath()}`);
      return lines.map((line) => renderLine(width, line));
    },
    handleInput(data) {
      const key = String(data || "");
      const matches = (name) => { try { return keybindings?.matches?.(data, name); } catch { return false; } };
      const move = (delta) => { selected = Math.max(0, Math.min(rows.length - 1, selected + delta)); };
      const change = (delta) => {
        const row = rows[selected];
        const values = row.values;
        const current = row.get();
        const index = Math.max(0, values.indexOf(current));
        row.set(values[(index + delta + values.length) % values.length]);
      };
      if (matches("tui.select.up") || key === "\x1b[A" || key === "k") move(-1);
      else if (matches("tui.select.down") || key === "\x1b[B" || key === "j") move(1);
      else if (matches("tui.select.left") || key === "\x1b[D" || key === "h") change(-1);
      else if (matches("tui.select.right") || key === "\x1b[C" || key === "l" || key === " ") change(1);
      else if (matches("tui.select.confirm") || key === "\r" || key === "\n") done("save");
      else if (matches("tui.select.cancel") || key === "\x1b" || key.toLowerCase() === "q") done("close");
      try { _tui?.requestRender?.(); } catch {}
    },
  });
  const result = typeof ctx?.ui?.custom === "function"
    ? await ctx.ui.custom(componentFactory, { overlay: true, piGraphics: false, overlayOptions: { width: "68%", minWidth: 56, maxHeight: "70%", anchor: "center", margin: 1 } })
    : "notify";
  if (result === "save") {
    saveAgentSettings(settings);
    ctx.ui?.notify?.(`Saved Tendril settings to ${agentSettingsPath()}.`, "info");
  } else if (result === "notify") {
    const describeModel = describeModelConfig();
    const preview = previewConfig();
    ctx.ui?.notify?.(`Tendril settings: describeModel=${describeModel.spec} (${describeModel.source}), preview=${preview.enabled ? "on" : "off"} (${preview.source}). Edit ${agentSettingsPath()} or set TENDRIL_SHARE_DESCRIBE_MODEL.`, "info");
  }
}

async function handleTendrilCommand(pi, args, ctx, state, forcedAction) {
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
    if (parsed.action === "settings") {
      await showTendrilSettingsWindow(ctx);
      return;
    }
    if (parsed.action === "capture") {
      const result = await captureTarget(pi, ctx, parsed, ctx.signal);
      ctx.ui.notify(`${result.queued ? "Queued" : "Sent"} Tendril ${parsed.kind} ${result.target.id} screenshot to the model: ${result.outputPath}`, "info");
      return;
    }
    if (parsed.action === "describe") {
      const result = await describeTarget(pi, ctx, parsed, ctx.signal);
      ctx.ui.notify(`${result.queued ? "Queued" : "Sent"} Tendril ${parsed.kind} ${result.target.id} description from ${result.description.model}: ${result.outputPath}`, "info");
      return;
    }
    if (parsed.action === "stream") {
      const stream = await startStream(pi, ctx, state, parsed);
      ctx.ui.notify(`Started low-res Tendril stream for ${stream.kind} ${stream.target.id} every ${Math.round(stream.intervalMs / 1000)}s. Use /tendril stream stop to stop.`, "info");
      return;
    }
    if (parsed.action === "stream-status") {
      ctx.ui.notify(streamStatusText(state.stream), "info");
      return;
    }
    if (parsed.action === "stream-stop" || parsed.action === "stream-off") {
      const stopped = stopStream(state);
      ctx.ui.notify(stopped ? `Stopped Tendril stream for ${stopped.kind} ${stopped.target.id}.` : "No active Tendril stream.", "info");
      return;
    }
    ctx.ui.notify(USAGE, "warning");
  } catch (error) {
    ctx.ui.notify(error.message || String(error), "error");
  }
}

export default function tendrilShareExtension(pi) {
  const state = createTendrilShareState();
  pi.on?.("session_shutdown", () => stopStream(state));

  pi.registerTool?.({
    name: "tendril_settings",
    label: "Tendril Settings",
    description: "Report the configured Tendril command, remote bridge, and WSL tunnel settings used by tendril_* tools.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const summary = tendrilCommandSummary();
      const describeModel = describeModelConfig();
      const preview = previewConfig();
      return textResult(
        `tendril command=${summary.command} remote=${summary.remote || "none"} wslTunnel=${summary.wslTunnel} argsPrefix=${summary.argsPrefix.join(" ") || "none"}\ndescribeModel=${describeModel.spec} source=${describeModel.source}\npreview=${preview.enabled ? "on" : "off"} source=${preview.source}`,
        { summary, describeModel, preview },
      );
    },
  });

  pi.registerTool?.({
    name: "tendril_list",
    label: "Tendril List Targets",
    description: "List Tendril windows and displays available through the configured Tendril bridge.",
    parameters: {
      type: "object",
      properties: {
        timeoutMs: { type: "number", description: "List timeout in milliseconds. Defaults to 30000." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params = {}, signal) {
      const envelope = await runTendrilJson(pi, ["list", "--json"], { signal, timeout: params.timeoutMs || DEFAULT_TIMEOUT_MS });
      return textResult(listTargetsText(envelope), envelope.data || envelope);
    },
  });

  pi.registerTool?.({
    name: "tendril_capture",
    label: "Tendril Capture Screenshot",
    description: "Capture a Tendril window/display screenshot and return PNG image content to the model.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["window", "display", "screen"], description: "Target kind. screen is an alias for display. Defaults to window." },
        target: { type: "string", description: "Tendril target id or unique case-insensitive name/title/app substring." },
        prompt: { type: "string", description: "Optional focus prompt included in the tool result text." },
        pathOnly: { type: "boolean", description: "Return only text/path context and omit image content. Defaults to false." },
        includeList: { type: "boolean", description: "Include current tendril list target context in the text result. Defaults to true." },
        maxWidth: { type: "number", description: "Optional maximum screenshot width passed to Tendril." },
        maxHeight: { type: "number", description: "Optional maximum screenshot height passed to Tendril." },
      },
      required: ["target"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params = {}, signal) {
      const kind = normalizeKind(params.kind || "window");
      const ctx = toolContext(signal);
      const captured = await capturePngTarget(pi, ctx, {
        kind,
        target: params.target,
        maxWidth: params.maxWidth,
        maxHeight: params.maxHeight,
      }, signal);
      const focus = params.prompt ? `\nFocus: ${params.prompt}` : "";
      const text = await buildShareMessageText(pi, signal, {
        baseText: `Captured Tendril ${kind} ${captured.target.id}${captured.target.label ? ` (${captured.target.label})` : ""}.${focus}`,
        captured,
        includeList: params.includeList !== false,
        pathOnly: Boolean(params.pathOnly),
      });
      return {
        content: Boolean(params.pathOnly) ? [{ type: "text", text }] : [
          { type: "text", text },
          tendrilImageContent({ data: captured.data }),
        ],
        data: { outputPath: captured.outputPath, target: captured.target, envelope: captured.envelope, pathOnly: Boolean(params.pathOnly), includeList: params.includeList !== false },
      };
    },
  });

  pi.registerTool?.({
    name: "tendril_describe",
    label: "Tendril Describe Screenshot",
    description: "Capture a Tendril window/display and return the screenshot plus an objective-description prompt for the calling model to inspect directly.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["window", "display", "screen"], description: "Target kind. screen is an alias for display. Defaults to window." },
        target: { type: "string", description: "Tendril target id or unique case-insensitive name/title/app substring." },
        prompt: { type: "string", description: "Optional description focus." },
        pathOnly: { type: "boolean", description: "Return only text/path context and omit image content. Defaults to false." },
        includeList: { type: "boolean", description: "Include current tendril list target context in the text result. Defaults to true." },
        maxWidth: { type: "number", description: "Optional maximum screenshot width passed to Tendril." },
        maxHeight: { type: "number", description: "Optional maximum screenshot height passed to Tendril." },
      },
      required: ["target"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params = {}, signal) {
      const kind = normalizeKind(params.kind || "window");
      const ctx = toolContext(signal);
      const captured = await capturePngTarget(pi, ctx, {
        kind,
        target: params.target,
        maxWidth: params.maxWidth,
        maxHeight: params.maxHeight,
      }, signal);
      const focus = params.prompt ? `\nUser focus: ${params.prompt}` : "";
      const text = await buildShareMessageText(pi, signal, {
        baseText: `${IMAGE_DESCRIPTION_PROMPT}\n\nTarget: Tendril ${kind} ${captured.target.id}${focus}`,
        captured,
        includeList: params.includeList !== false,
        pathOnly: Boolean(params.pathOnly),
      });
      return {
        content: Boolean(params.pathOnly) ? [{ type: "text", text }] : [
          { type: "text", text },
          tendrilImageContent({ data: captured.data }),
        ],
        data: { outputPath: captured.outputPath, target: captured.target, envelope: captured.envelope, pathOnly: Boolean(params.pathOnly), includeList: params.includeList !== false },
      };
    },
  });

  pi.registerTool?.({
    name: "tendril_stream",
    label: "Tendril Stream Control",
    description: "Start, inspect, or stop the low-resolution Tendril screenshot stream. Started streams queue follow-up screenshot messages for the model.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "stop", "off"], description: "Stream action. Defaults to status when target is omitted, otherwise start." },
        kind: { type: "string", enum: ["window", "display", "screen"], description: "Target kind for start. screen is an alias for display. Defaults to window." },
        target: { type: "string", description: "Tendril target id or unique case-insensitive name/title/app substring for start." },
        intervalSeconds: { type: "number", description: "Stream interval in seconds. Defaults to 30; minimum 10." },
        prompt: { type: "string", description: "Optional prompt attached to each queued stream frame." },
        pathOnly: { type: "boolean", description: "Queue only text/path context and omit image content. Defaults to false." },
        includeList: { type: "boolean", description: "Include current tendril list target context in the first stream frame. Defaults to true." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params = {}, signal) {
      const action = String(params.action || (params.target ? "start" : "status")).toLowerCase();
      if (action === "status") return textResult(streamStatusText(state.stream), { stream: state.stream ? { ...state.stream, timer: undefined } : null });
      if (action === "stop" || action === "off") {
        const stopped = stopStream(state);
        return textResult(stopped ? `Stopped Tendril stream for ${stopped.kind} ${stopped.target.id}.` : "No active Tendril stream.", { stopped: !!stopped });
      }
      if (action !== "start") throw new Error(`Unsupported Tendril stream action: ${params.action}`);
      if (!params.target) throw new Error("tendril_stream action=start requires target.");
      const stream = await startStream(pi, toolContext(signal), state, {
        kind: normalizeKind(params.kind || "window"),
        target: params.target,
        intervalSeconds: params.intervalSeconds,
        prompt: params.prompt,
        includeList: params.includeList !== false,
        pathOnly: Boolean(params.pathOnly),
      });
      return textResult(streamStatusText(stream), { stream: { ...stream, timer: undefined } });
    },
  });

  pi.registerTool?.({
    name: "tendril_bridge_doctor",
    label: "Tendril Bridge Doctor",
    description: "Inspect configured Tendril remote/WSL tunnel settings and optionally probe target discovery through the bridge.",
    parameters: {
      type: "object",
      properties: {
        probe: { type: "boolean", description: "Run tendril list --json through the configured bridge. Defaults to true." },
        timeoutMs: { type: "number", description: "Probe timeout in milliseconds. Defaults to 30000." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params = {}, signal) {
      const summary = tendrilCommandSummary();
      const probe = params.probe === false ? null : await runTendrilJson(pi, ["list", "--json"], { signal, timeout: params.timeoutMs || DEFAULT_TIMEOUT_MS })
        .then((envelope) => ({ status: envelope.status || "ok", targets: envelope.data?.targets?.length || 0 }))
        .catch((error) => ({ status: "error", error: error.message || String(error) }));
      const hint = classifyTendrilBridgeProbe(summary, probe);
      const lines = [
        `tendril bridge command=${summary.command} remote=${summary.remote || "none"} wslTunnel=${summary.wslTunnel}`,
        `argsPrefix=${summary.argsPrefix.join(" ") || "none"}`,
        probe ? `probe=${probe.status}${probe.targets != null ? ` targets=${probe.targets}` : ""}${probe.error ? ` error=${probe.error}` : ""}` : "probe=skipped",
        hint ? `hint=${hint}` : "hint=none",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], data: { summary, probe, hint } };
    },
  });

  pi.registerCommand("tendril", {
    description: `Share Tendril windows/displays with the model. Usage: /tendril list|window <id-or-name>|display <id-or-name>|describe window <id>|stream window <id>. Bridge: ${JSON.stringify(tendrilCommandSummary())}`,
    handler: async (args, ctx) => handleTendrilCommand(pi, args, ctx, state),
  });

  pi.registerCommand("tendril-describe", {
    description: "Capture a Tendril window/display, describe it with a vision model, and send text context to the model.",
    handler: async (args, ctx) => handleTendrilCommand(pi, args, ctx, state, "describe"),
  });

  pi.registerCommand("tendril-settings", {
    description: "Open the interactive Tendril settings overlay.",
    handler: async (_args, ctx) => showTendrilSettingsWindow(ctx),
  });
}

export const __tendrilShareTest = {
  parseCaptureArgs,
  listTargetsText,
  parseJsonEnvelope,
  parseModelSpec,
  resolveTendrilTarget,
  streamStatusText,
  stopStream,
  buildTendrilCommand,
  tendrilCommandSummary,
  classifyTendrilBridgeProbe,
  configuredDescribeModelFromSettings,
  describeModelConfig,
  previewConfig,
  showTendrilSettingsWindow,
};
