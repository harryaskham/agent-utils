// Generic spoken multi-input choice extension (bd-8b3005).
//
// Inputs are event-based. This extension owns question/choice state, UI, TTS,
// timeout, and keyboard controls; device adapters (such as ring-input.js) emit
// the same semantic actions on CHOICE_INPUT_EVENT.

import { parseEnvStyleArgs } from "./lib/env-args.js";
import { ToolSchema } from "./lib/tool-schema.js";
import {
  INPUT_ACTION_EVENT,
  CHOICE_SESSION_EVENT,
  DEFAULT_CHOICE_TIMEOUT_MS,
  ChoiceStateMachine,
  createChoiceSpeaker,
  formatChoiceIntroduction,
  keyboardChoiceAction,
  normalizeChoices,
} from "./lib/choice.js";
import {
  persistChoiceSetting,
  readPersistedChoiceSettings,
  readPersistedTtsSettings,
} from "./lib/tts-settings.js";

export const FORCE_CHOICE_CUSTOM_TYPE = "agent-utils-force-choice";

function boolSetting(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function resolveChoiceSettings(env, persisted = {}) {
  const number = (envKey, field, fallback, min, max) => {
    const raw = env[envKey] ?? persisted[field];
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
  };
  return {
    timeoutMs: number("PI_CHOICE_TIMEOUT_MS", "timeoutMs", DEFAULT_CHOICE_TIMEOUT_MS, 0, 300000),
    maxChoices: number("PI_CHOICE_MAX_CHOICES", "maxChoices", 9, 2, 9),
    wrap: boolSetting(env.PI_CHOICE_WRAP, boolSetting(persisted.wrap, true)),
    speechEnabled: boolSetting(env.PI_CHOICE_SPEECH_ENABLED, boolSetting(persisted.speechEnabled, true)),
    forceAtAgentEnd: boolSetting(env.PI_FORCE_CHOICE, boolSetting(persisted.forceAtAgentEnd, false)),
  };
}

function renderChoiceWidget(question, choices, index, status = "listening") {
  const normalized = normalizeChoices(choices);
  return [
    `◇ ${String(question || "Choose one").trim()} · ${status}`,
    ...normalized.map((choice, i) => `${i === index ? "▶" : " "} ${i + 1}. ${choice.headline}${choice.summary ? ` — ${choice.summary}` : ""}`),
    "↑/k previous · ↓/j next · Enter choose · 1-9 direct · Esc/q cancel",
  ];
}

function resultText(result) {
  if (result?.status === "selected") return `selected ${result.index + 1}: ${result.choice?.label}`;
  if (result?.status === "timeout") return `choice timed out after ${result.timeoutMs}ms`;
  if (result?.status === "cancelled") return `choice cancelled (${result.reason || "cancelled"})`;
  return `choice failed: ${result?.error || "unknown error"}`;
}

export function createChoiceExtension({ speaker, env = process.env, settingsPath, persistedSettings } = {}) {
  return function choiceExtension(pi) {
    const persistedChoice = persistedSettings?.choice ?? readPersistedChoiceSettings(settingsPath);
    const choiceConfig = resolveChoiceSettings(env, persistedChoice);
    const speakerController = speaker || createChoiceSpeaker({ env, persisted: persistedSettings?.tts ?? readPersistedTtsSettings(settingsPath) });
    let active = null;
    let lastResult = null;
    let nextSessionId = 1;
    let forcedRequestOutstanding = false;
    let warnedUnsatisfiedForce = false;

    const emitSession = (payload) => {
      try { pi.events?.emit?.(CHOICE_SESSION_EVENT, payload); } catch {}
    };

    const endInputSession = (record, result) => {
      if (record.sessionEnded) return;
      record.sessionEnded = true;
      emitSession({ status: "ended", sessionId: record.sessionId, result });
    };

    const releaseChoiceUi = (record) => {
      if (record.timer) clearTimeout(record.timer);
      record.timer = null;
      try { record.terminalUnsub?.(); } catch {}
      record.terminalUnsub = null;
      // Cancellation/selection must stop an in-flight spoken prompt immediately;
      // Escape should not leave the old question talking over freeform input.
      try { speakerController.interrupt?.(); } catch {}
      try { record.ctx?.ui?.setWidget?.("agent-utils-choice", undefined); } catch {}
    };

    const finish = (record, result) => {
      if (!record || record.finished) return;
      record.finished = true;
      releaseChoiceUi(record);
      record.signal?.removeEventListener?.("abort", record.onAbort);
      if (active === record) active = null;
      lastResult = result;
      if (
        choiceConfig.forceAtAgentEnd && result?.status === "selected" &&
        /^(?:stop|idle|pause|finish|stop continuous choices)$/i.test(String(result.choice?.label || "").trim())
      ) {
        choiceConfig.forceAtAgentEnd = false;
        forcedRequestOutstanding = false;
        persistChoiceSetting("forceAtAgentEnd", false, settingsPath);
      }
      endInputSession(record, result);
      record.resolve(result);
    };

    const awaitFreeformAfterEscape = (record) => {
      if (!record || record.finished || record.awaitingFreeform) return;
      record.awaitingFreeform = true;
      releaseChoiceUi(record);
      // Stop every external adapter now, but deliberately keep the interactive
      // tool unresolved. It resumes only when Pi receives the next real user
      // input, so Escape itself never causes another agent turn.
      endInputSession(record, { status: "dismissed", reason: "freeform-pending", index: record.state.index, choice: record.state.current() });
      try { record.ctx?.ui?.notify?.("Choice dismissed — type a freeform reply; nothing has been sent.", "info"); } catch {}
    };

    const cancelActive = (reason = "superseded") => {
      if (!active) return false;
      finish(active, { status: "cancelled", reason, index: active.state.index, choice: active.state.current() });
      return true;
    };

    const handleInput = (input) => {
      const record = active;
      if (!record || record.finished) return null;
      if (input?.sessionId && input.sessionId !== record.sessionId) return null;
      const outcome = record.state.apply(input);
      if (outcome.type === "navigate") {
        try { record.ctx?.ui?.setWidget?.("agent-utils-choice", renderChoiceWidget(record.question, record.state.choices, outcome.index), { placement: "belowEditor" }); } catch {}
        try { record.onUpdate?.({ content: [{ type: "text", text: `highlighted ${outcome.index + 1}: ${outcome.choice.headline}` }] }); } catch {}
        if (outcome.changed && choiceConfig.speechEnabled) speakerController.speak(outcome.choice.headline).catch((error) => {
          if (record.warnedSpeech) return;
          record.warnedSpeech = true;
          try { record.ctx?.ui?.notify?.(`choice speech unavailable; input remains active: ${error?.message || String(error)}`, "warning"); } catch {}
        });
      } else if (outcome.type === "selected") {
        finish(record, { status: "selected", index: outcome.index, choice: outcome.choice, source: outcome.source || input?.source || "event" });
      } else if (outcome.type === "cancelled") {
        if (input?.source === "keyboard" && input?.raw === "\u001b") awaitFreeformAfterEscape(record);
        else finish(record, { status: "cancelled", reason: input?.source || "event", index: outcome.index, choice: outcome.choice });
      }
      return outcome;
    };

    const eventInputHandler = (input) => { handleInput(input); };
    pi.events?.on?.(INPUT_ACTION_EVENT, eventInputHandler);
    pi.registerMessageRenderer?.(FORCE_CHOICE_CUSTOM_TYPE, (message, _options, theme) => ({
      render: (width) => [theme.fg("dim", String(message.content || "").slice(0, width))],
      invalidate() {},
    }));

    const elicit = async (params, ctx, signal, onUpdate) => {
      const question = String(params?.question ?? params?.prompt ?? "").trim();
      if (!question) throw new Error("choice: question is required");
      // Any real choice presentation satisfies a pending /force-choice request.
      forcedRequestOutstanding = false;
      warnedUnsatisfiedForce = false;
      const choices = normalizeChoices(params?.choices);
      if (choices.length > choiceConfig.maxChoices) throw new Error(`choice: at most ${choiceConfig.maxChoices} choices are configured (maximum 9 for numeric selection)`);
      const timeoutMs = Number.isFinite(Number(params?.timeoutMs))
        ? Math.max(0, Math.min(300_000, Math.trunc(Number(params.timeoutMs))))
        : choiceConfig.timeoutMs;
      cancelActive();
      const state = new ChoiceStateMachine({ choices, initialIndex: params?.initialIndex, wrap: params?.wrap ?? choiceConfig.wrap });
      const sessionId = `choice-${nextSessionId++}`;

      const result = await new Promise((resolve) => {
        const record = {
          sessionId,
          question,
          state,
          ctx,
          signal,
          onUpdate,
          resolve,
          timeoutMs,
          timer: null,
          terminalUnsub: null,
          onAbort: null,
          warnedSpeech: false,
          awaitingFreeform: false,
          sessionEnded: false,
          finished: false,
        };
        active = record;
        record.onAbort = () => finish(record, { status: "cancelled", reason: "aborted", index: state.index, choice: state.current() });
        signal?.addEventListener?.("abort", record.onAbort, { once: true });
        record.terminalUnsub = ctx?.ui?.onTerminalInput?.((data) => {
          const input = keyboardChoiceAction(data, choices.length);
          if (!input) return undefined;
          // Keyboard is another event producer, not a privileged state-machine path.
          try { pi.events?.emit?.(INPUT_ACTION_EVENT, { ...input, sessionId }); } catch { handleInput({ ...input, sessionId }); }
          return { consume: true };
        }) || null;
        // Keep the process alive while an interactive tool is awaiting input;
        // unlike background refresh timers, this timeout resolves a live call.
        if (timeoutMs > 0) record.timer = setTimeout(() => finish(record, { status: "timeout", timeoutMs, index: state.index, choice: state.current() }), timeoutMs);
        try { ctx?.ui?.setWidget?.("agent-utils-choice", renderChoiceWidget(question, choices, state.index), { placement: "belowEditor" }); } catch {}
        emitSession({
          status: "started",
          sessionId,
          question,
          choiceCount: choices.length,
          timeoutMs,
          ring: params?.ring ?? null,
        });
        if (choiceConfig.speechEnabled) speakerController.speak(formatChoiceIntroduction(question, choices, state.index)).catch((error) => {
          if (record.warnedSpeech || record.finished) return;
          record.warnedSpeech = true;
          try { ctx?.ui?.notify?.(`choice speech unavailable; input remains active: ${error?.message || String(error)}`, "warning"); } catch {}
        });
      });
      return result;
    };

    if (typeof pi.registerTool === "function") {
      pi.registerTool({
        name: "interactive_choice",
        label: "Interactive Choice",
        description: "Present a spoken multiple-choice question. Supports arrows, j/k, Enter, one-indexed numeric keys, cancellation, and external input adapters such as Finger One ring events.",
        promptSnippet: "Use interactive_choice for bounded user decisions that can be answered by keyboard or configured input adapters such as the Finger One ring.",
        promptGuidelines: [
          "Keep choice headlines short and distinct for speech and gesture navigation.",
          "Treat timeout or cancellation as no selection; never infer an answer.",
        ],
        parameters: ToolSchema.Object({
          question: ToolSchema.String({ description: "Question to speak and display." }),
          choices: ToolSchema.Array(ToolSchema.Object({
            label: ToolSchema.String({ description: "Stable choice label returned on selection." }),
            headline: ToolSchema.Optional(ToolSchema.String({ description: "Short spoken/display headline; defaults to label." })),
            summary: ToolSchema.Optional(ToolSchema.String({ description: "Optional short explanation spoken in the initial list." })),
            value: ToolSchema.Optional(ToolSchema.Any({ description: "Optional caller value returned in details." })),
          }), { minItems: 2, maxItems: 9 }),
          timeoutMs: ToolSchema.Optional(ToolSchema.Integer({ minimum: 0, maximum: 300000, description: "Selection timeout in milliseconds (default 30000); 0 disables timeout." })),
          initialIndex: ToolSchema.Optional(ToolSchema.Integer({ minimum: 0, maximum: 8, description: "Initially highlighted zero-based index." })),
          wrap: ToolSchema.Optional(ToolSchema.Boolean({ description: "Wrap navigation at list ends (default true); false clamps." })),
          ring: ToolSchema.Optional(ToolSchema.String({ description: "Optional ring name accepted by the ring input adapter." })),
        }),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          try {
            const result = await elicit(params, ctx, signal, onUpdate);
            return { content: [{ type: "text", text: resultText(result) }], details: result };
          } catch (error) {
            const result = { status: "error", error: error?.message || String(error) };
            return { content: [{ type: "text", text: resultText(result) }], details: result };
          }
        },
      });
    }

    pi.registerCommand("choice", {
      description: "Ask a spoken multi-input choice. Usage: /choice Question | Choice A | Choice B [| ...]; /choice cancel|status|settings key=value",
      handler: async (args, ctx) => {
        const raw = String(args || "").trim();
        if (raw.toLowerCase() === "cancel") {
          ctx.ui.notify(cancelActive("command") ? "choice cancelled" : "no active choice", "info");
          return;
        }
        if (raw.toLowerCase() === "status") {
          const state = active ? "active" : lastResult ? resultText(lastResult) : "idle";
          ctx.ui.notify(`choice:${state} · timeout=${choiceConfig.timeoutMs === 0 ? "off" : `${choiceConfig.timeoutMs}ms`} · wrap=${choiceConfig.wrap} · max=${choiceConfig.maxChoices} · speech=${choiceConfig.speechEnabled} · force-at-end=${choiceConfig.forceAtAgentEnd}`, "info");
          return;
        }
        if (/^settings(?:\s|$)/i.test(raw)) {
          try {
            const parsed = parseEnvStyleArgs(raw.replace(/^settings\s*/i, ""));
            if (parsed.positionals.length) throw new Error(`/choice settings: unexpected '${parsed.positionals[0]}'`);
            const allowed = new Set(["timeout", "timeout_ms", "wrap", "max", "max_choices", "speech", "speech_enabled", "force", "force_at_end"]);
            for (const key of Object.keys(parsed.values)) if (!allowed.has(key)) throw new Error(`/choice settings: unknown '${key}'`);
            const number = (keys, field, min, max) => {
              const key = keys.find((candidate) => Object.hasOwn(parsed.values, candidate));
              if (!key) return;
              const value = Number(parsed.values[key]);
              if (!Number.isFinite(value) || value < min || value > max) throw new Error(`/choice settings: ${key} must be ${min}..${max}`);
              choiceConfig[field] = Math.trunc(value);
              persistChoiceSetting(field, choiceConfig[field], settingsPath);
            };
            const boolean = (keys, field) => {
              const key = keys.find((candidate) => Object.hasOwn(parsed.values, candidate));
              if (!key) return;
              const rawValue = String(parsed.values[key]).toLowerCase();
              if (!["1", "true", "yes", "on", "0", "false", "no", "off"].includes(rawValue)) throw new Error(`/choice settings: ${key} must be true or false`);
              choiceConfig[field] = ["1", "true", "yes", "on"].includes(rawValue);
              persistChoiceSetting(field, choiceConfig[field], settingsPath);
            };
            number(["timeout", "timeout_ms"], "timeoutMs", 0, 300000);
            number(["max", "max_choices"], "maxChoices", 2, 9);
            boolean(["wrap"], "wrap");
            boolean(["speech", "speech_enabled"], "speechEnabled");
            boolean(["force", "force_at_end"], "forceAtAgentEnd");
            ctx.ui.notify(`choice settings: timeout=${choiceConfig.timeoutMs === 0 ? "off" : `${choiceConfig.timeoutMs}ms`} wrap=${choiceConfig.wrap} max=${choiceConfig.maxChoices} speech=${choiceConfig.speechEnabled} force-at-end=${choiceConfig.forceAtAgentEnd}`, "info");
          } catch (error) { ctx.ui.notify(error?.message || String(error), "warning"); }
          return;
        }
        const parts = raw.split("|").map((part) => part.trim()).filter(Boolean);
        if (parts.length < 3) {
          ctx.ui.notify("Usage: /choice Question | Choice A | Choice B [| ...]", "warning");
          return;
        }
        const [question, ...labels] = parts;
        const result = await elicit({ question, choices: labels.map((label) => ({ label })) }, ctx);
        ctx.ui.notify(resultText(result), result.status === "selected" ? "info" : "warning");
      },
    });

    pi.registerCommand("force-choice", {
      description: "Require an interactive choice whenever the agent would otherwise stop. Usage: /force-choice [on|off|status]",
      handler: async (args, ctx) => {
        const action = String(args || "on").trim().toLowerCase() || "on";
        if (action === "status") {
          ctx.ui.notify(`force-choice:${choiceConfig.forceAtAgentEnd ? "on" : "off"}${forcedRequestOutstanding ? " · awaiting choice" : ""}`, "info");
          return;
        }
        if (!["on", "off"].includes(action)) { ctx.ui.notify("Usage: /force-choice [on|off|status]", "warning"); return; }
        choiceConfig.forceAtAgentEnd = action === "on";
        persistChoiceSetting("forceAtAgentEnd", choiceConfig.forceAtAgentEnd, settingsPath);
        if (!choiceConfig.forceAtAgentEnd) {
          forcedRequestOutstanding = false;
          warnedUnsatisfiedForce = false;
        }
        ctx.ui.notify(`force-choice:${choiceConfig.forceAtAgentEnd ? "on" : "off"} (persisted)`, "info");
      },
    });

    pi.on("agent_end", (_event, ctx) => {
      if (!choiceConfig.forceAtAgentEnd || active) return;
      if (forcedRequestOutstanding) {
        if (!warnedUnsatisfiedForce) {
          warnedUnsatisfiedForce = true;
          try { ctx?.ui?.notify?.("force-choice request ended without presenting interactive_choice; standing down to avoid a retry loop.", "warning"); } catch {}
        }
        return;
      }
      forcedRequestOutstanding = true;
      warnedUnsatisfiedForce = false;
      pi.sendMessage({
        customType: FORCE_CHOICE_CUSTOM_TYPE,
        content: "[force choice] I have reached an otherwise stopping point. Present interactive_choice now with 2–5 concise, concrete next actions. Include an option labelled exactly 'Stop continuous choices' when stopping is reasonable. Do not answer this control message in prose before the choice.",
        display: true,
        details: { source: "/force-choice", requiredTool: "interactive_choice" },
      }, { deliverAs: "followUp", triggerTurn: true });
    });

    pi.on("input", () => {
      // If Escape dismissed a visible choice, the next actual submitted user
      // input releases the pending tool. Returning continue leaves that input to
      // Pi's normal path; this extension never sends or rewrites it.
      if (active?.awaitingFreeform) {
        finish(active, { status: "cancelled", reason: "freeform", index: active.state.index, choice: active.state.current() });
      }
      return { action: "continue" };
    });

    pi.on("session_shutdown", () => {
      cancelActive("shutdown");
      try { pi.events?.off?.(INPUT_ACTION_EVENT, eventInputHandler); } catch {}
      try { speakerController.dispose?.(); } catch {}
    });
  };
}

export default createChoiceExtension();
