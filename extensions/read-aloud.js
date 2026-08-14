// /read — direct, interruptible editor-to-speech mode (bd-098274).
//
// `/read [key=value ...]` enables the mode. While enabled, the whole editor
// buffer is spoken after a quiet debounce and again when the user submits it.
// Synthesis uses the shared native Azure REST library; playback is a named,
// interruptible PCM child (Pulse by default). No daemon or `tts` CLI hop.

import { parseEnvStyleArgs } from "./lib/env-args.js";
import {
  DEFAULT_TTS_PROVIDER,
  DEFAULT_TTS_VOICE,
  DEFAULT_TTS_LANG,
  DEFAULT_TTS_SPEED,
  DEFAULT_TTS_EMBEDDING,
  DEFAULT_TTS_BACKEND,
  DEFAULT_TTS_DEVICE,
  DEFAULT_TTS_STREAM_NAME,
  synthesizeSpeechDirect,
  createInterruptiblePcmPlayer,
} from "./lib/tts.js";
import { audioDurationMs } from "./lib/realtime-audio.js";
import { markAssistantSpeaking } from "./lib/half-duplex-state.js";
import {
  persistReadSetting,
  readPersistedReadSettings,
  readPersistedTtsSettings,
} from "./lib/tts-settings.js";

export const DEFAULT_READ_DELAY_MS = 2000;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const NONE = /^(none|null|unset)$/i;

export function defaultReadConfig(env = process.env, persisted = {}, persistedRead = {}) {
  const configured = (key, fallback) => persisted[key] !== undefined ? persisted[key] : fallback;
  const readConfigured = (key, fallback) => persistedRead[key] !== undefined ? persistedRead[key] : fallback;
  const bool = (value, fallback) => {
    if (value == null || String(value).trim() === "") return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
  };
  const nonNegative = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
  };
  const positive = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  };
  return {
    provider: env.PI_TTS_PROVIDER || configured("provider", DEFAULT_TTS_PROVIDER),
    voice: env.PI_TTS_VOICE || configured("voice", DEFAULT_TTS_VOICE),
    lang: env.PI_TTS_LANG || configured("lang", DEFAULT_TTS_LANG),
    speed: env.PI_READ_SPEED != null
      ? positive(env.PI_READ_SPEED, DEFAULT_TTS_SPEED)
      : persistedRead.speed != null
        ? positive(persistedRead.speed, DEFAULT_TTS_SPEED)
        : env.PI_TTS_SPEED != null ? positive(env.PI_TTS_SPEED, DEFAULT_TTS_SPEED) : configured("speed", DEFAULT_TTS_SPEED),
    embedding: env.PI_TTS_EMBEDDING || configured("embedding", DEFAULT_TTS_EMBEDDING),
    style: env.PI_TTS_STYLE ?? configured("style", null),
    styleDegree: env.PI_TTS_STYLEDEGREE != null ? Number(env.PI_TTS_STYLEDEGREE) : configured("styleDegree", null),
    endpoint: env.AZURE_SPEECH_ENDPOINT || configured("endpoint", undefined),
    apiKey: undefined,
    backend: env.PI_TTS_BACKEND || configured("backend", DEFAULT_TTS_BACKEND),
    server: env.PULSE_SERVER || configured("server", undefined),
    device: env.PULSE_SINK || configured("device", DEFAULT_TTS_DEVICE),
    streamName: DEFAULT_TTS_STREAM_NAME,
    delay: env.PI_READ_DELAY_MS != null ? nonNegative(env.PI_READ_DELAY_MS, DEFAULT_READ_DELAY_MS) : nonNegative(readConfigured("delayMs", DEFAULT_READ_DELAY_MS), DEFAULT_READ_DELAY_MS),
    onDelay: bool(env.PI_READ_ON_DELAY, bool(readConfigured("onDelay", true), true)),
    onSend: bool(env.PI_READ_ON_SEND, bool(readConfigured("onSend", true), true)),
  };
}

export function resolveReadEnvValue(value, env = process.env) {
  const raw = String(value ?? "");
  const match = raw.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)
    || raw.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!match) return raw;
  const name = match[1];
  if (env[name] == null) throw new Error(`/read: environment variable ${name} is not set`);
  return String(env[name]);
}

function nullableString(value, env) {
  if (NONE.test(String(value).trim())) return null;
  return resolveReadEnvValue(value, env).trim();
}

