import { mkdir, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

import {
  MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE,
  buildDeleteCommand,
  buildKittyUnicodePlaceholderLines,
  buildPngDisplayCommand,
  buildPngVirtualPlacementCommand,
  detectKittyPassthroughMode,
  estimateRowsForImage,
  fileToBase64,
  isSupportedKittyPngPath,
  readPngDimensions,
  shouldUseInMemoryTransfer,
  shouldUseUnicodePlaceholders,
  stableKittyImageId,
} from "./kitty-graphics.js";

const TOOL_PREFIX = "kitty_image_preview";
const WIDGET_ID = "kitty-image-preview";
const SIDE_OVERLAY_PLACEMENT = "rightOverlay";
const DEFAULT_Z_INDEX = -10;
const DEFAULT_BG_Z_INDEX = -1073741824;
const DEFAULT_COLUMNS = 48;
const DEFAULT_MAX_ROWS = 24;
const SUPPORTED_EXTENSIONS = new Set([".png", ".apng"]);
const WIDGET_PLACEMENTS = ["aboveEditor", "belowEditor"];
const PREVIEW_PLACEMENTS = [...WIDGET_PLACEMENTS, SIDE_OVERLAY_PLACEMENT];

function stringEnum(values, description) {
  return StringEnum(values, { description });
}

function normalizeMaybeAtPath(input) {
  if (typeof input !== "string") return input;
  return input.startsWith("@") ? input.slice(1) : input;
}

function expandHome(inputPath) {
  if (!inputPath?.startsWith("~/")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(2));
}

function resolveUserPath(cwd, inputPath) {
  const normalized = expandHome(normalizeMaybeAtPath(inputPath));
  return path.resolve(cwd, normalized);
}

function relativeLabel(cwd, absolutePath) {
  const relative = path.relative(cwd, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}

function sanitizeFilenamePart(value) {
  return String(value || "item")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function serializePublicState(state) {
  return {
    version: 1,
    visible: state.visible,
    index: state.index,
    config: { ...state.config },
    items: state.items.map((item) => ({
      id: item.id,
      path: item.path,
      label: item.label,
      mediaType: item.mediaType,
      width: item.width,
      height: item.height,
      addedAt: item.addedAt,
    })),
  };
}

function restorePublicState(state, details) {
  const snapshot = details?.kittyImagePreviewState;
  if (!snapshot || !Array.isArray(snapshot.items)) return;
  state.visible = Boolean(snapshot.visible);
  state.index = clampInteger(snapshot.index, 0, 0, Math.max(0, snapshot.items.length - 1));
  state.config = { ...state.config, ...(snapshot.config ?? {}) };
  state.items = snapshot.items
    .filter((item) => typeof item?.path === "string")
    .map((item) => ({
      id: Number.isFinite(item.id) ? item.id : stableKittyImageId(item.path),
      path: item.path,
      label: item.label || path.basename(item.path),
      mediaType: item.mediaType || "image/png",
      width: item.width,
      height: item.height,
      addedAt: item.addedAt || Date.now(),
    }));
}

function summarizeCurrent(state) {
  const current = state.items[state.index];
  if (!current) return "No image is loaded.";
  const dims = current.width && current.height ? ` (${current.width}×${current.height})` : "";
  const mode = state.config.transferMode === "auto" ? "auto" : state.config.transferMode;
  return `Showing ${state.index + 1}/${state.items.length}: ${current.label}${dims}; placement=${state.config.placement}, transfer=${mode}, graphicsPlacement=${state.config.placementMode}, z=${state.config.zIndex}.`;
}

function renderPlaceholderLines(width, rows, text) {
  const line = " ".repeat(Math.max(1, width));
  const output = Array.from({ length: Math.max(1, rows) }, () => line);
  if (text) output[0] = `${text}${line}`.slice(0, Math.max(1, width));
  return output;
}

export function isSideOverlayPlacement(placement) {
  return placement === SIDE_OVERLAY_PLACEMENT;
}

function shouldRenderUnicodePlaceholders(state, options = {}) {
  return shouldUseUnicodePlaceholders({
    placementMode: state.config.placementMode,
    passthrough: state.config.passthrough,
    env: process.env,
    forceAnchored: options.forceUnicodePlaceholders || isSideOverlayPlacement(state.config.placement),
  });
}

export class KittyImagePreviewWidget {
  constructor(state, options = {}) {
    this.state = state;
    this.options = options;
  }

  render(width) {
    const state = this.state;
    if (!state.visible || state.items.length === 0) return [];
    const current = state.items[state.index];
    const availableWidth = Math.max(1, Math.trunc(width || 1));
    const columns = Math.min(availableWidth, clampInteger(state.config.columns, DEFAULT_COLUMNS, 1, 4096));
    const useUnicodePlaceholders = shouldRenderUnicodePlaceholders(state, this.options);
    const rows = clampInteger(
      state.config.rows || estimateRowsForImage({
        imageWidth: current.width,
        imageHeight: current.height,
        columns,
        maxRows: state.config.maxRows,
        minRows: state.config.minRows,
      }),
      12,
      1,
      useUnicodePlaceholders ? MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1 : 200,
    );

    const command = buildCurrentDisplayCommand(state, current, columns, rows, useUnicodePlaceholders);
    const label = state.config.showCaption
      ? `kitty image ${state.index + 1}/${state.items.length}: ${current.label}`
      : "";
    const lines = useUnicodePlaceholders
      ? buildKittyUnicodePlaceholderLines({
        imageId: current.id,
        placementId: state.config.placementId,
        columns,
        rows,
        width: availableWidth,
        caption: label,
      })
      : renderPlaceholderLines(availableWidth, rows, label);
    lines[0] = `${state.lastDeleteCommand || ""}${command}${lines[0]}`;
    state.lastDeleteCommand = "";
    return lines;
  }

  invalidate() {}
}

function sideOverlayWidth(state) {
  return clampInteger(state.config.columns, DEFAULT_COLUMNS, 1, 4096);
}

function sideOverlayMaxHeight(state) {
  return clampInteger(state.config.rows || state.config.maxRows, DEFAULT_MAX_ROWS, 1, MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1);
}

export function buildSideOverlayOptions(state) {
  return {
    anchor: "right-center",
    width: sideOverlayWidth(state),
    maxHeight: sideOverlayMaxHeight(state),
    margin: { right: 0 },
    nonCapturing: true,
  };
}

function requestSideOverlayRender(state) {
  state.sideOverlay?.component?.invalidate?.();
  state.sideOverlay?.tui?.requestRender?.();
}

function clearSideOverlay(state) {
  const overlay = state.sideOverlay;
  if (!overlay) return;
  state.sideOverlay = undefined;
  overlay.cancelled = true;
  overlay.handle?.hide?.();
  overlay.component?.dispose?.();
}

function fallbackSideWidget(ctx, state) {
  const componentFactory = () => new KittyImagePreviewWidget(state, { forceUnicodePlaceholders: true });
  ctx.ui.setWidget(WIDGET_ID, componentFactory, { placement: "aboveEditor" });
  if (!state.sideOverlayUnavailableWarned) {
    state.sideOverlayUnavailableWarned = true;
    ctx.ui.notify?.("kitty image rightOverlay needs Pi overlay support; falling back to the above-editor widget.", "warning");
  }
}

function ensureSideOverlay(ctx, state) {
  if (state.sideOverlay?.handle || state.sideOverlay?.pending) {
    state.sideOverlay.handle?.setHidden?.(false);
    requestSideOverlayRender(state);
    return;
  }
  if (typeof ctx.ui.custom !== "function") {
    fallbackSideWidget(ctx, state);
    return;
  }

  const overlay = {
    pending: true,
    cancelled: false,
    handle: undefined,
    component: undefined,
    tui: undefined,
  };
  state.sideOverlay = overlay;

  let promise;
  try {
    promise = ctx.ui.custom((_tui, _theme, _keybindings, _done) => {
      overlay.pending = false;
      overlay.tui = _tui;
      overlay.component = new KittyImagePreviewWidget(state, { forceUnicodePlaceholders: true });
      return overlay.component;
    }, {
      overlay: true,
      overlayOptions: () => buildSideOverlayOptions(state),
      onHandle: (handle) => {
        overlay.handle = handle;
        handle.unfocus?.();
        if (overlay.cancelled) handle.hide?.();
      },
    });
  } catch (error) {
    if (state.sideOverlay === overlay) state.sideOverlay = undefined;
    fallbackSideWidget(ctx, state);
    ctx.ui.notify?.(`kitty image rightOverlay failed: ${error.message}`, "warning");
    return;
  }

  promise?.catch?.((error) => {
    if (state.sideOverlay === overlay) state.sideOverlay = undefined;
    ctx.ui.notify?.(`kitty image rightOverlay closed: ${error.message}`, "warning");
  });
}

export function syncWidget(ctx, state) {
  if (!ctx?.hasUI) return;
  if (!state.visible || state.items.length === 0) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    clearSideOverlay(state);
    ctx.ui.setStatus(WIDGET_ID, undefined);
    return;
  }
  const current = state.items[state.index];
  if (isSideOverlayPlacement(state.config.placement)) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    ensureSideOverlay(ctx, state);
  } else {
    clearSideOverlay(state);
    const componentFactory = () => new KittyImagePreviewWidget(state);
    ctx.ui.setWidget(WIDGET_ID, componentFactory, { placement: state.config.placement });
  }
  const animation = state.animation?.running ? " ▶" : "";
  ctx.ui.setStatus(WIDGET_ID, `🖼${animation} ${state.index + 1}/${state.items.length} ${current?.label ?? ""}`);
}

function flashDeleteWidget(ctx, state, deleteCommand) {
  if (!ctx?.hasUI) return;
  if (isSideOverlayPlacement(state.config.placement)) {
    clearSideOverlay(state);
    const flashComponent = {
      render(width) {
        return [`${deleteCommand}${" ".repeat(Math.max(1, width))}`];
      },
      invalidate() {},
    };
    if (typeof ctx.ui.custom === "function") {
      let handle;
      try {
        const promise = ctx.ui.custom(() => flashComponent, {
          overlay: true,
          overlayOptions: () => buildSideOverlayOptions(state),
          onHandle: (overlayHandle) => {
            handle = overlayHandle;
          },
        });
        promise?.catch?.(() => {});
        setTimeout(() => handle?.hide?.(), 100);
      } catch {
        ctx.ui.setWidget(WIDGET_ID, () => flashComponent, { placement: "aboveEditor" });
        setTimeout(() => ctx.ui.setWidget(WIDGET_ID, undefined), 100);
      }
    } else {
      ctx.ui.setWidget(WIDGET_ID, () => flashComponent, { placement: "aboveEditor" });
      setTimeout(() => ctx.ui.setWidget(WIDGET_ID, undefined), 100);
    }
    ctx.ui.setStatus(WIDGET_ID, undefined);
    return;
  }
  ctx.ui.setWidget(WIDGET_ID, () => ({
    render(width) {
      return [`${deleteCommand}${" ".repeat(Math.max(1, width))}`];
    },
    invalidate() {},
  }), { placement: state.config.placement });
  ctx.ui.setStatus(WIDGET_ID, undefined);
  setTimeout(() => {
    if (!state.visible) ctx.ui.setWidget(WIDGET_ID, undefined);
  }, 100);
}

function stopAnimation(state) {
  if (state.animationTimer) clearInterval(state.animationTimer);
  state.animationTimer = undefined;
  state.animation = { running: false };
}

function startAnimation(state, ctx, { intervalMs = 250, loop = true } = {}) {
  stopAnimation(state);
  state.animation = { running: true, intervalMs, loop };
  state.animationTimer = setInterval(() => {
    if (!state.visible || state.items.length === 0) {
      stopAnimation(state);
      syncWidget(ctx, state);
      return;
    }
    const next = state.index + 1;
    if (next >= state.items.length) {
      if (!loop) {
        stopAnimation(state);
        syncWidget(ctx, state);
        return;
      }
      state.index = 0;
    } else {
      state.index = next;
    }
    prepareCurrentImage(state, ctx, { forceReload: true }).catch((error) => {
      stopAnimation(state);
      ctx?.ui?.notify?.(`kitty image animation stopped: ${error.message}`, "warning");
    });
  }, Math.max(50, intervalMs));
}

function buildCurrentDisplayCommand(state, current, columns, rows, useUnicodePlaceholders = false) {
  const prepared = state.currentCommand;
  if (!prepared || prepared.itemId !== current.id) return "";
  const placementMode = useUnicodePlaceholders ? "unicode" : "cursor";
  const signature = `${columns}:${rows}:${prepared.zIndex}:${prepared.transport}:${prepared.passthrough}:${prepared.chunkSize}:${placementMode}:${state.config.placementId}`;
  if (prepared.rendered?.signature === signature) return prepared.rendered.command;
  const command = useUnicodePlaceholders
    ? buildPngVirtualPlacementCommand({
      imageId: current.id,
      placementId: state.config.placementId,
      pngBase64: prepared.pngBase64,
      filePath: prepared.filePath,
      columns,
      rows,
      passthrough: prepared.passthrough,
      chunkSize: prepared.chunkSize,
    })
    : buildPngDisplayCommand({
      imageId: current.id,
      placementId: state.config.placementId,
      pngBase64: prepared.pngBase64,
      filePath: prepared.filePath,
      columns,
      rows,
      zIndex: prepared.zIndex,
      passthrough: prepared.passthrough,
      chunkSize: prepared.chunkSize,
    });
  prepared.rendered = { signature, command };
  return command;
}

async function prepareCurrentImage(state, ctx, { forceReload = false } = {}) {
  const current = state.items[state.index];
  if (!current) return;
  const useMemory = state.config.transferMode === "memory" || (
    state.config.transferMode === "auto" && shouldUseInMemoryTransfer(process.env)
  );
  const transport = useMemory ? "memory" : "file";
  const zIndex = state.config.background ? DEFAULT_BG_Z_INDEX : state.config.zIndex;
  const signature = `${current.id}:${transport}:${zIndex}:${state.config.passthrough}:${state.config.chunkSize}`;

  if (!forceReload && state.currentCommand?.signature === signature) return;

  const pngBase64 = useMemory ? await fileToBase64(current.path) : undefined;
  state.lastDeleteCommand = state.config.clearPrevious
    ? buildDeleteCommand({ deleteMode: "A", passthrough: state.config.passthrough })
    : "";
  state.currentCommand = {
    itemId: current.id,
    signature,
    transport,
    pngBase64,
    filePath: useMemory ? undefined : current.path,
    zIndex,
    passthrough: state.config.passthrough,
    chunkSize: state.config.chunkSize,
    rendered: undefined,
  };
  syncWidget(ctx, state);
}

async function collectPngFiles(directory, { recursive = false, limit = 200 } = {}) {
  const entries = [];
  async function visit(dir) {
    if (entries.length >= limit) return;
    const children = await readdir(dir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const child of children) {
      if (entries.length >= limit) break;
      const absolute = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (recursive) await visit(absolute);
      } else if (child.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(child.name).toLowerCase())) {
        entries.push(absolute);
      }
    }
  }
  await visit(directory);
  return entries;
}

