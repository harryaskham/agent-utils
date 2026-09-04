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
  assistantReasoningSummary,
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
  readPersistedNarrateSettings,
  readPersistedTtsSettings,
} from "./lib/tts-settings.js";
import { createSessionRuntimeSettings } from "./lib/session-runtime-settings.js";
import { resolveSessionSpeechAssignment, resolveSessionSpeechPolicy, sessionSpeechIdentity } from "./lib/tts-identity.js";
import { DEFAULT_TTS_EMBEDDING } from "./lib/tts.js";

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

function ttsStatus(enabled, speech, env, enabledSource = "runtime", { prefix = "", suffix = "" } = {}) {
  const config = speech.getConfig();
  const optional = (value) => value == null || value === "" ? "none" : String(value);
  return [
    `tts:${enabled ? "on" : "off"}`,
    `enabled-source:${enabledSource}`,
    `provider:${config.provider}`,
    `voice:${optional(config.voice)}`,
    `pan:${optional(config.pan == null ? null : Number(config.pan).toFixed(2))}`,
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
  runtimeSettings,
} = {}) {
  return function ttsNarrationExtension(pi) {
    pi.registerFlag?.("harry", { description: "Use Harry's TTS embedding while retaining deterministic session pan", type: "boolean", default: false });
    const harryFlag = pi.getFlag?.("harry") === true;
    const persistedTts = persistedSettings?.tts ?? readPersistedTtsSettings(settingsPath);
    const persistedNarrate = persistedSettings?.narrate ?? readPersistedNarrateSettings(settingsPath);
    const resolvedTts = resolveAgentTtsSettings({ env, persisted: persistedTts });
    const resolvedNarrate = resolveNarrateSettings({ env, persisted: persistedNarrate });
    const speechController = speech || createAgentSpeechController({ env, initialConfig: resolvedTts.config });
    const sessionSpeechPolicy = resolveSessionSpeechPolicy(persistedTts, env);
    let sessionSpeechAssignment = null;
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
    let narrationStyle = resolvedNarrate.style;
    let narrationStyleSource = resolvedNarrate.styleSource;
    let narrationStyleDegree = resolvedNarrate.styleDegree;
    let narrationStyleDegreeSource = resolvedNarrate.styleDegreeSource;
    let narrationTextEnabled = resolvedNarrate.textEnabled;
    let narrationTextEnabledSource = resolvedNarrate.textEnabledSource;
    let narrationReasoningSummaries = resolvedNarrate.reasoningSummaries;
    let narrationReasoningSummariesSource = resolvedNarrate.reasoningSummariesSource;
    let narrationPrefix = expandEnvReferences(resolvedNarrate.prefix, env, "/narrate prefix");
    let narrationSuffix = expandEnvReferences(resolvedNarrate.suffix, env, "/narrate suffix");

    // Session-durable runtime overrides (bd-4dd60f). `/tts on` is scoped to this
    // session, not written to settings.json — but a `/restart` does not end the
    // session, so the toggle has to survive one. Accumulated k=v speech values
    // are stored raw and replayed through the same `apply()` the command uses,
    // so restore cannot drift from the live path.
    const durable = runtimeSettings || createSessionRuntimeSettings(pi);
    let ttsSpeechValues = {};

    const rememberTts = (patch) => { try { durable.merge("tts", patch); } catch {} };
    const rememberNarrate = (patch) => { try { durable.merge("narrate", patch); } catch {} };

    const rememberTtsSpeechValues = (values) => {
      if (!values || Object.keys(values).length === 0) return;
      ttsSpeechValues = { ...ttsSpeechValues, ...values };
      rememberTts({ speech: ttsSpeechValues });
    };

    pi.on?.("session_start", (_event, ctx) => {
      let saved = {};
      try { saved = durable.restore(ctx) || {}; } catch {}

      const tts = saved.tts || {};
      if (tts.speech && typeof tts.speech === "object") {
        ttsSpeechValues = { ...tts.speech };
        try { speechController.apply(ttsSpeechValues); } catch {}
      }
      if (typeof tts.prefix === "string") ttsPrefix = tts.prefix;
      if (typeof tts.suffix === "string") ttsSuffix = tts.suffix;
      if (typeof tts.enabled === "boolean") {
        ttsEnabled = tts.enabled;
        ttsEnabledSource = "session";
      }

      const narrate = saved.narrate || {};
      if (typeof narrate.model === "string") { narrationModel = narrate.model; narrationModelSource = "session"; }
      if (typeof narrate.speed === "number") { narrationSpeed = narrate.speed; narrationSpeedSource = "session"; }
      if (typeof narrate.style === "string") { narrationStyle = narrate.style || undefined; narrationStyleSource = "session"; }
      if (typeof narrate.styleDegree === "number") { narrationStyleDegree = narrate.styleDegree; narrationStyleDegreeSource = "session"; }
      if (typeof narrate.textEnabled === "boolean") { narrationTextEnabled = narrate.textEnabled; narrationTextEnabledSource = "session"; }
      if (typeof narrate.reasoningSummaries === "boolean") { narrationReasoningSummaries = narrate.reasoningSummaries; narrationReasoningSummariesSource = "session"; }
      if (typeof narrate.prefix === "string") narrationPrefix = narrate.prefix;
      if (typeof narrate.suffix === "string") narrationSuffix = narrate.suffix;
      if (typeof narrate.enabled === "boolean") { narrateEnabled = narrate.enabled; narrateEnabledSource = "session"; }

      sessionSpeechAssignment = resolveSessionSpeechAssignment(sessionSpeechIdentity(ctx, env), sessionSpeechPolicy);
      const current = speechController.getConfig();
      const assigned = {
        ...current,
        ...(harryFlag
          ? { voice: "MAI-Voice-2-Flash", embedding: DEFAULT_TTS_EMBEDDING }
          : sessionSpeechAssignment.voice ? { voice: sessionSpeechAssignment.voice, embedding: null } : {}),
        pan: sessionSpeechAssignment.pan,
      };
      if (typeof speechController.setConfig === "function") speechController.setConfig(assigned);
      else if (typeof speechController.apply === "function") speechController.apply({ voice: assigned.voice, embedding: assigned.embedding });
    });

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

    const publishNarration = (batch, phase, text, ctx, model, source = "generated") => {
      if (!text) return "";
      if (narrationTextEnabled) {
        pi.sendMessage({
          customType: TOOL_SUMMARY_CUSTOM_TYPE,
          content: `[tool summary][${phase}] ${text}`,
          display: true,
          details: { phase, source, batchId: batch.id, model, toolNames: batch.calls.map((call) => call.name) },
        }, { deliverAs: "nextTurn", triggerTurn: false });
      }
      speakBestEffort(`${narrationPrefix}${text}${narrationSuffix}`, ctx, "narrate speech", {
        ...(narrationSpeed ? { speed: narrationSpeed } : {}),
        ...(narrationStyle ? { style: narrationStyle } : {}),
        ...(narrationStyleDegree ? { styleDegree: narrationStyleDegree } : {}),
      });
      return text;
    };

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
        return publishNarration(batch, phase, text, ctx, response.model);
      } catch (error) {
        if (!controller.signal.aborted && narrateEnabled) warnOnce("narrate", error, ctx);
        return "";
      } finally {
        activeNarrations.delete(controller);
      }
    };

    const startToolBatch = (calls, ctx, nativeBefore = null) => {
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
      batch.before = nativeBefore?.text
        ? Promise.resolve(publishNarration(batch, "before", nativeBefore.text, ctx, nativeBefore.model, nativeBefore.source))
        : narratePhase(batch, "before", ctx);
    };

    pi.registerMessageRenderer?.(TOOL_SUMMARY_CUSTOM_TYPE, (message, _options, theme) => ({
      render: (width) => [theme.fg("dim", String(message.content || "").slice(0, width))],
      invalidate() {},
    }));

    pi.on("message_end", (event, ctx) => {
      const message = event?.message;
      const calls = assistantToolCalls(message);
      const text = assistantPlainText(message);
      const reasoningSummary = narrationReasoningSummaries ? normalizeNarrationText(assistantReasoningSummary(message), "before") : "";
      const preamble = normalizeNarrationText(text, "before");
      if (ttsEnabled && !(narrateEnabled && calls.length)) {
        if (text) {
          const key = `${message?.timestamp ?? ""}:${text}`;
          if (key !== lastPlainKey) {
            lastPlainKey = key;
            speakBestEffort(`${ttsPrefix}${text}${ttsSuffix}`, ctx, "tts");
          }
        }
      }
      if (narrateEnabled) {
        if (calls.length) {
          const nativeBefore = reasoningSummary
            ? { text: reasoningSummary, source: "main-reasoning-summary", model: `${message?.provider || "main"}/${message?.model || "active"}` }
            : preamble ? { text: preamble, source: "main-preamble", model: `${message?.provider || "main"}/${message?.model || "active"}` } : null;
          startToolBatch(calls, ctx, nativeBefore);
        }
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
          rememberTts({ enabled: true });
          ctx.ui.notify(ttsStatus(ttsEnabled, speechController, env, ttsEnabledSource, { prefix: ttsPrefix, suffix: ttsSuffix }), "info");
          return;
        }
        if (simple === "--harry" || simple === "harry") {
          const current = speechController.getConfig();
          speechController.setConfig({ ...current, voice: "MAI-Voice-2-Flash", embedding: DEFAULT_TTS_EMBEDDING });
          rememberTtsSpeechValues({ voice: "MAI-Voice-2-Flash", embedding: DEFAULT_TTS_EMBEDDING });
          ttsEnabled = true;
          ttsEnabledSource = "runtime";
          rememberTts({ enabled: true });
          ctx.ui.notify(ttsStatus(ttsEnabled, speechController, env, ttsEnabledSource, { prefix: ttsPrefix, suffix: ttsSuffix }), "info");
          return;
        }
        if (simple === "off") {
          ttsEnabled = false;
          ttsEnabledSource = "runtime";
          rememberTts({ enabled: false });
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
          if (prefix !== undefined) {
            ttsPrefix = expandEnvReferences(prefix, env, "/tts prefix");
            rememberTts({ prefix: ttsPrefix });
          }
          if (suffix !== undefined) {
            ttsSuffix = expandEnvReferences(suffix, env, "/tts suffix");
            rememberTts({ suffix: ttsSuffix });
          }
          speechController.apply(speechValues);
          rememberTtsSpeechValues(speechValues);
          ttsEnabled = true;
          ttsEnabledSource = "runtime";
          rememberTts({ enabled: true });
          ctx.ui.notify(ttsStatus(ttsEnabled, speechController, env, ttsEnabledSource, { prefix: ttsPrefix, suffix: ttsSuffix }), "info");
        } catch (error) {
          ctx.ui.notify(error?.message || String(error), "warning");
        }
      },
    });

    pi.registerCommand("narrate", {
      description: "Asynchronously narrate complete tool batches before/after. Usage: /narrate [on|off|status|reasoning_summaries=true model=provider/id speed=2 style=excited styledegree=1.6 text=false prefix='...' suffix='...'].",
      handler: async (args, ctx) => {
        const raw = String(args || "").trim();
        const simple = raw.toLowerCase();
        if (simple === "--harry" || simple === "harry") {
          const current = speechController.getConfig();
          speechController.setConfig({ ...current, voice: "MAI-Voice-2-Flash", embedding: DEFAULT_TTS_EMBEDDING });
          rememberTtsSpeechValues({ voice: "MAI-Voice-2-Flash", embedding: DEFAULT_TTS_EMBEDDING });
          narrateEnabled = true;
          narrateEnabledSource = "runtime";
          rememberNarrate({ enabled: true });
        } else if (!raw || simple === "on") {
          narrateEnabled = true;
          narrateEnabledSource = "runtime";
          rememberNarrate({ enabled: true });
        } else if (simple === "off") {
          narrateEnabled = false;
          narrateEnabledSource = "runtime";
          rememberNarrate({ enabled: false });
          stopNarrationWork();
        } else if (simple !== "status") {
          try {
            const parsed = parseEnvStyleArgs(raw);
            if (parsed.positionals.length) throw new Error(`/narrate: unexpected argument '${parsed.positionals[0]}'`);
            for (const key of Object.keys(parsed.values)) {
              if (!new Set(["model", "enabled", "on", "speed", "style", "styledegree", "style_degree", "text", "text_enabled", "reasoning", "reasoning_summaries", "reasoningsummaries", "prefix", "suffix"]).has(key)) throw new Error(`/narrate: unknown setting '${key}'`);
            }
            if (parsed.values.prefix !== undefined) {
              narrationPrefix = expandEnvReferences(parsed.values.prefix, env, "/narrate prefix");
              rememberNarrate({ prefix: narrationPrefix });
            }
            if (parsed.values.suffix !== undefined) {
              narrationSuffix = expandEnvReferences(parsed.values.suffix, env, "/narrate suffix");
              rememberNarrate({ suffix: narrationSuffix });
            }
            if (parsed.values.model) {
              narrationModel = String(parsed.values.model).trim();
              narrationModelSource = "runtime";
              rememberNarrate({ model: narrationModel });
            }
            if (parsed.values.speed !== undefined) {
              const speed = Number(parsed.values.speed);
              if (!Number.isFinite(speed) || speed <= 0) throw new Error("/narrate: speed must be greater than zero");
              narrationSpeed = speed;
              narrationSpeedSource = "runtime";
              rememberNarrate({ speed });
            }
            if (parsed.values.style !== undefined) {
              narrationStyle = String(parsed.values.style).trim() || undefined;
              narrationStyleSource = "runtime";
              rememberNarrate({ style: narrationStyle || "" });
            }
            const styleDegreeRaw = parsed.values.styledegree ?? parsed.values.style_degree;
            if (styleDegreeRaw !== undefined) {
              const degree = Number(styleDegreeRaw);
              if (!Number.isFinite(degree) || degree < 0.01 || degree > 2) throw new Error("/narrate: styledegree must be between 0.01 and 2");
              narrationStyleDegree = degree;
              narrationStyleDegreeSource = "runtime";
              rememberNarrate({ styleDegree: degree });
            }
            const reasoningRaw = parsed.values.reasoning_summaries ?? parsed.values.reasoningsummaries ?? parsed.values.reasoning;
            if (reasoningRaw !== undefined) {
              narrationReasoningSummaries = boolValue(reasoningRaw, "/narrate reasoning_summaries");
              narrationReasoningSummariesSource = "runtime";
              rememberNarrate({ reasoningSummaries: narrationReasoningSummaries });
            }
            const textRaw = parsed.values.text ?? parsed.values.text_enabled;
            if (textRaw !== undefined) {
              narrationTextEnabled = boolValue(textRaw, "/narrate text");
              narrationTextEnabledSource = "runtime";
              rememberNarrate({ textEnabled: narrationTextEnabled });
            }
            if (parsed.values.enabled !== undefined) {
              narrateEnabled = boolValue(parsed.values.enabled, "/narrate enabled");
              narrateEnabledSource = "runtime";
              rememberNarrate({ enabled: narrateEnabled });
            }
            if (parsed.values.on !== undefined) {
              narrateEnabled = boolValue(parsed.values.on, "/narrate on");
              narrateEnabledSource = "runtime";
              rememberNarrate({ enabled: narrateEnabled });
            }
          } catch (error) { ctx.ui.notify(error?.message || String(error), "warning"); return; }
        }
        ctx.ui.notify(`narrate:${narrateEnabled ? "on" : "off"} · enabled-source:${narrateEnabledSource} · model:${narrationModel} · model-source:${narrationModelSource} · speed:${narrationSpeed ?? "tts"} · speed-source:${narrationSpeedSource} · style:${narrationStyle ?? "tts"} · style-source:${narrationStyleSource} · styledegree:${narrationStyleDegree ?? "tts"} · styledegree-source:${narrationStyleDegreeSource} · text:${narrationTextEnabled ? "on" : "off"} · text-source:${narrationTextEnabledSource} · reasoning-summaries:${narrationReasoningSummaries ? "prefer" : "off"} · reasoning-source:${narrationReasoningSummariesSource} · prefix:${narrationPrefix ? "set" : "none"} · suffix:${narrationSuffix ? "set" : "none"} · context:${narrationTextEnabled ? "custom nextTurn/no-trigger" : "speech-only"} · speech:/tts settings`, "info");
      },
    });

    pi.on("session_shutdown", () => {
      // In-memory teardown only. This is process lifecycle, not operator intent,
      // so it must NOT be recorded as a runtime override — otherwise every exit
      // would durably "turn off" tts for the session it is leaving. Flush any
      // coalesced write first so a k=v burst right before exit is not lost.
      try { durable.flush(); } catch {}
      ttsEnabled = false;
      narrateEnabled = false;
      stopNarrationWork();
      speechController.dispose();
    });
  };
}

export default createTtsNarrationExtension();