function positiveNumber(value, name, { allowZero = false } = {}) {
  if (NONE.test(String(value).trim())) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new Error(`/read: ${name} must be ${allowZero ? "zero or greater" : "greater than zero"}`);
  }
  return number;
}

function booleanValue(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (NONE.test(normalized)) return true;
  throw new Error(`/read: ${name} must be true or false`);
}

export function applyReadConfigValues(current, values = {}, env = process.env) {
  const next = { ...current };
  const known = new Set([
    "provider", "voice", "lang", "speed", "style", "styledegree", "style_degree",
    "embedding", "speaker", "speakerprofileid", "speaker_profile_id",
    "base_url", "baseurl", "endpoint", "api_key", "apikey",
    "backend", "server", "device", "sink", "delay", "on_delay", "ondelay",
    "on_send", "onsend",
  ]);
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new Error(`/read: unknown setting '${key}'`);
  }

  if (own(values, "provider")) {
    const provider = nullableString(values.provider, env);
    const normalized = provider == null ? DEFAULT_TTS_PROVIDER : provider.toLowerCase();
    if (!["azure", "azure-speech", "direct-azure"].includes(normalized)) {
      throw new Error(`/read: unsupported provider '${provider}'; use provider=azure`);
    }
    next.provider = "azure";
  }
  if (own(values, "voice")) next.voice = nullableString(values.voice, env);
  if (own(values, "lang")) next.lang = nullableString(values.lang, env);
  if (own(values, "speed")) next.speed = positiveNumber(values.speed, "speed");
  if (own(values, "style")) next.style = nullableString(values.style, env);
  const styleDegreeKey = own(values, "styledegree") ? "styledegree" : (own(values, "style_degree") ? "style_degree" : null);
  if (styleDegreeKey) {
    const degree = positiveNumber(values[styleDegreeKey], "styledegree");
    if (degree != null && (degree < 0.01 || degree > 2)) throw new Error("/read: styledegree must be between 0.01 and 2");
    next.styleDegree = degree;
  }
  const embeddingKey = ["embedding", "speaker", "speakerprofileid", "speaker_profile_id"].find((key) => own(values, key));
  if (embeddingKey) next.embedding = nullableString(values[embeddingKey], env);
  const endpointKey = ["base_url", "baseurl", "endpoint"].find((key) => own(values, key));
  if (endpointKey) next.endpoint = nullableString(values[endpointKey], env);
  const apiKeyKey = ["api_key", "apikey"].find((key) => own(values, key));
  if (apiKeyKey) next.apiKey = nullableString(values[apiKeyKey], env);
  if (own(values, "backend")) next.backend = nullableString(values.backend, env) || DEFAULT_TTS_BACKEND;
  if (own(values, "server")) next.server = nullableString(values.server, env);
  const deviceKey = own(values, "device") ? "device" : (own(values, "sink") ? "sink" : null);
  if (deviceKey) next.device = nullableString(values[deviceKey], env);
  if (own(values, "delay")) {
    const delay = positiveNumber(values.delay, "delay", { allowZero: true });
    next.delay = delay == null ? DEFAULT_READ_DELAY_MS : Math.trunc(delay);
  }
  const onDelayKey = own(values, "on_delay") ? "on_delay" : (own(values, "ondelay") ? "ondelay" : null);
  if (onDelayKey) next.onDelay = booleanValue(values[onDelayKey], "on_delay");
  const onSendKey = own(values, "on_send") ? "on_send" : (own(values, "onsend") ? "onsend" : null);
  if (onSendKey) next.onSend = booleanValue(values[onSendKey], "on_send");
  return next;
}

export function isReadControlText(text) {
  return /^\s*\/read(?:\s|$)/i.test(String(text || ""));
}

function sourceLabel(value, envName, env) {
  if (value === null) return "none";
  if (value !== undefined) return "override";
  return env[envName] ? "env" : "missing";
}

export function formatReadStatus(enabled, config, env = process.env) {
  const optional = (value) => value == null || value === "" ? "none" : String(value);
  return [
    `read:${enabled ? "on" : "off"}`,
    `provider:${config.provider}`,
    `voice:${optional(config.voice)}`,
    `lang:${optional(config.lang)}`,
    `speed:${optional(config.speed)}`,
    `style:${optional(config.style)}`,
    `styledegree:${optional(config.styleDegree)}`,
    `embedding:${config.embedding ? "set" : "none"}`,
    `endpoint:${sourceLabel(config.endpoint, "AZURE_SPEECH_ENDPOINT", env)}`,
    `api-key:${sourceLabel(config.apiKey, "AZURE_SPEECH_API_KEY", env)}`,
    `delay:${config.delay}ms`,
    `on-delay:${config.onDelay ? "on" : "off"}`,
    `on-send:${config.onSend ? "on" : "off"}`,
    `output:${config.backend}/${optional(config.device)}`,
    `stream:${config.streamName}`,
  ].join(" · ");
}