async function buildItem(cwd, inputPath, label) {
  const absolutePath = resolveUserPath(cwd, inputPath);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`Image path is not a file: ${absolutePath}`);
  if (!isSupportedKittyPngPath(absolutePath)) {
    throw new Error(`Native kitty preview currently accepts PNG/APNG files. Convert to PNG first: ${absolutePath}`);
  }
  const dimensions = await readPngDimensions(absolutePath).catch(() => undefined);
  return {
    id: stableKittyImageId(`${absolutePath}:${info.mtimeMs}:${info.size}`),
    path: absolutePath,
    label: label || relativeLabel(cwd, absolutePath),
    mediaType: "image/png",
    width: dimensions?.width,
    height: dimensions?.height,
    addedAt: Date.now(),
  };
}

function applyConfig(state, config = {}) {
  if (!config || typeof config !== "object") return;
  if (config.columns !== undefined) state.config.columns = clampInteger(config.columns, state.config.columns, 1, 4096);
  if (config.rows !== undefined) state.config.rows = clampInteger(config.rows, state.config.rows, 1, 200);
  if (config.maxRows !== undefined) state.config.maxRows = clampInteger(config.maxRows, state.config.maxRows, 1, 200);
  if (config.minRows !== undefined) state.config.minRows = clampInteger(config.minRows, state.config.minRows, 1, 200);
  if (config.zIndex !== undefined) state.config.zIndex = clampInteger(config.zIndex, state.config.zIndex, -2147483648, 2147483647);
  if (typeof config.background === "boolean") state.config.background = config.background;
  if (typeof config.showCaption === "boolean") state.config.showCaption = config.showCaption;
  if (typeof config.clearPrevious === "boolean") state.config.clearPrevious = config.clearPrevious;
  if (PREVIEW_PLACEMENTS.includes(config.placement)) state.config.placement = config.placement;
  if (["auto", "memory", "file"].includes(config.transferMode)) state.config.transferMode = config.transferMode;
  if (["auto", "tmux", "none"].includes(config.passthrough)) state.config.passthrough = config.passthrough;
  if (["auto", "unicode", "cursor"].includes(config.placementMode)) state.config.placementMode = config.placementMode;
  if (config.placementId !== undefined) state.config.placementId = clampInteger(config.placementId, state.config.placementId, 1, 2147483647);
  if (config.chunkSize !== undefined) state.config.chunkSize = clampInteger(config.chunkSize, state.config.chunkSize, 512, 65536);
  state.currentCommand = undefined;
}

