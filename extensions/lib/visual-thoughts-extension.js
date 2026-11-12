// Visual thoughts: while the agent works, a fast model draws image prompts from its output, an
// image model paints them, and the images crossfade as a backdrop behind the text: TUI Pi's whole
// screen, or each pi-client pane (its backdrop, `ctx.ui.backdrop()`), painting that pane's
// session. See docs/visual-thoughts.md.
//
// The host-independent core: the Pi entry (extensions/visual-thoughts.js) supplies the running
// Pi's cell size (`host.cellSize`, pi-tui's getCellDimensions) through lib/pi-host.js, so this
// module imports no host package and loads under a bare `node --test`.
//
//   /thoughts                 status
//   /thoughts on|off|toggle   start or stop for this session
//   /thoughts now             paint from the current output now
//   /thoughts next            crossfade to the next image
//   /thoughts clear           drop the images (the files stay)
//   /thoughts <key> <value>   change a setting for this session (opacity 0.4, fit contain, …)
import { appendFileSync } from "node:fs";

import { readAgentSettings, agentSettingsPath } from "../pi-graphics/agent-io.js";
import { captureTuiFromUi } from "../pi-graphics/host-components.js";
import { runPiTextTurn } from "./pi-inference.js";
import { parseSettingChange, resolveVisualThoughtsConfig } from "./visual-thoughts/config.js";
import { createPaintBudget } from "./visual-thoughts/budget.js";
import { createVisualThoughtsEngine } from "./visual-thoughts/engine.js";
import { createImageProvider } from "./visual-thoughts/image-provider.js";
import { chatModels, createChatPrompter } from "./visual-thoughts/litellm-chat.js";
import { toolCallDigest } from "./visual-thoughts/prompter.js";
import { createImageStore, pruneStore, visualThoughtsStateDir } from "./visual-thoughts/store.js";
import { activeCanvas, backdropLayer, createTuiBackdropSurface } from "./visual-thoughts/tui-surface.js";

const STATUS_KEY = "visual-thoughts";
/** pi-daemon's session UI slots document (1.15) and the slot visual thoughts paints. */
const PI_UI_DOC = Object.freeze({ kind: "pi.ui", version: 1, scope: "session" });
const BACKDROP_SLOT = "backdrop";
const EMPTY_SLOT = Object.freeze({ kind: "image-set", images: [], current: 0 });
/** Settings about how this client shows images; the rest is the painter's (the host's, where it paints). */
const LOCAL_KEYS = new Set(["layer", "area", "fps", "effect", "transitionPixels", "transport", "fadeMs", "minShowMs", "canvasOpacity", "canvasBlend"]);
const PROVIDER_KEYS = new Set(["provider", "imageModel", "size", "quality", "baseUrl", "apiKeyEnv", "maiEndpoint", "maiAuth", "maiKeyEnv"]);