export function createReadModeController({
  env = process.env,
  synthesize = synthesizeSpeechDirect,
  player = createInterruptiblePcmPlayer(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  defer = queueMicrotask,
  persistedTts = {},
  persistedRead = {},
} = {}) {
  let config = defaultReadConfig(env, persistedTts, persistedRead);
  const enabledFrom = env.PI_READ_ENABLED ?? persistedRead.enabled;
  let enabled = ["1", "true", "yes", "on"].includes(String(enabledFrom ?? "").trim().toLowerCase());
  let timer = null;
  let generation = 0;
  let synthesisAbort = null;
  let lastObservedText = "";
  let lastCtx = null;

  const editorText = (ctx = lastCtx) => {
    try { return String(ctx?.ui?.getEditorText?.() ?? ""); }
    catch { return ""; }
  };
  const setStatus = (ctx, text) => {
    try { ctx?.ui?.setStatus?.("read", text); } catch {}
  };
  const notify = (ctx, message, level = "info") => {
    try { ctx?.ui?.notify?.(message, level); } catch {}
  };
  const clearDebounce = () => {
    if (timer != null) clearTimer(timer);
    timer = null;
  };
  const cancelCurrent = () => {
    generation += 1;
    try { synthesisAbort?.abort?.(); } catch {}
    synthesisAbort = null;
    player.interrupt?.();
  };

  const speak = async (text, reason = "manual", ctx = lastCtx) => {
    const body = String(text ?? "").trim();
    if (!body || isReadControlText(body)) return false;
    lastCtx = ctx || lastCtx;
    clearDebounce();
    cancelCurrent();
    const mine = generation;
    const abort = new AbortController();
    synthesisAbort = abort;
    setStatus(ctx, `/read · synthesizing (${reason})`);
    try {
      const synthesisOptions = {
        provider: config.provider,
        voice: config.voice,
        lang: config.lang,
        speed: config.speed,
        speakerProfileId: config.embedding,
        style: config.style,
        styleDegree: config.styleDegree,
        signal: abort.signal,
        env,
      };
      if (config.endpoint !== undefined) synthesisOptions.endpoint = config.endpoint;
      if (config.apiKey !== undefined) synthesisOptions.apiKey = config.apiKey;
      const pcm = await synthesize(body, synthesisOptions);
      if (mine !== generation || abort.signal.aborted) return false;
      synthesisAbort = null;
      markAssistantSpeaking(audioDurationMs(pcm));
      setStatus(ctx, `/read · speaking (${reason})`);
      await player.play(pcm, {
        backend: config.backend,
        server: config.server,
        device: config.device,
        streamName: config.streamName,
        env,
      });
      if (mine === generation) setStatus(ctx, "/read · on");
      return true;
    } catch (error) {
      if (mine !== generation || abort.signal.aborted) return false;
      synthesisAbort = null;
      setStatus(ctx, "/read · error");
      notify(ctx, `/read failed: ${error?.message || String(error)}`, "warning");
      return false;
    }
  };

  const scheduleCurrentEditor = (ctx = lastCtx) => {
    clearDebounce();
    if (!enabled || !config.onDelay) return;
    const expected = editorText(ctx).trim();
    if (!expected || isReadControlText(expected)) return;
    timer = setTimer(() => {
      timer = null;
      if (!enabled) return;
      const latest = editorText(ctx).trim();
      if (!latest || latest !== expected || isReadControlText(latest)) return;
      void speak(latest, "delay", ctx);
    }, config.delay);
    timer?.unref?.();
  };

  const handleTerminalInput = (data, ctx = lastCtx) => {
    if (!enabled) return undefined;
    lastCtx = ctx || lastCtx;
    const isEnter = data === "\r" || data === "\n";
    if (isEnter) {
      // The Pi `input` event carries the authoritative pre-clear submitted text.
      // Only cancel the pending delayed copy here; handleSubmittedText speaks it.
      clearDebounce();
      lastObservedText = "";
      return undefined;
    }
    defer(() => {
      if (!enabled) return;
      const current = editorText(ctx);
      if (current === lastObservedText) return;
      lastObservedText = current;
      scheduleCurrentEditor(ctx);
    });
    return undefined;
  };

  return {
    enable(ctx) {
      enabled = true;
      lastCtx = ctx || lastCtx;
      lastObservedText = editorText(ctx);
      setStatus(ctx, "/read · on");
      return { ...config };
    },
    disable(ctx = lastCtx) {
      enabled = false;
      clearDebounce();
      cancelCurrent();
      setStatus(ctx, undefined);
    },
    dispose(ctx = lastCtx) { this.disable(ctx); player.dispose?.(); },
    isEnabled: () => enabled,
    getConfig: () => ({ ...config }),
    setConfig(next) { config = { ...next }; return { ...config }; },
    updateConfig(values, ctx = lastCtx) {
      config = applyReadConfigValues(config, values, env);
      if (enabled) setStatus(ctx, "/read · on");
      return { ...config };
    },
    status: () => formatReadStatus(enabled, config, env),
    speak,
    handleSubmittedText(text, ctx = lastCtx) {
      if (!enabled || !config.onSend) return false;
      const submitted = String(text ?? "").trim();
      clearDebounce();
      lastObservedText = "";
      if (!submitted || isReadControlText(submitted)) return false;
      void speak(submitted, "send", ctx);
      return true;
    },
    handleTerminalInput,
    scheduleCurrentEditor,
    cancelCurrent,
  };
}

export function createReadAloudExtension({ settingsPath, persistedTts, persistedRead } = {}) {
  return function readAloudExtension(pi) {
  const controller = createReadModeController({
    persistedTts: persistedTts ?? readPersistedTtsSettings(settingsPath),
    persistedRead: persistedRead ?? readPersistedReadSettings(settingsPath),
  });
  let terminalInputUnsubscribe = null;
  let sessionCtx = null;

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    try { terminalInputUnsubscribe?.(); } catch {}
    terminalInputUnsubscribe = ctx?.ui?.onTerminalInput?.((data) => controller.handleTerminalInput(data, ctx)) || null;
  });

  pi.on("input", (event, ctx) => {
    controller.handleSubmittedText(event?.text, ctx);
    return { action: "continue" };
  });

  pi.on("session_shutdown", () => {
    try { terminalInputUnsubscribe?.(); } catch {}
    terminalInputUnsubscribe = null;
    controller.dispose(sessionCtx);
    sessionCtx = null;
  });

  pi.registerCommand("read", {
    description: "Direct Azure editor-to-speech mode. Usage: /read [on|off|status|text] [provider=azure voice=... lang=... speed=... style=... styledegree=... embedding=... delay=2000 on_delay=true on_send=true backend=pulse server=... device=...].",
    handler: async (args, ctx) => {
      try {
        const parsed = parseEnvStyleArgs(String(args || ""));
        const updated = controller.updateConfig(parsed.values, ctx);
        if (Object.hasOwn(parsed.values, "delay")) persistReadSetting("delayMs", updated.delay, settingsPath);
        if (Object.hasOwn(parsed.values, "speed")) persistReadSetting("speed", updated.speed, settingsPath);
        if (Object.hasOwn(parsed.values, "on_delay") || Object.hasOwn(parsed.values, "ondelay")) persistReadSetting("onDelay", updated.onDelay, settingsPath);
        if (Object.hasOwn(parsed.values, "on_send") || Object.hasOwn(parsed.values, "onsend")) persistReadSetting("onSend", updated.onSend, settingsPath);
        const action = String(parsed.positionals[0] || "").toLowerCase();
        if (["off", "stop", "disable"].includes(action)) {
          controller.disable(ctx);
          ctx.ui.notify("/read off (runtime; startup setting unchanged)", "info");
          return;
        }
        if (action === "status") {
          ctx.ui.notify(controller.status(), "info");
          return;
        }
        controller.enable(ctx);
        if (["on", "start", "enable"].includes(action) || parsed.positionals.length === 0) {
          ctx.ui.notify(controller.status(), "info");
          return;
        }
        // Compatibility with the original one-shot contract: `/read some words`
        // enables the mode and speaks the positional text immediately.
        await controller.speak(parsed.positionals.join(" "), "command", ctx);
      } catch (error) {
        ctx?.ui?.notify?.(error?.message || String(error), "warning");
      }
    },
  });

  try { pi.readAloud = controller; } catch {}
  };
}

export default createReadAloudExtension();
