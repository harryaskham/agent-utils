// Visual thoughts: while the agent works, a fast model draws image prompts from its output, an
// image model paints them, and the images crossfade as a backdrop behind the text: TUI Pi's whole
// screen, or each pi-client pane (its backdrop, `ctx.ui.backdrop()`), painting that pane's
// session. See docs/visual-thoughts.md.
//
//   /thoughts                 status
//   /thoughts on|off|toggle   start or stop for this session
//   /thoughts now             paint from the current output now
//   /thoughts next            crossfade to the next image
//   /thoughts clear           drop the images (the files stay)
//   /thoughts <key> <value>   change a setting for this session (opacity 0.4, fit contain, …)
import { appendFileSync } from "node:fs";

import { readAgentSettings, agentSettingsPath } from "./pi-graphics/agent-io.js";
import { captureTuiFromUi } from "./pi-graphics/host-components.js";
import { runPiTextTurn } from "./lib/pi-inference.js";
import { parseSettingChange, resolveVisualThoughtsConfig } from "./lib/visual-thoughts/config.js";
import { createVisualThoughtsEngine } from "./lib/visual-thoughts/engine.js";
import { createImageProvider } from "./lib/visual-thoughts/image-provider.js";
import { litellmChat } from "./lib/visual-thoughts/litellm-chat.js";
import { toolCallDigest } from "./lib/visual-thoughts/prompter.js";
import { createImageStore, visualThoughtsStateDir } from "./lib/visual-thoughts/store.js";
import { createTuiBackdropSurface } from "./lib/visual-thoughts/tui-surface.js";

const STATUS_KEY = "visual-thoughts";
const PROVIDER_KEYS = new Set(["provider", "imageModel", "size", "quality", "baseUrl", "apiKeyEnv", "maiEndpoint", "maiAuth", "maiKeyEnv"]);