export function resolvePromptModel(registry, reference) {
  const raw = String(reference || "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) throw new Error(`prompt model must be provider/id (got '${raw}')`);
  const model = registry?.find?.(raw.slice(0, slash), raw.slice(slash + 1));
  if (!model) throw new Error(`prompt model not available: ${raw}`);
  return model;
}

function describeStatus(status, config, { chain = false, chatModel = "", resting = {} } = {}) {
  const parts = [status.enabled ? "on" : "off"];
  if (status.enabled) {
    parts.push(status.activity === "idle" ? (status.inRun ? "watching" : "idle") : status.activity);
    parts.push(`${status.images} image${status.images === 1 ? "" : "s"}`);
    if (status.waitMs > 1_000 && status.activity === "idle") parts.push(`next in ${Math.round(status.waitMs / 1000)}s`);
  }
  const lines = [
    `visual thoughts: ${parts.join(", ")}`,
    `  painting with ${status.provider || config.imageModel}; prompts from ${chain ? `${chatModel || chatModels(config.clientPromptModel)[0]} (of ${chatModels(config.clientPromptModel).join(", ")}, in turn)` : config.promptModel}`,
    `  ${config.fit}, opacity ${config.opacity}, feather ${config.feather}, hold ${config.holdMs / 1000}s, fade ${config.fadeMs / 1000}s`,
  ];
  if (status.generated) lines.push(`  ${status.generated} painted this session; last took ${(status.lastMs / 1000).toFixed(1)}s`);
  if (status.stats?.frames) lines.push(`  transitions: ${config.effect}, ${config.fps} fps target, ${status.stats.frameMs.toFixed(1)} ms/frame ${status.stats.threaded ? "on a worker thread" : "in Pi's thread"}, frames by ${status.stats.transport}`);
  if (status.prompt) lines.push(`  last prompt: ${status.prompt.slice(0, 200)}`);
  const passedOver = Object.entries(resting);
  if (passedOver.length) lines.push(`  passed over (failed or answered nothing): ${passedOver.map(([model, until]) => `${model} ${Math.ceil((until - Date.now()) / 60_000)} min`).join(", ")}`);
  if (status.lastError) lines.push(`  last error: ${status.lastError}`);
  return lines.join("\n");
}

/** A pi-client pane's backdrop (`ctx.ui.backdrop()`) as the engine's surface. */
export function hostSurface(backdrop, { config, env = process.env, onResize, onLost, onClose }) {
  // pi-client's region (pi-daemon 1.15+): the transcript only, or the whole pane.
  let applied = null;
  const region = () => {
    const want = config.area === "screen" ? "pane" : "transcript";
    if (want === applied || typeof backdrop.region !== "function") return;
    applied = want;
    try { backdrop.region(want); } catch {}
  };
  region();
  const subscriptions = [
    backdrop.onResize?.(onResize),
    backdrop.onLost?.(onLost),
    backdrop.onClose?.(onClose),
  ].filter((stop) => typeof stop === "function");
  return {
    size: () => { region(); return backdrop.size() ?? null; },
    transport: () => backdrop.transport(),
    has: (key) => backdrop.has(key),
    upload: (key, payload) => backdrop.upload(key, payload),
    show: (key) => { region(); return backdrop.show(key, { layer: backdropLayer(config.layer, env) }); },
    get shown() { return backdrop.shown; },
    drop: (key) => backdrop.drop(key),
    clear: () => backdrop.clear(),
    dispose() {
      for (const stop of subscriptions) { try { stop(); } catch {} }
      try { backdrop.clear(); } catch {}
    },
  };
}

export function createVisualThoughtsExtension({ settings, env = process.env, fetchImpl, completeImpl, now, host } = {}) {
  return function visualThoughtsExtension(pi) {
    const startup = settings || readAgentSettings(agentSettingsPath()) || {};
    const config = resolveVisualThoughtsConfig(startup, env);
    // One pane per backdrop: TUI Pi's screen ("tui"), or each pi-client pane (its backdrop).
    // A pane paints its session; switching a pane to another session starts it afresh.
    const panes = new Map(); // key → { key, sessionId, surface, engine }
    let enabled = false;
    let focused = null;
    let lastCtx = null;
    let unavailable = "";
    const warned = new Set();
    // Assistant text seen as deltas (TUI Pi): message_end then adds nothing again.
    let deltasSeen = false;
    let lastUserPrompt = "";
    let pruned = false;

    const notify = (message, level = "info", ctx = lastCtx) => { try { ctx?.ui?.notify?.(message, level); } catch {} };
    const warnOnce = (message) => {
      const key = String(message).replace(/\d+/g, "#").slice(0, 120);
      if (warned.has(key)) return;
      warned.add(key);
      notify(message, "warning");
    };
    const providerFor = (cfg = config) => createImageProvider(cfg, { env, ...(fetchImpl ? { fetchImpl } : {}) });
    // The chat models (clientPromptModel), in turn; one that fails or answers nothing rests 10 min.
    const chat = createChatPrompter({
      models: () => config.clientPromptModel,
      baseUrl: () => config.baseUrl || env.LITELLM_BASE_URL || env.LITELLM_PROXY_URL,
      apiKey: () => env[config.apiKeyEnv || "LITELLM_MASTER_KEY"],
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(now ? { now } : {}),
    });
    // pi-client's panes paint in turn: one budget for the whole client.
    const budget = createPaintBudget({ concurrent: config.budgetConcurrent, perMinute: config.budgetPerMinute, ...(now ? { now } : {}) });

    /** The prompt model: Pi's registry where there is one, else the chat endpoint (pi-client). */
    async function promptTurn(request, signal) {
      const ctx = lastCtx;
      const reference = String(config.promptModel || "");
      if (!reference.startsWith("litellm/") && typeof ctx?.modelRegistry?.find === "function") {
        const model = resolvePromptModel(ctx.modelRegistry, reference);
        const response = await runPiTextTurn(ctx, { model, ...request, signal, completeImpl, abortedMessage: "visual thoughts prompt superseded" });
        return response.text;
      }
      // An explicit litellm/<model> alone; else clientPromptModel's models, in turn.
      return chat.prompt(request, signal, reference.startsWith("litellm/") ? { models: [reference.slice("litellm/".length)] } : {});
    }

    /** When the prompt model answers nothing (or fails): clientPromptModel's models, unless they just did. */
    function fallbackPromptTurn(request, signal) {
      const reference = String(config.promptModel || "");
      const usedChain = !reference.startsWith("litellm/") && typeof lastCtx?.modelRegistry?.find !== "function";
      if (usedChain || !chatModels(config.clientPromptModel).length) return "";
      return chat.prompt(request, signal);
    }

    function sessionOf(ctx) {
      let sessionId = "session";
      try { sessionId = String(ctx?.sessionManager?.getSessionId?.() || sessionId); } catch {}
      // A fixed store (another session's images), e.g. for --no-session runs.
      return env.PI_VISUAL_THOUGHTS_SESSION ? String(env.PI_VISUAL_THOUGHTS_SESSION) : sessionId;
    }

    function disposePane(pane) {
      if (!pane) return;
      panes.delete(pane.key);
      if (focused === pane) focused = null;
      try { pane.stopWatch?.(); } catch {}
      try { pane.engine.dispose(); } catch {}
      try { pane.surface.dispose?.(); } catch {}
      if (paneStatuses(pane)) try { pane.statusCtx.ui.setStatus(STATUS_KEY, undefined); } catch {}
    }

    /** The pane `ctx` refers to: its pi-client backdrop, or TUI Pi's screen ("tui"). */
    function paneKey(ctx) {
      if (typeof ctx?.ui?.backdrop !== "function") return { key: "tui", backdrop: null };
      const backdrop = ctx.ui.backdrop();
      if (!backdrop) throw new Error("this pi-client cannot draw backdrops here (needs full screen and kitty graphics, not tmux)");
      return { key: backdrop, backdrop };
    }

    /** A new surface for the pane; throws where none can be drawn. */
    /**
     * pi-graphics' canvas (gfx-core) as the render backend while it runs: the frames go to the
     * canvas, which places them in its own frames above its background (TUI Pi: the screen; a
     * pi-client pane: its area); otherwise to `base`. A switch empties the other and the engine
     * uploads again. A pi-client without backdrop rects keeps its backdrop.
     */
    function canvasAware(base, holder, backdrop) {
      const CANVAS = Symbol.for("agent-utils.pi-graphics.canvas");
      if (backdrop && typeof backdrop.rect !== "function") return Object.assign(base, { onCanvas: () => false });
      let onCanvas = null;
      let unsubscribe = null;
      const switched = () => queueMicrotask(() => holder.current?.engine.lost());
      const pick = () => {
        const canvas = globalThis[CANVAS];
        if (!unsubscribe && typeof canvas?.subscribe === "function") {
          unsubscribe = canvas.subscribe((event) => { if (event === "start" || event === "stop") pick(); });
        }
        if (canvas?.active && !onCanvas) {
          const surface = canvas.surface?.({
            ...(backdrop ? { rect: () => backdrop.rect() } : {}),
            onResize: () => holder.current?.engine.resized(),
            onLost: () => holder.current?.engine.lost(),
          });
          if (surface) {
            onCanvas = surface;
            try { base.clear(); } catch {}
            switched();
          }
        } else if (!canvas?.active && onCanvas) {
          try { onCanvas.dispose?.(); } catch {}
          onCanvas = null;
          switched();
        }
        return onCanvas || base;
      };
      return {
        size: () => pick().size(),
        transport: () => pick().transport(),
        has: (key) => pick().has(key),
        upload: (key, payload) => pick().upload(key, payload),
        show: (key) => pick().show(key),
        get shown() { return pick().shown; },
        drop: (key) => pick().drop(key),
        clear: () => pick().clear(),
        onCanvas: () => Boolean(onCanvas),
        dispose() {
          try { unsubscribe?.(); } catch {}
          try { onCanvas?.dispose?.(); } catch {}
          base.dispose?.();
        },
      };
    }

    function makeSurface(ctx, backdrop, holder, paneConfig = config) {
      return canvasAware(makeOwnSurface(ctx, backdrop, holder, paneConfig), holder, backdrop);
    }

    function makeOwnSurface(ctx, backdrop, holder, paneConfig = config) {
      if (backdrop) {
        return hostSurface(backdrop, {
          config: paneConfig,
          env,
          onResize: () => holder.current?.engine.resized(),
          onLost: () => holder.current?.engine.lost(),
          onClose: () => disposePane(holder.current),
        });
      }
      const tui = captureTuiFromUi(ctx?.ui);
      if (!tui?.terminal) throw new Error("visual thoughts need Pi's interactive TUI, or pi-client with pane backdrops");
      if (tui.mode !== undefined && tui.mode !== "fullscreen") throw new Error("visual thoughts need Pi's fullscreen TUI mode (/settings → TUI mode)");
      if (env.TMUX && !/^(1|true|on|yes)$/i.test(String(env.PI_VISUAL_THOUGHTS_TMUX || ""))) {
        throw new Error("visual thoughts do not run inside tmux yet (PI_VISUAL_THOUGHTS_TMUX=1 to try)");
      }
      return createTuiBackdropSurface({
        tui, env, options: () => paneConfig,
        ...(typeof host?.cellSize === "function" ? { cellSize: host.cellSize } : {}),
        onResize: () => holder.current?.engine.resized(),
        onLost: () => holder.current?.engine.lost(),
      });
    }

    /** Whether a pane's statuses are its own (pi-client's pinned ctx): its footer only. */
    function paneStatuses(pane) {
      return pane?.statusCtx?.ui?.statusScope === "pane";
    }

    /**
     * A pane's "painting"/"prompting" status: in its own footer where pi-client keeps pane statuses,
     * else (one status for the whole client) only for the focused pane.
     */
    function showStatus(pane) {
      if (!pane) return;
      const status = pane.engine?.status?.();
      const text = status?.enabled && status.activity !== "idle" ? `✧ ${status.activity}` : undefined;
      if (paneStatuses(pane)) {
        try { pane.statusCtx.ui.setStatus(STATUS_KEY, text); } catch {}
        return;
      }
      if (focused !== pane) return;
      try { lastCtx?.ui?.setStatus?.(STATUS_KEY, text); } catch {}
    }

    /** The pane `ctx` refers to (made, or made afresh for a new session), focused: the others hold still. */
    function focus(ctx) {
      if (config.incognito) throw new Error("visual thoughts are off in incognito sessions");
      const { key, backdrop } = paneKey(ctx);
      const sessionId = sessionOf(ctx);
      let pane = panes.get(key);
      if (pane && pane.sessionId !== sessionId) { disposePane(pane); pane = null; }
      if (!pane) {
        // Once per process: sessions long gone, and an over-full store, are cleared away.
        if (!pruned) { pruned = true; pruneStore(visualThoughtsStateDir(env), { keep: sessionId }).catch(() => {}); }
        const holder = { current: null };
        // Each pane its own settings (pi-client: `/thoughts opacity 1` is that pane's session's).
        const paneConfig = { ...config };
        const surface = makeSurface(ctx, backdrop, holder, paneConfig);
        const store = createImageStore({ root: visualThoughtsStateDir(env), sessionId });
        pane = { key, sessionId, surface, store, config: paneConfig, off: false, engine: null, host: false, stopWatch: null };
        holder.current = pane;
        const made = pane;
        // pi-client: the pane's own ctx, so slot reads and media follow this pane's session.
        const paneCtx = typeof ctx?.pinned === "function" ? ctx.pinned() : ctx;
        pane.engine = createVisualThoughtsEngine({
          config: paneConfig,
          surface,
          store,
          ...(now ? { now } : {}),
          provider: providerFor(paneConfig),
          promptTurn,
          fallbackPromptTurn,
          budget,
          warn: warnOnce,
          // Blended into pi-graphics' canvas (TUI Pi's /gfx full), stronger.
          // On pi-graphics' canvas: stronger, its dark parts giving way to the canvas's background.
          look: () => {
            const onCanvas = surface.onCanvas?.() === true;
            return {
              fit: paneConfig.fit,
              feather: paneConfig.feather,
              opacity: onCanvas || (!backdrop && activeCanvas()) ? paneConfig.canvasOpacity : paneConfig.opacity,
              luminanceAlpha: onCanvas ? paneConfig.canvasBlend : 0,
            };
          },
          ...(env.PI_VISUAL_THOUGHTS_TRACE ? { trace: (line) => appendFileSync(env.PI_VISUAL_THOUGHTS_TRACE, `${line}\n`) } : {}),
          fetchImage: async (uri) => {
            const item = await paneCtx?.sessionMedia?.(uri);
            return item?.data ? Buffer.from(item.data, "base64") : null;
          },
          onChange: () => showStatus(made),
        });
        pane.statusCtx = paneCtx;
        panes.set(key, pane);
        pane.engine.setEnabled(enabled);
        if (paneCtx?.chord) void followHost(made, paneCtx);
        else {
          store.recent(config.maxImages).then((records) => made.engine.restore(records)).catch(() => {});
          seedSoon(pane, ctx);
        }
      }
      if (focused !== pane) {
        const before = focused;
        focused = pane;
        for (const other of panes.values()) other.engine.pause(other !== pane);
        // Client-wide statuses (TUI Pi, older pi-client) say what the focused pane does.
        if (!paneStatuses(pane) && before) showStatus(pane);
      }
      return pane;
    }

    /**
     * pi-client: when the session's host runs the visual-thoughts module (pi-daemon 1.15+), the
     * host paints, once for every client, into the session's backdrop slot, and this pane only
     * shows it (empty until the session paints: never a painting of its own as well). Otherwise (a
     * profile without the module, a TUI Pi session through the bridge) the pane paints locally.
     */
    async function followHost(pane, paneCtx) {
      let capable = false;
      try {
        const commands = await paneCtx.chord.call("session.commands", {});
        capable = (commands?.items || []).some((item) => item?.name === "thoughts" && item?.kind === "extension");
      } catch {}
      if (panes.get(pane.key) !== pane) return;
      pane.paneCtx = paneCtx;
      if (!capable) return void paintHere(pane);
      pane.capable = true;
      pane.host = true;
      void pane.engine.syncSlot(EMPTY_SLOT);
      // Until the host paints the session, its stored images (from before) show; nothing paints here.
      pane.store.recent(config.maxImages).then((records) => { if (panes.get(pane.key) === pane) pane.engine.restore(records); }).catch(() => {});
      await watchSlot(pane);
    }

    /** Local painting for a pane: its stored images back, and a first one from the conversation. */
    function paintHere(pane) {
      if (pane.local) return;
      pane.local = true;
      pane.store.recent(config.maxImages).then((records) => pane.engine.restore(records)).catch(() => {});
      seedSoon(pane, pane.paneCtx);
    }

    function slotValue(pane, value) {
      if (panes.get(pane.key) !== pane) return;
      const slot = value?.slots?.[BACKDROP_SLOT];
      void pane.engine.syncSlot(slot?.kind === "image-set" ? slot : EMPTY_SLOT);
    }

    /**
     * Follow the pane's backdrop slot (again). pi-client's document watches end with their
     * connection, so each agent run starts and ends with a fresh one (a snapshot of the slot: a
     * revision already shown changes nothing).
     */
    async function watchSlot(pane) {
      if (!pane?.capable || panes.get(pane.key) !== pane) return;
      const generation = (pane.watchGeneration || 0) + 1;
      pane.watchGeneration = generation;
      try { pane.stopWatch?.(); } catch {}
      pane.stopWatch = null;
      try {
        const stop = await pane.paneCtx.chord.watchDocument(PI_UI_DOC, (value) => {
          if (pane.watchGeneration === generation) slotValue(pane, value);
        });
        if (panes.get(pane.key) === pane && pane.watchGeneration === generation) pane.stopWatch = stop;
        else stop?.();
      } catch (error) {
        warnOnce(`visual thoughts: cannot follow this session's backdrop: ${error?.message || error}`);
      }
    }

    /** The focused pane, when its host can paint: refollow its slot; true when the host paints it. */
    function refollow(ctx) {
      if (!enabled) return false;
      let pane = null;
      try { pane = focus(ctx); } catch { return false; }
      if (!pane?.capable) return false;
      void watchSlot(pane);
      return pane.host;
    }

    /** The conversation's latest text, to paint something at once when nothing shows yet. */
    function recentConversation(ctx, limit = 3_000) {
      let entries = [];
      try { entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || []; } catch {}
      const texts = [];
      let size = 0;
      for (let i = entries.length - 1; i >= 0 && size < limit; i -= 1) {
        const message = entries[i]?.message;
        if (message?.role !== "assistant" && message?.role !== "user") continue;
        const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
        const text = content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
        if (!text) continue;
        texts.unshift({ kind: message.role === "user" ? "user" : "text", text: text.slice(-limit) });
        size += text.length;
      }
      return texts;
    }

    function seedSoon(pane, ctx) {
      if (!enabled) return;
      setTimeout(() => {
        if (!pane.engine.enabled || panes.get(pane.key) !== pane || pane.engine.status().images) return;
        // Nothing said yet (a new session): the first run paints.
        const conversation = recentConversation(ctx);
        if (!conversation.length) return;
        for (const { kind, text } of conversation) pane.engine.output(kind, text);
        pane.engine.generateNow();
      }, 1_500).unref?.();
    }

    function setEnabled(ctx, on) {
      if (!on) {
        enabled = false;
        for (const pane of panes.values()) {
          pane.engine.setEnabled(false);
          if (paneStatuses(pane)) try { pane.statusCtx.ui.setStatus(STATUS_KEY, undefined); } catch {}
        }
        try { ctx?.ui?.setStatus?.(STATUS_KEY, undefined); } catch {}
        return true;
      }
      try {
        enabled = true;
        const pane = focus(ctx);
        for (const other of panes.values()) other.engine.setEnabled(!other.off);
        seedSoon(pane, ctx);
        unavailable = "";
        return true;
      } catch (error) {
        enabled = false;
        unavailable = error?.message || String(error);
        return false;
      }
    }

    /** The focused pane's engine for an event, when painting. */
    function current(ctx) {
      if (!enabled) return null;
      try { return focus(ctx).engine; } catch { return null; }
    }

    pi.on("session_start", async (_event, ctx) => {
      lastCtx = ctx;
      // Enabled by settings where it cannot draw (tmux, no fullscreen, headless): quietly off;
      // /thoughts says why.
      if (config.enabled && !enabled) setEnabled(ctx, true);
      else if (enabled) { try { focus(ctx); } catch {} }
    });

    pi.on("before_agent_start", async (event, ctx) => {
      lastCtx = ctx;
      const engine = current(ctx);
      if (!engine || event?.messageType !== "user" || !event.prompt) return;
      lastUserPrompt = String(event.prompt).slice(0, 600);
      engine.output("user", lastUserPrompt);
    });

    pi.on("agent_start", async (_event, ctx) => {
      lastCtx = ctx || lastCtx;
      if (refollow(lastCtx)) return;
      current(lastCtx)?.runStart();
    });

    pi.on("message_start", async () => { deltasSeen = false; });

    pi.on("message_update", async (event, ctx) => {
      const update = event?.assistantMessageEvent;
      if (!update || typeof update.delta !== "string") return;
      const engine = current(ctx || lastCtx);
      if (!engine) return;
      if (update.type === "text_delta") { deltasSeen = true; engine.output("text", update.delta); }
      else if (update.type === "thinking_delta") { deltasSeen = true; engine.output("thinking", update.delta); }
    });

    // pi-client sends no deltas: whole messages, as they end.
    pi.on("message_end", async (event, ctx) => {
      const message = event?.message;
      const engine = current(ctx || lastCtx);
      if (!engine || !message) return;
      const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
      if (message.role === "user") {
        const text = parts.filter((part) => part?.type === "text").map((part) => part.text).join("\n").slice(0, 600);
        if (text && text !== lastUserPrompt) engine.output("user", text);
        lastUserPrompt = "";
        return;
      }
      if (message.role !== "assistant" || deltasSeen) return;
      for (const part of parts) {
        if (part?.type === "thinking" && typeof part.thinking === "string") engine.output("thinking", part.thinking);
        else if (part?.type === "text" && typeof part.text === "string") engine.output("text", part.text);
      }
    });

    pi.on("tool_execution_start", async (event, ctx) => {
      current(ctx || lastCtx)?.output("tool", `${toolCallDigest(event?.toolName, event?.args)}\n`);
    });

    pi.on("agent_end", async (_event, ctx) => {
      lastCtx = ctx || lastCtx;
      if (refollow(lastCtx)) return;
      current(lastCtx)?.runEnd();
    });

    pi.on("session_shutdown", async () => {
      for (const pane of [...panes.values()]) disposePane(pane);
      try { lastCtx?.ui?.setStatus?.(STATUS_KEY, undefined); } catch {}
    });

    pi.registerCommand("thoughts", {
      description: "Visual thoughts: images of the agent's work crossfading behind the screen (on|off|now|next|clear|<setting> <value>)",
      handler: async (args, ctx) => {
        lastCtx = ctx;
        const words = String(args || "").trim().split(/\s+/).filter(Boolean);
        const verb = (words[0] || "status").toLowerCase();
        let pane = null;
        if (enabled) { try { pane = focus(ctx); } catch {} }
        // pi-client, a session its host paints: the host's /thoughts module decides what is painted
        // (for every client); only how this pane shows it stays here.
        const local = words.length >= 2 && LOCAL_KEYS.has(parseSettingChange(words[0], words.slice(1).join(" ")).key);
        if (pane?.host && !local) {
          // The host empties the slot; what this pane shows from before goes too.
          if (verb === "off" || verb === "clear") pane.engine.clear();
          if (verb === "status") notify(`this pane: ${pane.engine.status().images} image(s) from the session's backdrop slot; showing ${pane.engine.status().current || "nothing yet"}`, "info", ctx);
          try { ctx.sendUserMessage?.(`/thoughts ${String(args || "").trim()}`.trim()); }
          catch (error) { notify(`visual thoughts: ${error?.message || error}`, "warning", ctx); }
          return;
        }
        if (verb === "status") {
          if (unavailable && !pane) return notify(`visual thoughts unavailable: ${unavailable}`, "warning", ctx);
          return notify(describeStatus(pane ? { ...pane.engine.status(), stats: pane.engine.stats() } : { enabled: false }, pane ? pane.config : config, {
            chain: !String((pane ? pane.config : config).promptModel || "").startsWith("litellm/") && typeof ctx?.modelRegistry?.find !== "function",
            chatModel: chat.lastModel,
            resting: chat.resting(),
          }), "info", ctx);
        }
        // pi-client panes (not TUI Pi's one screen): on/off and settings are the pane's own.
        const own = pane && pane.key !== "tui" ? pane : null;
        if (own && enabled && (verb === "on" || verb === "off" || verb === "toggle")) {
          own.off = verb === "toggle" ? !own.off : verb === "off";
          own.engine.setEnabled(!own.off);
          return notify(own.off ? "visual thoughts off in this pane" : `visual thoughts on in this pane: painting with ${own.config.imageModel}`, "info", ctx);
        }
        if (verb === "on" || verb === "off" || verb === "toggle") {
          const on = verb === "toggle" ? !enabled : verb === "on";
          if (!setEnabled(ctx, on)) return notify(`visual thoughts unavailable: ${unavailable}`, "warning", ctx);
          return notify(on ? `visual thoughts on: painting with ${config.imageModel}` : "visual thoughts off", "info", ctx);
        }
        if (verb === "now") {
          if (!enabled && !setEnabled(ctx, true)) return notify(`visual thoughts unavailable: ${unavailable}`, "warning", ctx);
          const engine = focus(ctx).engine;
          return notify(engine.generateNow() ? "painting from the current output" : `not now: ${engine.status().waitMs > 0 ? `next in ${Math.ceil(engine.status().waitMs / 1000)}s` : "already painting"}`, "info", ctx);
        }
        if (verb === "next") { pane?.engine.next(); return; }
        if (verb === "clear") { pane?.engine.clear(); return notify("visual thoughts cleared", "info", ctx); }
        if (words.length >= 2) {
          const change = parseSettingChange(words[0], words.slice(1).join(" "));
          if (change.error) return notify(`/thoughts: ${change.error}`, "warning", ctx);
          const targets = own ? [own] : [...panes.values()];
          if (!own) config[change.key] = change.value;
          for (const each of targets) {
            each.config[change.key] = change.value;
            each.engine.configure(PROVIDER_KEYS.has(change.key) ? { provider: providerFor(each.config) } : {});
          }
          return notify(`visual thoughts: ${change.key} = ${change.value} (${own ? "this pane" : "this session"})`, "info", ctx);
        }
        notify("Usage: /thoughts [on|off|toggle|status|now|next|clear|<setting> <value>]", "warning", ctx);
      },
    });
  };
}
