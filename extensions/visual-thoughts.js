// Visual thoughts (TUI Pi): while the agent works, a fast model draws image prompts from its
// output, an image model paints them, and the images crossfade as a backdrop behind the whole
// screen. See docs/visual-thoughts.md.
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

export function createVisualThoughtsExtension({ settings, env = process.env, fetchImpl, completeImpl, now } = {}) {
  return function visualThoughtsExtension(pi) {
    const startup = settings || readAgentSettings(agentSettingsPath()) || {};
    const config = resolveVisualThoughtsConfig(startup, env);
    let engine = null;
    let surface = null;
    let lastCtx = null;
    let unavailable = "";
    const warned = new Set();

    const notify = (message, level = "info", ctx = lastCtx) => { try { ctx?.ui?.notify?.(message, level); } catch {} };
    const warnOnce = (message) => {
      const key = String(message).replace(/\d+/g, "#").slice(0, 120);
      if (warned.has(key)) return;
      warned.add(key);
      notify(message, "warning");
    };

    function ensure(ctx) {
      if (engine) return engine;
      if (config.incognito) throw new Error("visual thoughts are off in incognito sessions");
      const tui = captureTuiFromUi(ctx?.ui);
      if (!tui?.terminal) throw new Error("visual thoughts need Pi's interactive TUI");
      if (tui.mode !== undefined && tui.mode !== "fullscreen") throw new Error("visual thoughts need Pi's fullscreen TUI mode (/settings → TUI mode)");
      if (env.TMUX && !/^(1|true|on|yes)$/i.test(String(env.PI_VISUAL_THOUGHTS_TMUX || ""))) {
        throw new Error("visual thoughts do not run inside tmux yet (PI_VISUAL_THOUGHTS_TMUX=1 to try)");
      }
      surface = createTuiBackdropSurface({ tui, env, options: () => config, onResize: () => engine?.resized(), onLost: () => engine?.lost() });
      let sessionId = "session";
      try { sessionId = String(ctx.sessionManager?.getSessionId?.() || sessionId); } catch {}
      // A fixed store (another session's images), e.g. for --no-session runs.
      if (env.PI_VISUAL_THOUGHTS_SESSION) sessionId = String(env.PI_VISUAL_THOUGHTS_SESSION);
      const store = createImageStore({ root: visualThoughtsStateDir(env), sessionId });
      engine = createVisualThoughtsEngine({
        config,
        surface,
        store,
        ...(now ? { now } : {}),
        provider: createImageProvider(config, { env, ...(fetchImpl ? { fetchImpl } : {}) }),
        promptTurn: async (request, signal) => {
          const current = lastCtx || ctx;
          const model = resolvePromptModel(current?.modelRegistry, config.promptModel);
          const response = await runPiTextTurn(current, { model, ...request, signal, completeImpl, abortedMessage: "visual thoughts prompt superseded" });
          return response.text;
        },
        warn: warnOnce,
        ...(env.PI_VISUAL_THOUGHTS_TRACE ? { trace: (line) => appendFileSync(env.PI_VISUAL_THOUGHTS_TRACE, `${line}\n`) } : {}),
        onChange: (status) => {
          try { lastCtx?.ui?.setStatus?.(STATUS_KEY, status.enabled && status.activity !== "idle" ? `✧ ${status.activity}` : undefined); } catch {}
        },
      });
      store.recent(config.maxImages).then((records) => engine?.restore(records)).catch(() => {});
      return engine;
    }

    /** The conversation's latest assistant text, to paint something at once when switched on. */
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

    function enable(ctx, on) {
      if (!on) { engine?.setEnabled(false); return true; }
      try {
        const running = ensure(ctx);
        const wasOn = running.enabled;
        running.setEnabled(true);
        unavailable = "";
        if (!wasOn) {
          // Something to paint straight away: the conversation so far, when nothing is showing yet.
          setTimeout(() => {
            if (!engine?.enabled || engine.status().images) return;
            for (const { kind, text } of recentConversation(ctx)) engine.output(kind, text);
            engine.generateNow();
          }, 1_500).unref?.();
        }
        return true;
      } catch (error) {
        unavailable = error?.message || String(error);
        return false;
      }
    }

    pi.on("session_start", async (_event, ctx) => {
      lastCtx = ctx;
      if (config.enabled && !enable(ctx, true)) warnOnce(unavailable);
    });

    pi.on("before_agent_start", async (event, ctx) => {
      lastCtx = ctx;
      if (!engine?.enabled) return;
      engine.runStart();
      if (event?.messageType === "user" && event.prompt) engine.output("user", String(event.prompt).slice(0, 600));
    });

    pi.on("message_update", async (event) => {
      if (!engine?.enabled) return;
      const update = event?.assistantMessageEvent;
      if (!update || typeof update.delta !== "string") return;
      if (update.type === "text_delta") engine.output("text", update.delta);
      else if (update.type === "thinking_delta") engine.output("thinking", update.delta);
    });

    pi.on("tool_execution_start", async (event) => {
      if (!engine?.enabled) return;
      engine.output("tool", `${toolCallDigest(event?.toolName, event?.args)}\n`);
    });

    pi.on("agent_end", async (_event, ctx) => {
      lastCtx = ctx || lastCtx;
      engine?.runEnd();
    });

    pi.on("session_shutdown", async () => {
      try { engine?.dispose(); } catch {}
      try { surface?.dispose(); } catch {}
      try { lastCtx?.ui?.setStatus?.(STATUS_KEY, undefined); } catch {}
      engine = null;
      surface = null;
    });

    pi.registerCommand("thoughts", {
      description: "Visual thoughts: images of the agent's work crossfading behind the screen (on|off|now|next|clear|<setting> <value>)",
      handler: async (args, ctx) => {
        lastCtx = ctx;
        const words = String(args || "").trim().split(/\s+/).filter(Boolean);
        const verb = (words[0] || "status").toLowerCase();
        if (verb === "status") {
          if (unavailable && !engine) return notify(`visual thoughts unavailable: ${unavailable}`, "warning", ctx);
          return notify(describeStatus(engine ? { ...engine.status(), stats: engine.stats() } : { enabled: false }, config), "info", ctx);
        }
        if (verb === "on" || verb === "off" || verb === "toggle") {
          const on = verb === "toggle" ? !engine?.enabled : verb === "on";
          if (!enable(ctx, on)) return notify(`visual thoughts unavailable: ${unavailable}`, "warning", ctx);
          return notify(on ? `visual thoughts on: painting with ${config.imageModel}, prompts from ${config.promptModel}` : "visual thoughts off", "info", ctx);
        }
        if (verb === "now") {
          if (!engine?.enabled && !enable(ctx, true)) return notify(`visual thoughts unavailable: ${unavailable}`, "warning", ctx);
          return notify(engine.generateNow() ? "painting from the current output" : `not now: ${engine.status().waitMs > 0 ? `next in ${Math.ceil(engine.status().waitMs / 1000)}s` : "already painting"}`, "info", ctx);
        }
        if (verb === "next") { engine?.next(); return; }
        if (verb === "clear") { engine?.clear(); return notify("visual thoughts cleared", "info", ctx); }
        if (words.length >= 2) {
          const change = parseSettingChange(words[0], words.slice(1).join(" "));
          if (change.error) return notify(`/thoughts: ${change.error}`, "warning", ctx);
          config[change.key] = change.value;
          engine?.configure(PROVIDER_KEYS.has(change.key) ? { provider: createImageProvider(config, { env, ...(fetchImpl ? { fetchImpl } : {}) }) } : {});
          return notify(`visual thoughts: ${change.key} = ${change.value} (this session)`, "info", ctx);
        }
        notify("Usage: /thoughts [on|off|toggle|status|now|next|clear|<setting> <value>]", "warning", ctx);
      },
    });
  };
}

export default createVisualThoughtsExtension();