function makeDetails(state, extra = {}) {
  return {
    ...extra,
    kittyImagePreviewState: serializePublicState(state),
  };
}

function makeContent(state, extraLines = []) {
  return [{ type: "text", text: [summarizeCurrent(state), ...extraLines].filter(Boolean).join("\n") }];
}

function parseJsonEnvelope(stdout, commandName) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) throw new Error(`${commandName} returned no JSON output`);
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`${commandName} returned invalid JSON: ${error.message}`);
  }
}

async function runTendrilJson(pi, args, { signal, timeout = 30_000 } = {}) {
  const result = await pi.exec("tendril", args, { signal, timeout });
  const envelope = parseJsonEnvelope(result.stdout, `tendril ${args[0] || ""}`);
  if (result.code !== 0 || envelope.status === "error") {
    const message = envelope.error?.message || result.stderr || `tendril exited with code ${result.code}`;
    const code = envelope.error?.code ? ` (${envelope.error.code})` : "";
    throw new Error(`tendril ${args[0] || "command"} failed${code}: ${message}`);
  }
  return envelope;
}

function targetText(target) {
  return [target.title, target.name, target.app_name, target.id].filter(Boolean).join(" ").toLowerCase();
}

async function resolveTendrilTarget(pi, params, signal) {
  if (params.window && params.display) throw new Error("Specify only one of window or display.");
  if (params.window) return { kind: "window", id: String(params.window), source: "explicit" };
  if (params.display) return { kind: "display", id: String(params.display), source: "explicit" };

  const envelope = await runTendrilJson(pi, ["list", "--json"], { signal, timeout: clampInteger(params.timeoutMs, 30_000, 1_000, 120_000) });
  let targets = Array.isArray(envelope.data?.targets) ? envelope.data.targets : [];
  targets = targets.filter((target) => target?.capabilities?.capture && target.id && target.kind);
  if (params.targetName) {
    const needle = String(params.targetName).toLowerCase();
    targets = targets.filter((target) => targetText(target).includes(needle));
  }
  const targetKind = params.targetKind || "display";
  const kinds = targetKind === "auto" ? ["display", "window"] : [targetKind];
  for (const kind of kinds) {
    const match = targets.find((target) => target.kind === kind);
    if (match) return { ...match, id: String(match.id), source: "list" };
  }
  const fallback = targets[0];
  if (fallback) return { ...fallback, id: String(fallback.id), source: "list" };
  throw new Error("No capture-capable Tendril targets found.");
}

