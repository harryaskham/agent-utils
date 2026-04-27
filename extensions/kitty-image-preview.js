import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

import {
  buildDeleteCommand,
  buildPngDisplayCommand,
  detectKittyPassthroughMode,
  estimateRowsForImage,
  fileToBase64,
  isSupportedKittyPngPath,
  readPngDimensions,
  shouldUseInMemoryTransfer,
  stableKittyImageId,
} from "./kitty-graphics.js";

const TOOL_PREFIX = "kitty_image_preview";
const WIDGET_ID = "kitty-image-preview";
const DEFAULT_Z_INDEX = -10;
const DEFAULT_BG_Z_INDEX = -1073741824;
const DEFAULT_COLUMNS = 48;
const DEFAULT_MAX_ROWS = 24;
const SUPPORTED_EXTENSIONS = new Set([".png", ".apng"]);

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
  return `Showing ${state.index + 1}/${state.items.length}: ${current.label}${dims}; placement=${state.config.placement}, transfer=${mode}, z=${state.config.zIndex}.`;
}

function renderPlaceholderLines(width, rows, text) {
  const line = " ".repeat(Math.max(1, width));
  const output = Array.from({ length: Math.max(1, rows) }, () => line);
  if (text) output[0] = `${text}${line}`.slice(0, Math.max(1, width));
  return output;
}

class KittyImagePreviewWidget {
  constructor(state) {
    this.state = state;
  }

  render(width) {
    const state = this.state;
    if (!state.visible || state.items.length === 0) return [];
    const current = state.items[state.index];
    const columns = Math.min(width, clampInteger(state.config.columns, DEFAULT_COLUMNS, 1, 4096));
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
      200,
    );

    const command = buildCurrentDisplayCommand(state, current, columns, rows);
    const label = state.config.showCaption
      ? `kitty image ${state.index + 1}/${state.items.length}: ${current.label}`
      : "";
    const lines = renderPlaceholderLines(width, rows, label);
    lines[0] = `${state.lastDeleteCommand || ""}${command}${lines[0]}`;
    state.lastDeleteCommand = "";
    return lines;
  }

  invalidate() {}
}

function syncWidget(ctx, state) {
  if (!ctx?.hasUI) return;
  if (!state.visible || state.items.length === 0) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    ctx.ui.setStatus(WIDGET_ID, undefined);
    return;
  }
  const componentFactory = () => new KittyImagePreviewWidget(state);
  ctx.ui.setWidget(WIDGET_ID, componentFactory, { placement: state.config.placement });
  const current = state.items[state.index];
  const animation = state.animation?.running ? " ▶" : "";
  ctx.ui.setStatus(WIDGET_ID, `🖼${animation} ${state.index + 1}/${state.items.length} ${current?.label ?? ""}`);
}

function flashDeleteWidget(ctx, state, deleteCommand) {
  if (!ctx?.hasUI) return;
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

function buildCurrentDisplayCommand(state, current, columns, rows) {
  const prepared = state.currentCommand;
  if (!prepared || prepared.itemId !== current.id) return "";
  const signature = `${columns}:${rows}:${prepared.zIndex}:${prepared.transport}:${prepared.passthrough}:${prepared.chunkSize}`;
  if (prepared.rendered?.signature === signature) return prepared.rendered.command;
  const command = buildPngDisplayCommand({
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
  if (["aboveEditor", "belowEditor"].includes(config.placement)) state.config.placement = config.placement;
  if (["auto", "memory", "file"].includes(config.transferMode)) state.config.transferMode = config.transferMode;
  if (["auto", "tmux", "none"].includes(config.passthrough)) state.config.passthrough = config.passthrough;
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
        placement: Type.Optional(stringEnum(["aboveEditor", "belowEditor"], "Where Pi should mount the widget.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport. auto uses memory inside tmux, file otherwise.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode. auto detects tmux.")),
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
        placement: Type.Optional(stringEnum(["aboveEditor", "belowEditor"], "Where Pi should mount the widget.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode.")),
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
        placement: Type.Optional(stringEnum(["aboveEditor", "belowEditor"], "Where Pi should mount the widget.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode.")),
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
