// Visual thoughts for pi-daemon sessions: the agent's work painted once per session, server-side,
// into the session's `backdrop` UI slot (pi-daemon 1.15 session UI slots), which every client of
// the session shows: pi-client panes, TUI Pi through pi-client, /web and Culture (AHP
// `_meta["pi-daemon/ui"]`). The painting is the TUI's (painter.js): a digest of the agent's output,
// a prompt from the session's prompt model, an image from the image model.
//
// The slot is `{ kind: "image-set", images, current, hints }`: the newest `slotImages` paintings
// (session media, PNG, at most 2 MiB each; larger ones are scaled down on a worker thread), the one
// to show now, and how to show them (placement, opacity, fit, feather, cycle, transition). Clients
// rotate and transition locally.
//
// `/thoughts` (on|off|toggle|status|now|next|clear|<setting> <value>) controls a session; its
// choice persists in the module's session state. Hosts before 1.15 have no `ui`: the module
// stays quiet there and `/thoughts` says so.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runPiTextTurn } from "./pi-inference.js";
import { parseSettingChange, resolveVisualThoughtsConfig } from "./visual-thoughts/config.js";
import { createImageProvider } from "./visual-thoughts/image-provider.js";
import { litellmChat } from "./visual-thoughts/litellm-chat.js";
import { createPainter } from "./visual-thoughts/painter.js";
import { toolCallDigest } from "./visual-thoughts/prompter.js";
import { createRenderer as defaultCreateRenderer } from "./visual-thoughts/renderer.js";

export const SLOT = "backdrop";
/** The slot's owner as the host stamps it: the module's file name. */
export const OWNER = "visual-thoughts";
/** ui.image's limit (2 MiB), with room to spare. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024 - 16 * 1024;
const SETTINGS_KEY = "settings";
/** Session-scoped settings `/thoughts <key> <value>` may change (persisted per session). */
const SESSION_KEYS = new Set(["promptModel", "clientPromptModel", "imageModel", "size", "quality", "style", "opacity", "fit", "feather", "holdMs", "minIntervalMs", "firstChars", "minChars", "maxPerRun", "slotImages", "provider"]);
const HINT_KEYS = new Set(["opacity", "fit", "feather", "holdMs"]);