function getSessionScreenshotDir(ctx, outputDir) {
  if (outputDir) return resolveUserPath(ctx.cwd, outputDir);
  if (process.env.KITTY_IMAGE_PREVIEW_SCREENSHOT_DIR) {
    return resolveUserPath(ctx.cwd, process.env.KITTY_IMAGE_PREVIEW_SCREENSHOT_DIR);
  }
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (sessionFile) {
    const sessionId = sanitizeFilenamePart(path.basename(sessionFile).replace(/\.jsonl?$/i, ""));
    return path.join(path.dirname(sessionFile), "kitty-image-preview-screenshots", sessionId);
  }
  return path.join(os.tmpdir(), "pi-kitty-image-preview", `pid-${process.pid}`);
}

function buildScreenshotOutputPath(ctx, params, target, date = new Date()) {
  const dir = getSessionScreenshotDir(ctx, params.outputDir);
  const filename = params.filename
    ? sanitizeFilenamePart(params.filename.replace(/\.png$/i, ""))
    : `${timestampForFilename(date)}-${sanitizeFilenamePart(target.kind)}-${sanitizeFilenamePart(target.id)}`;
  return {
    dir,
    path: path.join(dir, `${filename}.png`),
  };
}

function buildTendrilCaptureArgs(params, target, outputPath) {
  const args = [
    "capture",
    "--json",
    "--format",
    "png",
    "--output",
    outputPath,
    "--timeout-ms",
    String(clampInteger(params.timeoutMs, 30_000, 1_000, 120_000)),
    target.kind === "window" ? "--window" : "--display",
    String(target.id),
  ];
  if (params.maxWidth !== undefined) args.push("--max-width", String(clampInteger(params.maxWidth, 0, 1, 100_000)));
  if (params.maxHeight !== undefined) args.push("--max-height", String(clampInteger(params.maxHeight, 0, 1, 100_000)));
  if (params.compression !== undefined) args.push("--compression", String(params.compression));
  return args;
}

