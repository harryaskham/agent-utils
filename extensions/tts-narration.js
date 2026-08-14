// /tts + /narrate automatic voice output (bd-93503c).
//
// /tts speaks every finalized plain assistant text block verbatim through the
// shared direct-Azure path. /narrate asynchronously summarizes complete tool
// batches before/after with a cheap model and queues tagged custom context for
// the next user turn without triggering or steering the active agent.

import { parseEnvStyleArgs } from "./lib/env-args.js";
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
});
const ENV_REFERENCE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

function ttsStatus(enabled, speech, env, enabledSource = "runtime") {
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
    let narrateEnabled = resolvedNarrate.enabled;
    let narrateEnabledSource = resolvedNarrate.enabledSource;
    let narrationModel = resolvedNarrate.model;
    let narrationModelSource = resolvedNarrate.modelSource;
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

    const speakBestEffort = (text, ctx, kind = "tts") => {
      void speechController.speak(text).catch((error) => warnOnce(kind, error, ctx));
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
        // Custom next-turn context participates in history but never impersonates
        // the user and cannot trigger/steer the in-flight tool loop.
        pi.sendMessage({
          customType: TOOL_SUMMARY_CUSTOM_TYPE,
          content: `[tool summary][${phase}] ${text}`,
          display: true,
          details: { phase, batchId: batch.id, model: response.model, toolNames: batch.calls.map((call) => call.name) },
        }, { deliverAs: "nextTurn", triggerTurn: false });
        speakBestEffort(text, ctx, "narrate speech");
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
            speakBestEffort(text, ctx, "tts");
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
      description: "Automatically speak every plain assistant text message verbatim. Usage: /tts [on|off|status|key=value ...]. Uses /read's native Azure settings/defaults.",
      handler: async (args, ctx) => {
        const raw = String(args || "").trim();
        const simple = raw.toLowerCase();
        if (!raw || simple === "on") {
          ttsEnabled = true;
          ttsEnabledSource = "runtime/settings";
          persistTtsSetting("enabled", true, settingsPath);
          ctx.ui.notify(ttsStatus(ttsEnabled, speechController, env, ttsEnabledSource), "info");
          return;
        }
        if (simple === "off") {
          ttsEnabled = false;
          ttsEnabledSource = "runtime/settings";
          persistTtsSetting("enabled", false, settingsPath);
          speechController.interrupt();
          ctx.ui.notify("tts:off · enabled-source:runtime/settings", "info");
          return;
        }
        if (simple === "status") {
          ctx.ui.notify(ttsStatus(ttsEnabled, speechController, env, ttsEnabledSource), "info");
          return;
        }
        try {
          const parsed = parseEnvStyleArgs(raw);
          if (parsed.positionals.length) throw new Error(`/tts: unexpected argument '${parsed.positionals[0]}'`);
          const config = speechController.apply(parsed.values);
          for (const [key, rawValue] of Object.entries(parsed.values)) {
            const field = TTS_SETTING_FIELDS[key];
            if (!field || ENV_REFERENCE.test(String(rawValue))) continue; // never materialize env-derived values
            persistTtsSetting(field, config[field], settingsPath);
          }
          ttsEnabled = true;
          ttsEnabledSource = "runtime/settings";
          persistTtsSetting("enabled", true, settingsPath);
          ctx.ui.notify(ttsStatus(ttsEnabled, speechController, env, ttsEnabledSource), "info");
        } catch (error) {
          ctx.ui.notify(error?.message || String(error), "warning");
        }
      },
    });

    pi.registerCommand("narrate", {
      description: "Asynchronously narrate complete tool batches before/after with a fast model. Usage: /narrate [on|off|status|model=provider/id].",
      handler: async (args, ctx) => {
        const raw = String(args || "").trim();
        const simple = raw.toLowerCase();
        if (!raw || simple === "on") {
          narrateEnabled = true;
          narrateEnabledSource = "runtime/settings";
          persistNarrateSetting("enabled", true, settingsPath);
        } else if (simple === "off") {
          narrateEnabled = false;
          narrateEnabledSource = "runtime/settings";
          persistNarrateSetting("enabled", false, settingsPath);
          stopNarrationWork();
        } else if (simple !== "status") {
          try {
            const parsed = parseEnvStyleArgs(raw);
            if (parsed.positionals.length) throw new Error(`/narrate: unexpected argument '${parsed.positionals[0]}'`);
            for (const key of Object.keys(parsed.values)) {
              if (!new Set(["model", "enabled", "on"]).has(key)) throw new Error(`/narrate: unknown setting '${key}'`);
            }
            if (parsed.values.model) {
              narrationModel = String(parsed.values.model).trim();
              narrationModelSource = "runtime/settings";
              persistNarrateSetting("model", narrationModel, settingsPath);
            }
            if (parsed.values.enabled !== undefined) {
              narrateEnabled = boolValue(parsed.values.enabled, "/narrate enabled");
              narrateEnabledSource = "runtime/settings";
              persistNarrateSetting("enabled", narrateEnabled, settingsPath);
            }
            if (parsed.values.on !== undefined) {
              narrateEnabled = boolValue(parsed.values.on, "/narrate on");
              narrateEnabledSource = "runtime/settings";
              persistNarrateSetting("enabled", narrateEnabled, settingsPath);
            }
          } catch (error) { ctx.ui.notify(error?.message || String(error), "warning"); return; }
        }
        ctx.ui.notify(`narrate:${narrateEnabled ? "on" : "off"} · enabled-source:${narrateEnabledSource} · model:${narrationModel} · model-source:${narrationModelSource} · context:custom nextTurn/no-trigger · speech:/tts settings`, "info");
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