/** The agent-utils settings slice from Pi's settings.json. */
export function readVisualThoughtsSettings(env = process.env) {
  try {
    const dir = env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME || homedir(), ".pi", "agent");
    return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

/** The slot value for a session's paintings. */
export function backdropSlot(images, current, config) {
  return {
    kind: "image-set",
    images,
    current: Math.max(0, Math.min(images.length - 1, Number.isInteger(current) ? current : images.length - 1)),
    hints: {
      placement: "backdrop",
      opacity: config.opacity,
      fit: config.fit,
      feather: config.feather,
      cycleMs: config.holdMs,
      transition: "crossfade",
    },
  };
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "";
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

export function createVisualThoughtsModule({
  env = process.env,
  settings = readVisualThoughtsSettings(env),
  fetchImpl,
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout },
  createRenderer = defaultCreateRenderer,
  log = (line) => { try { process.stderr.write(`${line}\n`); } catch {} },
} = {}) {
  const base = resolveVisualThoughtsConfig(settings, env);
  if (!Number.isFinite(base.slotImages)) base.slotImages = 8;
  const sessions = new Map(); // sessionId → session
  let renderer = null;
  let disposed = false;

  const fitter = () => (renderer ||= createRenderer({ transport: "stream", onError: (error) => log(`visual thoughts: renderer thread failed: ${error?.message || error}`) }));

  /** A PNG that fits ui.image's limit: scaled down on the renderer thread when too large. */
  async function fitted(png) {
    if (png.length <= MAX_IMAGE_BYTES) return png;
    const reply = await fitter().fitPng(png, MAX_IMAGE_BYTES);
    return Buffer.from(reply.png);
  }

  async function promptTurn(session, request, signal) {
    const info = session.info;
    const reference = String(session.config.promptModel || "");
    const registry = info?.modelRegistry;
    if (!reference.startsWith("litellm/") && typeof registry?.find === "function" && typeof registry?.complete === "function") {
      const slash = reference.indexOf("/");
      const model = slash > 0 ? registry.find(reference.slice(0, slash), reference.slice(slash + 1)) : undefined;
      if (!model) throw new Error(`prompt model not available: ${reference}`);
      const response = await runPiTextTurn(info, { model, ...request, signal, abortedMessage: "visual thoughts prompt superseded" });
      return response.text;
    }
    return litellmChat({
      model: reference.startsWith("litellm/") ? reference.slice("litellm/".length) : session.config.clientPromptModel,
      request, signal,
      baseUrl: session.config.baseUrl || env.LITELLM_BASE_URL || env.LITELLM_PROXY_URL,
      apiKey: env[session.config.apiKeyEnv || "LITELLM_MASTER_KEY"],
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  /** Write the slot, waiting out the host's per-slot rate limit. */
  async function publish(session) {
    const ui = session.ui;
    if (!ui) return;
    for (let attempt = 0; ; attempt += 1) {
      try {
        // Never cleared: the slot, even empty, tells clients this host paints the session.
        await ui.set(SLOT, backdropSlot(session.images, session.current, session.config));
        return;
      } catch (error) {
        if (errorCode(error) === "rate_limited" && attempt < 4) { await delay(300 * (attempt + 1)); continue; }
        if (errorCode(error) === "not_owner") session.blocked = "another module owns the backdrop slot";
        throw error;
      }
    }
  }

  async function onImage(session, record, png) {
    const ui = session.ui;
    if (!ui || session.blocked) return;
    const bytes = await fitted(png);
    const ref = await ui.image(bytes, "image/png", { alt: String(record.prompt || "").slice(0, 280) });
    session.images = [...session.images, ref].slice(-Math.max(1, Math.min(32, session.config.slotImages)));
    session.current = session.images.length - 1;
    await publish(session);
    session.lastError = "";
  }

  function report(session, error) {
    session.lastError = error?.message || String(error);
    log(`visual thoughts (${session.id}): ${session.lastError}`);
  }

  async function load(info) {
    const id = String(info?.sessionId || "");
    if (!id) return null;
    let session = sessions.get(id);
    if (session) {
      session.info = info;
      if (info.ui) session.ui = info.ui;
      return session;
    }
    session = { id, info, ui: info.ui || null, images: [], current: 0, enabled: false, lastError: "", blocked: "", overrides: {} };
    sessions.set(id, session);
    let stored = {};
    try { stored = (await info.state?.get?.(SETTINGS_KEY)) || {}; } catch {}
    session.overrides = stored.overrides && typeof stored.overrides === "object" ? stored.overrides : {};
    session.config = { ...base, ...session.overrides };
    session.enabled = typeof stored.enabled === "boolean" ? stored.enabled : base.enabled;
    if (session.ui) {
      try {
        const slot = await session.ui.get(SLOT);
        if (slot?.owner && slot.owner !== OWNER) session.blocked = `the backdrop slot belongs to ${slot.owner}`;
        else if (slot?.kind === "image-set" && Array.isArray(slot.images)) {
          session.images = slot.images.filter((ref) => typeof ref?.uri === "string");
          session.current = Number.isInteger(slot.current) ? slot.current : session.images.length - 1;
        } else {
          // Claimed at once, empty: clients stop painting locally before their first image.
          await publish(session);
        }
      } catch (error) { report(session, error); }
    }
    session.painter = createPainter({
      config: session.config,
      promptTurn: (request, signal) => promptTurn(session, request, signal),
      provider: createImageProvider(session.config, { env, ...(fetchImpl ? { fetchImpl } : {}) }),
      onImage: (record, png) => onImage(session, record, png).catch((error) => report(session, error)),
      now,
      timers,
      // The painter keeps its own last error (cleared by its next painting).
      warn: (message) => log(`${message} (${id})`),
    });
    for (const ref of session.images) session.painter.remember(ref.alt);
    session.painter.setEnabled(session.enabled && Boolean(session.ui) && !base.incognito);
    return session;
  }

  async function save(session) {
    try { await session.info?.state?.set?.(SETTINGS_KEY, { enabled: session.enabled, overrides: session.overrides }); } catch {}
  }

  function setEnabled(session, on) {
    session.enabled = Boolean(on);
    session.painter.setEnabled(session.enabled && Boolean(session.ui) && !base.incognito);
  }

  async function observe(event, info) {
    if (disposed || !event || typeof event !== "object") return;
    const type = event.type;
    if (!["agent_start", "agent_end", "message_end", "tool_execution_start"].includes(type)) return;
    let session;
    try { session = await load(info); } catch (error) { log(`visual thoughts: session load failed: ${error?.message || error}`); return; }
    if (!session || !session.painter.enabled) return;
    if (type === "agent_start") return void session.painter.runStart();
    if (type === "agent_end") return void session.painter.runEnd();
    if (type === "tool_execution_start") return void session.painter.output("tool", `${toolCallDigest(event.toolName, event.args)}\n`);
    // The coding agent's `message`, or Durable's committed entry (`entry.model`, its messages).
    const messages = event.message ? [event.message] : Array.isArray(event.entry?.model) ? event.entry.model : [];
    for (const message of messages) {
      const parts = Array.isArray(message?.content) ? message.content : [{ type: "text", text: message?.content }];
      if (message?.role === "user") {
        const text = parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
        if (text) session.painter.output("user", text.slice(0, 600));
      } else if (message?.role === "assistant") {
        for (const part of parts) {
          if (part?.type === "thinking" && typeof part.thinking === "string") session.painter.output("thinking", part.thinking);
          else if (part?.type === "text" && typeof part.text === "string") session.painter.output("text", part.text);
        }
      }
    }
  }

  function describe(session) {
    const status = session.painter.status();
    const lines = [
      `visual thoughts (this session, for every client): ${session.enabled ? "on" : "off"}${session.ui ? "" : " — this pi-daemon has no session UI slots (needs 1.15)"}${base.incognito ? " — incognito" : ""}`,
      `  ${session.images.length} image${session.images.length === 1 ? "" : "s"} in the backdrop slot; ${status.activity}${status.waitMs > 1_000 && status.activity === "idle" ? `, next in ${Math.round(status.waitMs / 1000)}s` : ""}`,
      `  painting with ${status.provider || session.config.imageModel}; prompts from ${session.config.promptModel}`,
    ];
    if (status.generated) lines.push(`  ${status.generated} painted since the worker started; the last took ${(status.lastMs / 1000).toFixed(1)}s`);
    if (status.prompt) lines.push(`  last prompt: ${status.prompt.slice(0, 200)}`);
    if (session.blocked) lines.push(`  blocked: ${session.blocked}`);
    if (session.lastError || status.lastError) lines.push(`  last error: ${session.lastError || status.lastError}`);
    return lines.join("\n");
  }

  async function run(args, ctx = {}) {
    const reply = (text) => { try { ctx.notify?.(text); } catch {} return text; };
    const session = await load(ctx);
    if (!session) return reply("visual thoughts: no session");
    const words = String(args ?? "").trim().split(/\s+/).filter(Boolean);
    const verb = (words[0] || "status").toLowerCase();
    try {
      if (verb === "status") return reply(describe(session));
      if (verb === "on" || verb === "off" || verb === "toggle") {
        const on = verb === "toggle" ? !session.enabled : verb === "on";
        setEnabled(session, on);
        if (!on) { session.images = []; session.current = 0; await publish(session).catch((error) => report(session, error)); }
        await save(session);
        return reply(describe(session));
      }
      if (verb === "now") {
        if (!session.enabled) setEnabled(session, true);
        await save(session);
        return reply(session.painter.paintNow() ? "visual thoughts: painting from the conversation now" : `visual thoughts: not now (${session.painter.status().waitMs > 0 ? `next in ${Math.ceil(session.painter.status().waitMs / 1000)}s` : "already painting"})`);
      }
      if (verb === "next") {
        if (session.images.length > 1) { session.current = (session.current + 1) % session.images.length; await publish(session); }
        return reply(`visual thoughts: image ${session.current + 1} of ${session.images.length}`);
      }
      if (verb === "clear") {
        session.images = [];
        session.current = 0;
        await publish(session);
        return reply("visual thoughts: backdrop cleared");
      }
      if (words.length >= 2) {
        const change = parseSettingChange(words[0], words.slice(1).join(" "));
        if (change.error) return reply(`/thoughts: ${change.error}`);
        if (!SESSION_KEYS.has(change.key)) return reply(`/thoughts: ${change.key} is set in settings.json here`);
        session.overrides = { ...session.overrides, [change.key]: change.value };
        Object.assign(session.config, { [change.key]: change.value });
        session.painter.setProvider(createImageProvider(session.config, { env, ...(fetchImpl ? { fetchImpl } : {}) }));
        if (HINT_KEYS.has(change.key) && session.images.length) await publish(session);
        await save(session);
        return reply(`visual thoughts: ${change.key} = ${change.value} (this session)`);
      }
      return reply("Usage: /thoughts [on|off|toggle|status|now|next|clear|<setting> <value>]");
    } catch (error) {
      report(session, error);
      return reply(`visual thoughts: ${session.lastError}`);
    }
  }

  return {
    commands: {
      thoughts: {
        description: "Visual thoughts: paint the agent's work into this session's backdrop, for every client (on|off|now|next|clear|status|<setting> <value>)",
        run,
      },
    },
    observe,
    /** Sessions in memory (tests, status). */
    sessions,
    dispose() {
      disposed = true;
      for (const session of sessions.values()) session.painter?.dispose();
      sessions.clear();
      renderer?.close();
      renderer = null;
    },
  };
}