function defaultScreenshotLabel(target, date = new Date()) {
  const name = target.title || target.name || target.app_name || target.id;
  return `screenshot ${target.kind} ${name} ${date.toLocaleTimeString()}`;
}

export default function kittyImagePreviewExtension(pi) {
  const state = {
    visible: false,
    index: 0,
    items: [],
    currentCommand: undefined,
    lastDeleteCommand: "",
    animationTimer: undefined,
    animation: { running: false },
    config: {
      columns: DEFAULT_COLUMNS,
      rows: undefined,
      minRows: 4,
      maxRows: DEFAULT_MAX_ROWS,
      zIndex: DEFAULT_Z_INDEX,
      background: false,
      showCaption: true,
      clearPrevious: true,
      placement: "aboveEditor",
      placementId: stableKittyImageId("agent-utils-kitty-image-preview-placement"),
      transferMode: "auto",
      passthrough: "auto",
      placementMode: "auto",
      chunkSize: 4096,
    },
  };

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName?.startsWith(TOOL_PREFIX)) {
        restorePublicState(state, entry.message.details);
      }
    }
    if (state.visible && state.items[state.index]) {
      await prepareCurrentImage(state, ctx).catch((error) => {
        if (ctx.hasUI) ctx.ui.notify(`kitty image preview restore failed: ${error.message}`, "warning");
      });
      syncWidget(ctx, state);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopAnimation(state);
    state.visible = false;
    if (ctx?.hasUI) {
      flashDeleteWidget(ctx, state, buildDeleteCommand({ deleteMode: "A", passthrough: state.config.passthrough }));
      ctx.ui.setStatus(WIDGET_ID, undefined);
    }
  });

  pi.registerTool({
    name: "kitty_image_preview_add",
    label: "Kitty Image Preview Add",
    description: "Add one PNG/APNG image to the persistent kitty graphics preview widget and optionally show it immediately.",
    promptSnippet: "Add PNG/APNG images to a persistent terminal preview widget rendered with the kitty graphics protocol.",
    promptGuidelines: [
      "Use kitty_image_preview_add or kitty_image_preview_add_folder to show visual artifacts in the terminal for the operator.",
      "Prefer PNG/APNG inputs. The native kitty protocol path avoids shelling out to kitty icat.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to a PNG/APNG image. Leading @ is accepted and stripped." }),
      label: Type.Optional(Type.String({ description: "Optional display label. Defaults to a path relative to cwd." })),
      show: Type.Optional(Type.Boolean({ description: "Show this image immediately. Defaults to true." })),
      config: Type.Optional(Type.Object({
        columns: Type.Optional(Type.Number({ description: "Target image width in terminal cells." })),
        rows: Type.Optional(Type.Number({ description: "Target image height in terminal cells. If omitted, aspect ratio is estimated." })),
        maxRows: Type.Optional(Type.Number({ description: "Maximum auto-sized widget rows." })),
        minRows: Type.Optional(Type.Number({ description: "Minimum auto-sized widget rows." })),
        zIndex: Type.Optional(Type.Number({ description: "Kitty z-index. Negative draws under text." })),
        background: Type.Optional(Type.Boolean({ description: "Use an extremely negative z-index suitable for background-image style placement." })),
        showCaption: Type.Optional(Type.Boolean({ description: "Render a text caption over the reserved image area." })),
        clearPrevious: Type.Optional(Type.Boolean({ description: "Delete previous visible placements before drawing the current image." })),
        placement: Type.Optional(stringEnum(PREVIEW_PLACEMENTS, "Where Pi should mount the preview: above/below the editor widget, or a fixed right-side overlay.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport. auto uses memory inside tmux, file otherwise.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode. auto detects tmux.")),
        placementMode: Type.Optional(stringEnum(["auto", "unicode", "cursor"], "Graphics placement mode. auto uses Unicode placeholders inside tmux and cursor placement otherwise.")),
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      applyConfig(state, params.config);
      const item = await buildItem(ctx.cwd, params.path, params.label);
      state.items.push(item);
      if (params.show !== false) {
        state.index = state.items.length - 1;
        state.visible = true;
        await prepareCurrentImage(state, ctx, { forceReload: true });
      }
      syncWidget(ctx, state);
      return {
        content: makeContent(state, [`Added ${item.label}.`]),
        details: makeDetails(state, { added: item }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_capture",
    label: "Kitty Image Preview Capture",
    description: "Capture a screenshot with the first-party tendril CLI into the Pi session screenshot folder, add it to the kitty preview list, and show it immediately.",
    promptSnippet: "Capture a current Tendril screenshot and immediately show it in the kitty terminal preview widget.",
    promptGuidelines: [
      "Use kitty_image_preview_capture when the user asks to show the current screen, window, UI state, or latest screenshot in the terminal.",
      "If no target is provided, it automatically chooses the first capture-capable display from tendril list.",
    ],
    parameters: Type.Object({
      window: Type.Optional(Type.String({ description: "Explicit Tendril window id to capture. Mutually exclusive with display." })),
      display: Type.Optional(Type.String({ description: "Explicit Tendril display id to capture. Mutually exclusive with window." })),
      targetKind: Type.Optional(stringEnum(["auto", "display", "window"], "Target kind to auto-select from tendril list when window/display is omitted. Defaults to display.")),
      targetName: Type.Optional(Type.String({ description: "Case-insensitive substring matched against Tendril target title/name/app_name/id during auto-selection." })),
      outputDir: Type.Optional(Type.String({ description: "Screenshot output directory. Defaults to a kitty-image-preview-screenshots folder beside the Pi session file." })),
      filename: Type.Optional(Type.String({ description: "Optional output filename, with or without .png. Defaults to timestamp-target.png." })),
      label: Type.Optional(Type.String({ description: "Optional preview label. Defaults to a screenshot label with target and time." })),
      replace: Type.Optional(Type.Boolean({ description: "Replace the current preview list with this screenshot. Defaults to false." })),
      maxWidth: Type.Optional(Type.Number({ description: "Optional Tendril capture --max-width in pixels." })),
      maxHeight: Type.Optional(Type.Number({ description: "Optional Tendril capture --max-height in pixels." })),
      compression: Type.Optional(Type.String({ description: "Optional Tendril capture --compression value." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Tendril list/capture timeout in milliseconds. Defaults to 30000." })),
      config: Type.Optional(Type.Object({
        columns: Type.Optional(Type.Number()),
        rows: Type.Optional(Type.Number()),
        maxRows: Type.Optional(Type.Number()),
        minRows: Type.Optional(Type.Number()),
        zIndex: Type.Optional(Type.Number()),
        background: Type.Optional(Type.Boolean()),
        showCaption: Type.Optional(Type.Boolean()),
        clearPrevious: Type.Optional(Type.Boolean()),
        placement: Type.Optional(stringEnum(PREVIEW_PLACEMENTS, "Where Pi should mount the preview: above/below the editor widget, or a fixed right-side overlay.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode.")),
        placementMode: Type.Optional(stringEnum(["auto", "unicode", "cursor"], "Graphics placement mode. auto uses Unicode placeholders inside tmux.")),
      })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      applyConfig(state, params.config);
      const target = await resolveTendrilTarget(pi, params, signal);
      const now = new Date();
      const output = buildScreenshotOutputPath(ctx, params, target, now);
      await mkdir(output.dir, { recursive: true });
      onUpdate?.({ content: [{ type: "text", text: `Capturing ${target.kind} ${target.id} with Tendril...` }] });
      const args = buildTendrilCaptureArgs(params, target, output.path);
      const capture = await runTendrilJson(pi, args, {
        signal,
        timeout: clampInteger(params.timeoutMs, 30_000, 1_000, 120_000) + 5_000,
      });
      const item = await buildItem(ctx.cwd, output.path, params.label || defaultScreenshotLabel(target, now));
      if (params.replace) {
        stopAnimation(state);
        state.items = [];
      }
      state.items.push(item);
      state.index = state.items.length - 1;
      state.visible = true;
      await prepareCurrentImage(state, ctx, { forceReload: true });
      syncWidget(ctx, state);
      return {
        content: makeContent(state, [`Captured ${target.kind} ${target.id} to ${output.path}.`]),
        details: makeDetails(state, {
          capture: {
            target: { kind: target.kind, id: target.id, title: target.title, name: target.name, appName: target.app_name },
            outputPath: output.path,
            outputDir: output.dir,
            tendrilArgs: args,
            tendril: capture,
          },
          added: item,
        }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_add_folder",
    label: "Kitty Image Preview Add Folder",
    description: "Add a folder/series of PNG/APNG images to the persistent kitty graphics preview widget.",
    promptSnippet: "Add a folder or image series to the kitty terminal preview widget.",
    parameters: Type.Object({
      path: Type.String({ description: "Directory containing PNG/APNG images." }),
      recursive: Type.Optional(Type.Boolean({ description: "Recurse into subdirectories. Defaults to false." })),
      limit: Type.Optional(Type.Number({ description: "Maximum images to add. Defaults to 200." })),
      replace: Type.Optional(Type.Boolean({ description: "Replace the existing preview list instead of appending. Defaults to false." })),
      showIndex: Type.Optional(Type.Number({ description: "Zero-based index among newly added images to show. Defaults to 0." })),
      config: Type.Optional(Type.Object({
        columns: Type.Optional(Type.Number()),
        rows: Type.Optional(Type.Number()),
        maxRows: Type.Optional(Type.Number()),
        minRows: Type.Optional(Type.Number()),
        zIndex: Type.Optional(Type.Number()),
        background: Type.Optional(Type.Boolean()),
        showCaption: Type.Optional(Type.Boolean()),
        clearPrevious: Type.Optional(Type.Boolean()),
        placement: Type.Optional(stringEnum(PREVIEW_PLACEMENTS, "Where Pi should mount the preview: above/below the editor widget, or a fixed right-side overlay.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode.")),
        placementMode: Type.Optional(stringEnum(["auto", "unicode", "cursor"], "Graphics placement mode. auto uses Unicode placeholders inside tmux.")),
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      applyConfig(state, params.config);
      const directory = resolveUserPath(ctx.cwd, params.path);
      const files = await collectPngFiles(directory, {
        recursive: Boolean(params.recursive),
        limit: clampInteger(params.limit, 200, 1, 5000),
      });
      if (files.length === 0) throw new Error(`No PNG/APNG images found in ${directory}`);
      const items = [];
      for (const file of files) items.push(await buildItem(ctx.cwd, file));
      if (params.replace) state.items = [];
      const startIndex = state.items.length;
      state.items.push(...items);
      state.index = startIndex + clampInteger(params.showIndex, 0, 0, items.length - 1);
      state.visible = true;
      await prepareCurrentImage(state, ctx, { forceReload: true });
      syncWidget(ctx, state);
      return {
        content: makeContent(state, [`Added ${items.length} image(s) from ${relativeLabel(ctx.cwd, directory)}.`]),
        details: makeDetails(state, { addedCount: items.length, added: items }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_show",
    label: "Kitty Image Preview Show",
    description: "Navigate or control the persistent kitty graphics preview widget: current, next, previous, index, first, last, hide, clear.",
    promptSnippet: "Navigate the kitty image preview with next, previous, indexed, hide, and clear actions.",
    parameters: Type.Object({
      action: stringEnum(["current", "next", "previous", "index", "first", "last", "hide", "clear"], "Preview navigation action."),
      index: Type.Optional(Type.Number({ description: "Zero-based image index for action=index." })),
      config: Type.Optional(Type.Object({
        columns: Type.Optional(Type.Number()),
        rows: Type.Optional(Type.Number()),
        maxRows: Type.Optional(Type.Number()),
        minRows: Type.Optional(Type.Number()),
        zIndex: Type.Optional(Type.Number()),
        background: Type.Optional(Type.Boolean()),
        showCaption: Type.Optional(Type.Boolean()),
        clearPrevious: Type.Optional(Type.Boolean()),
        placement: Type.Optional(stringEnum(PREVIEW_PLACEMENTS, "Where Pi should mount the preview: above/below the editor widget, or a fixed right-side overlay.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode.")),
        placementMode: Type.Optional(stringEnum(["auto", "unicode", "cursor"], "Graphics placement mode. auto uses Unicode placeholders inside tmux.")),
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      applyConfig(state, params.config);
      if (params.action === "clear") {
        state.lastDeleteCommand = buildDeleteCommand({ deleteMode: "A", passthrough: state.config.passthrough });
        state.visible = false;
        state.items = [];
        state.index = 0;
        state.currentCommand = undefined;
        syncWidget(ctx, state);
        stopAnimation(state);
        flashDeleteWidget(ctx, state, state.lastDeleteCommand);
        return { content: [{ type: "text", text: "Cleared kitty image preview." }], details: makeDetails(state) };
      }
      if (params.action === "hide") {
        state.lastDeleteCommand = buildDeleteCommand({ deleteMode: "A", passthrough: state.config.passthrough });
        state.visible = false;
        stopAnimation(state);
        flashDeleteWidget(ctx, state, state.lastDeleteCommand);
        return { content: [{ type: "text", text: "Hid kitty image preview." }], details: makeDetails(state) };
      }
      if (state.items.length === 0) throw new Error("No images have been added yet.");
      if (params.action === "next") state.index = (state.index + 1) % state.items.length;
      if (params.action === "previous") state.index = (state.index - 1 + state.items.length) % state.items.length;
      if (params.action === "first") state.index = 0;
      if (params.action === "last") state.index = state.items.length - 1;
      if (params.action === "index") state.index = clampInteger(params.index, state.index, 0, state.items.length - 1);
      state.visible = true;
      await prepareCurrentImage(state, ctx, { forceReload: true });
      syncWidget(ctx, state);
      return { content: makeContent(state), details: makeDetails(state) };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_animate",
    label: "Kitty Image Preview Animate",
    description: "Start or stop lightweight animation by cycling the loaded preview image series in the persistent kitty widget.",
    promptSnippet: "Animate a loaded kitty image series by cycling preview frames at an interval.",
    parameters: Type.Object({
      action: stringEnum(["start", "stop"], "Animation control action."),
      intervalMs: Type.Optional(Type.Number({ description: "Frame interval in milliseconds. Defaults to 250; minimum 50." })),
      loop: Type.Optional(Type.Boolean({ description: "Loop when the end of the series is reached. Defaults to true." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "stop") {
        stopAnimation(state);
        syncWidget(ctx, state);
        return { content: [{ type: "text", text: "Stopped kitty image preview animation." }], details: makeDetails(state) };
      }
      if (state.items.length === 0) throw new Error("No images have been added yet.");
      state.visible = true;
      await prepareCurrentImage(state, ctx, { forceReload: true });
      startAnimation(state, ctx, {
        intervalMs: clampInteger(params.intervalMs, 250, 50, 60_000),
        loop: params.loop !== false,
      });
      syncWidget(ctx, state);
      return {
        content: makeContent(state, [`Started animation at ${state.animation.intervalMs}ms per frame.`]),
        details: makeDetails(state, { animation: { ...state.animation } }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_status",
    label: "Kitty Image Preview Status",
    description: "Report the current kitty image preview state, terminal passthrough detection, and loaded image list.",
    promptSnippet: "Inspect current kitty image preview state and loaded image list.",
    parameters: Type.Object({}),
    async execute() {
      const snapshot = serializePublicState(state);
      const lines = [
        summarizeCurrent(state),
        `visible=${state.visible} images=${state.items.length} passthroughDetected=${detectKittyPassthroughMode(process.env)} memoryAuto=${shouldUseInMemoryTransfer(process.env)}`,
        ...state.items.map((item, index) => `${index === state.index ? "→" : " "} ${index}: ${item.label}`),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { kittyImagePreviewState: snapshot },
      };
    },
  });

  pi.registerCommand("kitty-image-preview", {
    description: "Show kitty image preview extension status and quick usage.",
    handler: async (_args, ctx) => {
      syncWidget(ctx, state);
      ctx.ui.notify(summarizeCurrent(state), "info");
    },
  });
}
