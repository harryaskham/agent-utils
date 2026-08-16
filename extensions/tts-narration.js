// /tts + /narrate automatic voice output (bd-93503c).
//
// /tts speaks every finalized plain assistant text block verbatim through the
// shared direct-Azure path. /narrate asynchronously summarizes complete tool
// batches before/after with a cheap model and queues tagged custom context for
// the next user turn without triggering or steering the active agent.

import { expandEnvReferences, parseEnvStyleArgs } from "./lib/env-args.js";
import { runPiTextTurn } from "./lib/pi-inference.js";
import {
  DEFAULT_NARRATION_MODEL,
  TOOL_SUMMARY_CUSTOM_TYPE,
  assistantPlainText,
  assistantToolCalls,
  buildNarrationRequest,
  createAgentSpeechController,
  normalizeNarrationText,
  resolveAgentTtsSettings,
  resolveNarrateSettings,
  resolveNarrationModel,
  toolResultText,
} from "./lib/tts-narration.js";
import {
  persistNarrateSetting,
  persistTtsSetting,
  readPersistedNarrateSettings,
  readPersistedTtsSettings,
} from "./lib/tts-settings.js";

function boolValue(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be on or off`);
}

function source(value, envKey, env) {
  if (value !== undefined && value !== null && value !== "") return "override";
  return env[envKey] ? "env" : "missing";
}

const TTS_SETTING_FIELDS = Object.freeze({
  provider: "provider", voice: "voice", lang: "lang", speed: "speed",
  embedding: "embedding", speaker: "embedding", speakerprofileid: "embedding", speaker_profile_id: "embedding",
  style: "style", styledegree: "styleDegree", style_degree: "styleDegree",
  endpoint: "endpoint", base_url: "endpoint", baseurl: "endpoint",
  backend: "backend", server: "server", device: "device", sink: "device",
  prefix: "prefix", suffix: "suffix",
});
const ENV_REFERENCE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

function ttsStatus(enabled, speech, env, enabledSource = "runtime", { prefix = "", suffix = "" } = {}) {
  const config = speech.getConfig();
  const optional = (value) => value == null || value === "" ? "none" : String(value);
  return [
    `tts:${enabled ? "on" : "off"}`,
    `enabled-source:${enabledSource}`,
    `provider:${config.provider}`,
    `voice:${optional(config.voice)}`,
    `lang:${optional(config.lang)}`,
    `speed:${optional(config.speed)}`,
    `style:${optional(config.style)}`,
    `styledegree:${optional(config.styleDegree)}`,
    `embedding:${config.embedding ? "set" : "none"}`,
    `endpoint:${source(config.endpoint, "AZURE_SPEECH_ENDPOINT", env)}`,
    `api-key:${source(config.apiKey, "AZURE_SPEECH_API_KEY", env)}`,
    `output:${config.backend}/${optional(config.device)}`,
    `prefix:${prefix ? "set" : "none"}`,
    `suffix:${suffix ? "set" : "none"}`,
    "stream:/tts",
  ].join(" · ");
}

export function createTtsNarrationExtension({
  env = process.env,
  speech,
  runTextTurn = runPiTextTurn,
  settingsPath,
  persistedSettings,
} = {}) {
  return function ttsNarrationExtension(pi) {
    const persistedTts = persistedSettings?.tts ?? readPersistedTtsSettings(settingsPath);
    const persistedNarrate = persistedSettings?.narrate ?? readPersistedNarrateSettings(settingsPath);
    const resolvedTts = resolveAgentTtsSettings({ env, persisted: persistedTts });
    const resolvedNarrate = resolveNarrateSettings({ env, persisted: persistedNarrate });
    const speechController = speech || createAgentSpeechController({ env, initialConfig: resolvedTts.config });
    let ttsEnabled = resolvedTts.enabled;
    let ttsEnabledSource = resolvedTts.enabledSource;
    let ttsPrefix = expandEnvReferences(resolvedTts.prefix, env, "/tts prefix");
    let ttsSuffix = expandEnvReferences(resolvedTts.suffix, env, "/tts suffix");
    let narrateEnabled = resolvedNarrate.enabled;
    let narrateEnabledSource = resolvedNarrate.enabledSource;
    let narrationModel = resolvedNarrate.model;
    let narrationModelSource = resolvedNarrate.modelSource;
    let narrationSpeed = resolvedNarrate.speed;
    let narrationSpeedSource = resolvedNarrate.speedSource;
    let narrationTextEnabled = resolvedNarrate.textEnabled;
    let narrationTextEnabledSource = resolvedNarrate.textEnabledSource;
    let narrationPrefix = expandEnvReferences(resolvedNarrate.prefix, env, "/narrate prefix");
    let narrationSuffix = expandEnvReferences(resolvedNarrate.suffix, env, "/narrate suffix");
    try {
      pi.ttsNarration = {
        isEnabled: () => ttsEnabled,
        isNarrateEnabled: () => narrateEnabled,
      };
    } catch {}
    let lastPlainKey = null;
    let nextBatchId = 1;
    let narrationGeneration = 0;
    const callToBatch = new Map();
    const activeNarrations = new Set();
    const warned = new Set();

    const warnOnce = (kind, error, ctx) => {
      if (warned.has(kind)) return;
      warned.add(kind);
      try { ctx?.ui?.notify?.(`${kind}: ${error?.message || String(error)}`, "warning"); } catch {}
    };

    const speakBestEffort = (text, ctx, kind = "tts", overrides = {}) => {
      void speechController.speak(text, overrides).catch((error) => warnOnce(kind, error, ctx));
    };

    const supersedeNarrationWork = ({ clearBatches = false } = {}) => {
      narrationGeneration += 1;
      for (const controller of activeNarrations) { try { controller.abort(); } catch {} }
      activeNarrations.clear();
      if (clearBatches) callToBatch.clear();
    };

    const stopNarrationWork = () => supersedeNarrationWork({ clearBatches: true });

    const narratePhase = async (batch, phase, ctx) => {
      const generation = batch.generation;
      if (!narrateEnabled || batch.cancelled || generation !== narrationGeneration) return "";
      let model;
      try { model = resolveNarrationModel(ctx?.modelRegistry, narrationModel); }
      catch (error) { warnOnce("narrate model", error, ctx); return ""; }
      const controller = new AbortController();
      activeNarrations.add(controller);
      try {
        const request = buildNarrationRequest({ phase, calls: batch.calls, results: batch.results });
        const response = await runTextTurn(ctx, {
          model,
          ...request,
          signal: controller.signal,
          abortedMessage: "narration superseded",
        });
        if (!narrateEnabled || generation !== narrationGeneration || controller.signal.aborted) return "";
        const text = normalizeNarrationText(response.text, phase);
        if (!text) return "";
        if (narrationTextEnabled) {
          // Optional custom next-turn context participates in history but never
          // impersonates the user or triggers the in-flight tool loop.
          pi.sendMessage({
            customType: TOOL_SUMMARY_CUSTOM_TYPE,
            content: `[tool summary][${phase}] ${text}`,
            display: true,
            details: { phase, batchId: batch.id, model: response.model, toolNames: batch.calls.map((call) => call.name) },
          }, { deliverAs: "nextTurn", triggerTurn: false });
        }
        speakBestEffort(`${narrationPrefix}${text}${narrationSuffix}`, ctx, "narrate speech", narrationSpeed ? { speed: narrationSpeed } : {});
        return text;
      } catch (error) {
        if (!controller.signal.aborted && narrateEnabled) warnOnce("narrate", error, ctx);
        return "";
      } finally {
        activeNarrations.delete(controller);
      }
    };

    const startToolBatch = (calls, ctx) => {
      if (!narrateEnabled || !calls.length) return;
      // A newer tool batch supersedes still-running summaries from an older one.
      // Tool execution itself remains untouched; only best-effort narration is
      // aborted. The shared speech controller separately enforces one playback.
      supersedeNarrationWork({ clearBatches: true });
      const batch = { id: `tools-${nextBatchId++}`, generation: narrationGeneration, calls, results: [], resultIds: new Set(), cancelled: false, before: null };
      for (const call of calls) callToBatch.set(call.id, batch);
      // Fire and retain the promise, but never return it from the Pi hook: tool
      // preflight/execution proceeds immediately. Post narration chains behind it
      // only to preserve audible before→after ordering.
      batch.before = narratePhase(batch, "before", ctx);
    };

    pi.registerMessageRenderer?.(TOOL_SUMMARY_CUSTOM_TYPE, (message, _options, theme) => ({
      render: (width) => [theme.fg("dim", String(message.content || "").slice(0, width))],
      invalidate() {},
    }));

    pi.on("message_end", (event, ctx) => {
      const message = event?.message;
      const calls = assistantToolCalls(message);
      const text = assistantPlainText(message);
      if (ttsEnabled) {
        if (text) {
          const key = `${message?.timestamp ?? ""}:${text}`;
          if (key !== lastPlainKey) {
            lastPlainKey = key;
            speakBestEffort(`${ttsPrefix}${text}${ttsSuffix}`, ctx, "tts");
          }
        }
      }
      if (narrateEnabled) {
        if (calls.length) startToolBatch(calls, ctx);
        else if (text) supersedeNarrationWork(); // the final verbatim answer wins over stale narration
      }
      return undefined;
    });

    pi.on("tool_execution_end", (event, ctx) => {
      if (!narrateEnabled) return;
      const id = String(event?.toolCallId ?? "");
      const batch = callToBatch.get(id);
      if (!batch || batch.resultIds.has(id)) return;
      batch.resultIds.add(id);
      batch.results.push({
        id,
        name: String(event?.toolName ?? batch.calls.find((call) => call.id === id)?.name ?? "tool"),
        isError: !!event?.isError,
        text: toolResultText(event?.result),
      });
      if (batch.resultIds.size !== batch.calls.length) return;
      for (const call of batch.calls) callToBatch.delete(call.id);
      void Promise.resolve(batch.before).catch(() => "").then(() => narratePhase(batch, "after", ctx));
    });

    pi.registerCommand("tts", {
      description: "Automatically speak every plain assistant text message verbatim. Usage: /tts [on|off|status|prefix='...' suffix='...' key=value ...]. Uses /read's native Azure settings/defaults.",
      handler: async (args, ctx) => {
        const raw = String(args || "").trim();
        const simple = raw.toLowerCase();
        if (!raw || simple === "on") {
          ttsEnabled = true;
          ttsEnabledSource = "runtime";
          ctx.ui.notify(ttsStatus(ttsEnabled, speechController, env, ttsEnabledSource, { prefix: ttsPrefix, suffix: ttsSuffix }), "info");
          return;
        }
        if (simple === "off") {
          ttsEnabled = false;
          ttsEnabledSource = "runtime";
          speechController.interrupt();
          ctx.ui.notify("tts:off · enabled-source:runtime (startup setting unchanged)", "info");
          return;
        }
        if (simple === "status") {
          ctx.ui.notify(ttsStatus(ttsEnabled, speechController, env, ttsEnabledSource, { prefix: ttsPrefix, suffix: ttsSuffix }), "info");
          return;
        }
        try {
          const parsed = parseEnvStyleArgs(raw);
          if (parsed.positionals.length) throw new Error(`/tts: unexpected argument '${parsed.positionals[0]}'`);
          const { prefix, suffix, ...speechValues } = parsed.values;
          if (prefix !== undefined) ttsPrefix = expandEnvReferences(prefix, env, "/tts prefix");
          if (suffix !== undefined) ttsSuffix = expandEnvReferences(suffix, env, "/tts suffix");
          const config = speechController.apply(speechValues);
          for (const [key, rawValue] of Object.entries(speechValues)) {
            const field = TTS_SETTING_FIELDS[key];
            if (!field || ENV_REFERENCE.test(String(rawValue))) continue; // never materialize env-derived values
            persistTtsSetting(field, config[field], settingsPath);
          }
          if (prefix !== undefined && !ENV_REFERENCE.test(String(prefix))) persistTtsSetting("prefix", ttsPrefix, settingsPath);
          if (suffix !== undefined && !ENV_REFERENCE.test(String(suffix))) persistTtsSetting("suffix", ttsSuffix, settingsPath);
          ttsEnabled = true;
          ttsEnabledSource = "runtime";
          ctx.ui.notify(ttsStatus(ttsEnabled, speechController, env, ttsEnabledSource, { prefix: ttsPrefix, suffix: ttsSuffix }), "info");
        } catch (error) {
          ctx.ui.notify(error?.message || String(error), "warning");
        }
      },
    });

    pi.registerCommand("narrate", {
      description: "Asynchronously narrate complete tool batches before/after with a fast model. Usage: /narrate [on|off|status|model=provider/id speed=2 text=false prefix='...' suffix='...'].",
      handler: async (args, ctx) => {
        const raw = String(args || "").trim();
        const simple = raw.toLowerCase();
        if (!raw || simple === "on") {
          narrateEnabled = true;
          narrateEnabledSource = "runtime";
        } else if (simple === "off") {
          narrateEnabled = false;
          narrateEnabledSource = "runtime";
          stopNarrationWork();
        } else if (simple !== "status") {
          try {
            const parsed = parseEnvStyleArgs(raw);
            if (parsed.positionals.length) throw new Error(`/narrate: unexpected argument '${parsed.positionals[0]}'`);
            for (const key of Object.keys(parsed.values)) {
              if (!new Set(["model", "enabled", "on", "speed", "text", "text_enabled", "prefix", "suffix"]).has(key)) throw new Error(`/narrate: unknown setting '${key}'`);
            }
            if (parsed.values.prefix !== undefined) {
              narrationPrefix = expandEnvReferences(parsed.values.prefix, env, "/narrate prefix");
              if (!ENV_REFERENCE.test(String(parsed.values.prefix))) persistNarrateSetting("prefix", narrationPrefix, settingsPath);
            }
            if (parsed.values.suffix !== undefined) {
              narrationSuffix = expandEnvReferences(parsed.values.suffix, env, "/narrate suffix");
              if (!ENV_REFERENCE.test(String(parsed.values.suffix))) persistNarrateSetting("suffix", narrationSuffix, settingsPath);
            }
            if (parsed.values.model) {
              narrationModel = String(parsed.values.model).trim();
              narrationModelSource = "runtime/settings";
              persistNarrateSetting("model", narrationModel, settingsPath);
            }
            if (parsed.values.speed !== undefined) {
              const speed = Number(parsed.values.speed);
              if (!Number.isFinite(speed) || speed <= 0) throw new Error("/narrate: speed must be greater than zero");
              narrationSpeed = speed;
              narrationSpeedSource = "runtime/settings";
              persistNarrateSetting("speed", speed, settingsPath);
            }
            const textRaw = parsed.values.text ?? parsed.values.text_enabled;
            if (textRaw !== undefined) {
              narrationTextEnabled = boolValue(textRaw, "/narrate text");
              narrationTextEnabledSource = "runtime/settings";
              persistNarrateSetting("textEnabled", narrationTextEnabled, settingsPath);
            }
            if (parsed.values.enabled !== undefined) {
              narrateEnabled = boolValue(parsed.values.enabled, "/narrate enabled");
              narrateEnabledSource = "runtime";
            }
            if (parsed.values.on !== undefined) {
              narrateEnabled = boolValue(parsed.values.on, "/narrate on");
              narrateEnabledSource = "runtime";
            }
          } catch (error) { ctx.ui.notify(error?.message || String(error), "warning"); return; }
        }
        ctx.ui.notify(`narrate:${narrateEnabled ? "on" : "off"} · enabled-source:${narrateEnabledSource} · model:${narrationModel} · model-source:${narrationModelSource} · speed:${narrationSpeed ?? "tts"} · speed-source:${narrationSpeedSource} · text:${narrationTextEnabled ? "on" : "off"} · text-source:${narrationTextEnabledSource} · prefix:${narrationPrefix ? "set" : "none"} · suffix:${narrationSuffix ? "set" : "none"} · context:${narrationTextEnabled ? "custom nextTurn/no-trigger" : "speech-only"} · speech:/tts settings`, "info");
      },
    });

    pi.on("session_shutdown", () => {
      ttsEnabled = false;
      narrateEnabled = false;
      stopNarrationWork();
      speechController.dispose();
    });
  };
}

export default createTtsNarrationExtension();