export function resolvePromptModel(registry, reference) {
  const raw = String(reference || "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) throw new Error(`prompt model must be provider/id (got '${raw}')`);
  const model = registry?.find?.(raw.slice(0, slash), raw.slice(slash + 1));
  if (!model) throw new Error(`prompt model not available: ${raw}`);
  return model;
}

function describeStatus(status, config) {
  const parts = [status.enabled ? "on" : "off"];
  if (status.enabled) {
    parts.push(status.activity === "idle" ? (status.inRun ? "watching" : "idle") : status.activity);
    parts.push(`${status.images} image${status.images === 1 ? "" : "s"}`);
    if (status.waitMs > 1_000 && status.activity === "idle") parts.push(`next in ${Math.round(status.waitMs / 1000)}s`);
  }
  const lines = [
    `visual thoughts: ${parts.join(", ")}`,
    `  painting with ${status.provider || config.imageModel}; prompts from ${config.promptModel}`,
    `  ${config.fit}, opacity ${config.opacity}, feather ${config.feather}, hold ${config.holdMs / 1000}s, fade ${config.fadeMs / 1000}s`,
  ];
  if (status.generated) lines.push(`  ${status.generated} painted this session; last took ${(status.lastMs / 1000).toFixed(1)}s`);
  if (status.stats?.frames) lines.push(`  transitions: ${config.effect}, ${config.fps} fps target, ${status.stats.frameMs.toFixed(1)} ms/frame ${status.stats.threaded ? "on a worker thread" : "in Pi's thread"}, frames by ${status.stats.transport}`);
  if (status.prompt) lines.push(`  last prompt: ${status.prompt.slice(0, 200)}`);
  if (status.lastError) lines.push(`  last error: ${status.lastError}`);
  return lines.join("\n");
}

/** A pi-client pane's backdrop (`ctx.ui.backdrop()`) as the engine's surface. */
export function hostSurface(backdrop, { config, onResize, onLost, onClose }) {
  const subscriptions = [
    backdrop.onResize?.(onResize),
    backdrop.onLost?.(onLost),
    backdrop.onClose?.(onClose),
  ].filter((stop) => typeof stop === "function");
  return {
    size: () => backdrop.size() ?? null,
    transport: () => backdrop.transport(),
    has: (key) => backdrop.has(key),
    upload: (key, payload) => backdrop.upload(key, payload),
    show: (key) => backdrop.show(key, { layer: config.layer === "under" ? "under" : "over" }),
    get shown() { return backdrop.shown; },
    drop: (key) => backdrop.drop(key),
    clear: () => backdrop.clear(),
    dispose() {
      for (const stop of subscriptions) { try { stop(); } catch {} }
      try { backdrop.clear(); } catch {}
    },
  };
}

export function createVisualThoughtsExtension({ settings, env = process.env, fetchImpl, completeImpl, now } = {}) {
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

    const notify = (message, level = "info", ctx = lastCtx) => { try { ctx?.ui?.notify?.(message, level); } catch {} };
    const warnOnce = (message) => {
      const key = String(message).replace(/\d+/g, "#").slice(0, 120);
      if (warned.has(key)) return;
      warned.add(key);
      notify(message, "warning");
    };
    const providerFor = () => createImageProvider(config, { env, ...(fetchImpl ? { fetchImpl } : {}) });

    /** The prompt model: Pi's registry where there is one, else the chat endpoint (pi-client). */
    async function promptTurn(request, signal) {
      const ctx = lastCtx;
      const reference = String(config.promptModel || "");
      if (!reference.startsWith("litellm/") && typeof ctx?.modelRegistry?.find === "function") {
        const model = resolvePromptModel(ctx.modelRegistry, reference);
        const response = await runPiTextTurn(ctx, { model, ...request, signal, completeImpl, abortedMessage: "visual thoughts prompt superseded" });
        return response.text;
      }
      const model = reference.startsWith("litellm/") ? reference.slice("litellm/".length) : config.clientPromptModel;
      return litellmChat({
        model, request, signal,
        baseUrl: config.baseUrl || env.LITELLM_BASE_URL || env.LITELLM_PROXY_URL,
        apiKey: env[config.apiKeyEnv || "LITELLM_MASTER_KEY"],
        ...(fetchImpl ? { fetchImpl } : {}),
      });
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
      try { pane.engine.dispose(); } catch {}
      try { pane.surface.dispose?.(); } catch {}
    }

    /** The pane `ctx` refers to: its pi-client backdrop, or TUI Pi's screen ("tui"). */
    function paneKey(ctx) {
      if (typeof ctx?.ui?.backdrop !== "function") return { key: "tui", backdrop: null };
      const backdrop = ctx.ui.backdrop();
      if (!backdrop) throw new Error("this pi-client cannot draw backdrops here (needs full screen and kitty graphics, not tmux)");
      return { key: backdrop, backdrop };
    }

    /** A new surface for the pane; throws where none can be drawn. */
    function makeSurface(ctx, backdrop, holder) {
      if (backdrop) {
        return hostSurface(backdrop, {
          config,
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
      return createTuiBackdropSurface({ tui, env, options: () => config, onResize: () => holder.current?.engine.resized(), onLost: () => holder.current?.engine.lost() });
    }

    /** The pane `ctx` refers to (made, or made afresh for a new session), focused: the others hold still. */
    function focus(ctx) {
      if (config.incognito) throw new Error("visual thoughts are off in incognito sessions");
      const { key, backdrop } = paneKey(ctx);
      const sessionId = sessionOf(ctx);
      let pane = panes.get(key);
      if (pane && pane.sessionId !== sessionId) { disposePane(pane); pane = null; }
      if (!pane) {
        const holder = { current: null };
        const surface = makeSurface(ctx, backdrop, holder);
        const store = createImageStore({ root: visualThoughtsStateDir(env), sessionId });
        pane = { key, sessionId, surface, engine: null };
        holder.current = pane;
        const made = pane;
        pane.engine = createVisualThoughtsEngine({
          config,
          surface,
          store,
          ...(now ? { now } : {}),
          provider: providerFor(),
          promptTurn,
          warn: warnOnce,
          ...(env.PI_VISUAL_THOUGHTS_TRACE ? { trace: (line) => appendFileSync(env.PI_VISUAL_THOUGHTS_TRACE, `${line}\n`) } : {}),
          onChange: (status) => {
            if (focused !== made) return;
            try { lastCtx?.ui?.setStatus?.(STATUS_KEY, status.enabled && status.activity !== "idle" ? `✧ ${status.activity}` : undefined); } catch {}
          },
        });
        panes.set(key, pane);
        pane.engine.setEnabled(enabled);
        store.recent(config.maxImages).then((records) => made.engine.restore(records)).catch(() => {});
        seedSoon(pane, ctx);
      }
      if (focused !== pane) {
        focused = pane;
        for (const other of panes.values()) other.engine.pause(other !== pane);
      }
      return pane;
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
        for (const { kind, text } of recentConversation(ctx)) pane.engine.output(kind, text);
        pane.engine.generateNow();
      }, 1_500).unref?.();
    }

    function setEnabled(ctx, on) {
      if (!on) {
        enabled = false;
        for (const pane of panes.values()) pane.engine.setEnabled(false);
        try { ctx?.ui?.setStatus?.(STATUS_KEY, undefined); } catch {}
        return true;
      }
      try {
        enabled = true;
        const pane = focus(ctx);
        for (const other of panes.values()) other.engine.setEnabled(true);
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
      if (config.enabled && !enabled && !setEnabled(ctx, true)) warnOnce(`visual thoughts unavailable: ${unavailable}`);
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
        if (verb === "status") {
          if (unavailable && !pane) return notify(`visual thoughts unavailable: ${unavailable}`, "warning", ctx);
          return notify(describeStatus(pane ? { ...pane.engine.status(), stats: pane.engine.stats() } : { enabled: false }, config), "info", ctx);
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
          config[change.key] = change.value;
          for (const each of panes.values()) each.engine.configure(PROVIDER_KEYS.has(change.key) ? { provider: providerFor() } : {});
          return notify(`visual thoughts: ${change.key} = ${change.value} (this session)`, "info", ctx);
        }
        notify("Usage: /thoughts [on|off|toggle|status|now|next|clear|<setting> <value>]", "warning", ctx);
      },
    });
  };
}

export default createVisualThoughtsExtension();
