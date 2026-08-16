// Generic spoken multi-input choice extension (bd-8b3005).
//
// Inputs are event-based. This extension owns question/choice state, UI, TTS,
// timeout, and keyboard controls; device adapters (such as ring-input.js) emit
// the same semantic actions on CHOICE_INPUT_EVENT.

import { expandEnvReferences, parseEnvStyleArgs } from "./lib/env-args.js";
import { ToolSchema } from "./lib/tool-schema.js";
import {
  INPUT_ACTION_EVENT,
  CHOICE_SESSION_EVENT,
  DEFAULT_CHOICE_TIMEOUT_MS,
  ChoiceStateMachine,
  createChoiceSpeaker,
  formatChoiceIntroduction,
  isChoiceEscapeKey,
  isChoiceQuitKey,
  keyboardChoiceAction,
  normalizeChoices,
} from "./lib/choice.js";
import {
  persistChoiceSetting,
  readPersistedChoiceSettings,
  readPersistedTtsSettings,
} from "./lib/tts-settings.js";

export const FORCE_CHOICE_CUSTOM_TYPE = "agent-utils-force-choice";
const ENV_REFERENCE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

function boolSetting(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function resolveChoiceSettings(env, persisted = {}) {
  const number = (envKey, field, fallback, min, max) => {
    const raw = env[envKey] ?? persisted[field];
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
  };
  const repeatIntervalRaw = env.PI_CHOICE_REPEAT_INTERVAL ?? persisted.repeat?.interval ?? 300;
  const repeatInterval = Number(repeatIntervalRaw);
  const repeatLimitRaw = env.PI_CHOICE_REPEAT_LIMIT ?? persisted.repeat?.limit ?? null;
  const repeatLimitNumber = Number(repeatLimitRaw);
  const repeatLimit = repeatLimitRaw == null || ["", "none", "null", "unlimited"].includes(String(repeatLimitRaw).trim().toLowerCase())
    ? null
    : Number.isFinite(repeatLimitNumber) && repeatLimitNumber >= 0 ? Math.trunc(repeatLimitNumber) : null;
  return {
    timeoutMs: number("PI_CHOICE_TIMEOUT_MS", "timeoutMs", DEFAULT_CHOICE_TIMEOUT_MS, 0, 300000),
    maxChoices: number("PI_CHOICE_MAX_CHOICES", "maxChoices", 9, 2, 9),
    wrap: boolSetting(env.PI_CHOICE_WRAP, boolSetting(persisted.wrap, true)),
    speechEnabled: boolSetting(env.PI_CHOICE_SPEECH_ENABLED, boolSetting(persisted.speechEnabled, true)),
    descriptionOnNavigate: boolSetting(env.PI_CHOICE_DESCRIPTION_ON_NAVIGATE, boolSetting(persisted.descriptionOnNavigate, true)),
    forceAtAgentEnd: boolSetting(env.PI_FORCE_CHOICE, boolSetting(persisted.forceAtAgentEnd, false)),
    prefix: expandEnvReferences(env.PI_CHOICE_PREFIX ?? persisted.prefix ?? "", env, "/choice prefix"),
    suffix: expandEnvReferences(env.PI_CHOICE_SUFFIX ?? persisted.suffix ?? "", env, "/choice suffix"),
    repeat: {
      interval: Number.isFinite(repeatInterval) && repeatInterval > 0 ? repeatInterval : 300,
      limit: repeatLimit,
    },
  };
}

function renderChoiceWidget(question, choices, index, status = "listening") {
  const normalized = normalizeChoices(choices);
  return [
    `◇ ${String(question || "Choose one").trim()} · ${status}`,
    ...normalized.map((choice, i) => `${i === index ? "▶" : " "} ${i + 1}. ${choice.headline}${choice.summary ? ` — ${choice.summary}` : ""}`),
    "↑/k previous · ↓/j next · Enter choose · 1-9 direct · Esc/q cancel (hard stop in force mode)",
  ];
}

function renderChoiceDialog(question, choices, index, timeoutMs, width, theme) {
  const color = (name, text) => { try { return theme?.fg?.(name, text) ?? text; } catch { return text; } };
  const bold = (text) => { try { return theme?.bold?.(text) ?? text; } catch { return text; } };
  const maxWidth = Math.max(20, width || 80);
  const fit = (text, limit = maxWidth) => {
    const raw = String(text ?? "");
    return raw.length <= limit ? raw : `${raw.slice(0, Math.max(1, limit - 1))}…`;
  };
  const lines = [color("accent", "━".repeat(maxWidth)), color("text", bold(fit(`◇ ${question}`, maxWidth))) , ""];
  for (let i = 0; i < choices.length; i++) {
    const selected = i === index;
    const marker = selected ? color("accent", "◆") : color("dim", "·");
    const number = selected ? color("accent", bold(`${i + 1}.`)) : color("muted", `${i + 1}.`);
    const room = Math.max(4, maxWidth - 7);
    const label = fit(choices[i].headline, room);
    lines.push(`${marker} ${number} ${selected ? color("accent", bold(label)) : color("text", label)}`);
    if (choices[i].summary) lines.push(`    ${color(selected ? "muted" : "dim", fit(choices[i].summary, Math.max(4, maxWidth - 4)))}`);
  }
  lines.push("");
  lines.push(`${color("accent", "↑/k")} ${color("dim", "previous")}  ${color("accent", "↓/j")} ${color("dim", "next")}  ${color("success", "Enter / 1–9")} ${color("dim", "choose")}  ${color("warning", "Esc/q")} ${color("dim", "cancel · hard stop in force mode")}`);
  lines.push(color("dim", timeoutMs === 0 ? "No timeout · editor input is suspended while this choice is open" : `Timeout: ${timeoutMs}ms · editor input is suspended while this choice is open`));
  lines.push(color("accent", "━".repeat(maxWidth)));
  return lines;
}

function resultText(result) {
  if (result?.status === "selected") return `selected ${result.index + 1}: ${result.choice?.label}`;
  if (result?.status === "timeout") return `choice timed out after ${result.timeoutMs}ms`;
  if (result?.status === "cancelled") return `choice cancelled (${result.reason || "cancelled"})`;
  return `choice failed: ${result?.error || "unknown error"}`;
}

export function createChoiceExtension({ speaker, env = process.env, settingsPath, persistedSettings, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
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

    const releaseChoiceUi = (record, result = null) => {
      if (record.timer) clearTimer(record.timer);
      record.timer = null;
      if (record.repeatTimer) clearTimer(record.repeatTimer);
      record.repeatTimer = null;
      try { record.terminalUnsub?.(); } catch {}
      record.terminalUnsub = null;
      if (record.customDone) {
        const done = record.customDone;
        record.customDone = null;
        try { done(result); } catch {}
      }
      // Cancellation/selection must stop an in-flight spoken prompt immediately;
      // Escape should not leave the old question talking over freeform input.
      try { speakerController.interrupt?.(); } catch {}
      try { record.ctx?.ui?.setWidget?.("agent-utils-choice", undefined); } catch {}
    };

    const finish = (record, result) => {
      if (!record || record.finished) return;
      record.finished = true;
      releaseChoiceUi(record, result);
      record.signal?.removeEventListener?.("abort", record.onAbort);
      if (active === record) active = null;
      lastResult = result;
      if (
        choiceConfig.forceAtAgentEnd && result?.status === "selected" &&
        /^(?:stop|idle|pause|finish|stop continuous choices)$/i.test(String(result.choice?.label || "").trim())
      ) {
        choiceConfig.forceAtAgentEnd = false;
        forcedRequestOutstanding = false;
      }
      endInputSession(record, result);
      record.resolve(result);
    };

    const awaitFreeformAfterEscape = (record) => {
      if (!record || record.finished || record.awaitingFreeform) return;
      record.awaitingFreeform = true;
      releaseChoiceUi(record, { status: "dismissed", reason: "freeform-pending" });
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
        if (record.requestRender) { try { record.requestRender(); } catch {} }
        else { try { record.ctx?.ui?.setWidget?.("agent-utils-choice", renderChoiceWidget(record.question, record.state.choices, outcome.index), { placement: "belowEditor" }); } catch {} }
        try { record.onUpdate?.({ content: [{ type: "text", text: `highlighted ${outcome.index + 1}: ${outcome.choice.headline}` }] }); } catch {}
        if (outcome.changed && choiceConfig.speechEnabled) {
          const navigationSpeech = choiceConfig.descriptionOnNavigate && outcome.choice.summary
            ? `${outcome.choice.headline}. ${outcome.choice.summary}`
            : outcome.choice.headline;
          speakerController.speak(navigationSpeech).catch((error) => {
            if (record.warnedSpeech) return;
            record.warnedSpeech = true;
            try { record.ctx?.ui?.notify?.(`choice speech unavailable; input remains active: ${error?.message || String(error)}`, "warning"); } catch {}
          });
        }
      } else if (outcome.type === "selected") {
        finish(record, { status: "selected", index: outcome.index, choice: outcome.choice, source: outcome.source || input?.source || "event" });
      } else if (outcome.type === "cancelled") {
        const keyboardEscape = input?.source === "keyboard" && isChoiceEscapeKey(input?.raw);
        const keyboardQuit = input?.source === "keyboard" && isChoiceQuitKey(input?.raw);
        if (choiceConfig.forceAtAgentEnd && (keyboardEscape || keyboardQuit)) {
          // Escape and q/Q are hard stops for this session. The durable setting
          // is startup policy and stays untouched.
          choiceConfig.forceAtAgentEnd = false;
          forcedRequestOutstanding = false;
          finish(record, { status: "cancelled", reason: keyboardQuit ? "quit-stop" : "escape-stop", index: outcome.index, choice: outcome.choice });
        } else if (keyboardEscape) awaitFreeformAfterEscape(record);
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
      const promptPrefix = params?.prefix !== undefined ? expandEnvReferences(params.prefix, env, "interactive_choice prefix") : choiceConfig.prefix;
      const promptSuffix = params?.suffix !== undefined ? expandEnvReferences(params.suffix, env, "interactive_choice suffix") : choiceConfig.suffix;
      if (choices.length > choiceConfig.maxChoices) throw new Error(`choice: at most ${choiceConfig.maxChoices} choices are configured (maximum 9 for numeric selection)`);
      // A durable timeoutMs=0 is an operator policy, not merely a default: it
      // must defeat model-generated timeoutMs=30000 arguments.
      const timeoutMs = choiceConfig.timeoutMs === 0
        ? 0
        : Number.isFinite(Number(params?.timeoutMs))
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
          repeatTimer: null,
          repeatCount: 0,
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
        const dispatchKeyboard = (data) => {
          const input = keyboardChoiceAction(data, choices.length);
          if (!input) return false;
          // Keyboard is another event producer, not a privileged state-machine path.
          try { pi.events?.emit?.(INPUT_ACTION_EVENT, { ...input, sessionId }); } catch { handleInput({ ...input, sessionId }); }
          return true;
        };
        if (ctx?.mode === "tui" && typeof ctx?.ui?.custom === "function") {
          // A true modal component owns terminal focus. Unknown keys are
          // deliberately swallowed instead of leaking into the editor; Escape
          // closes the modal and restores normal editor focus.
          void ctx.ui.custom((tui, theme, _kb, done) => {
            record.customDone = done;
            record.requestRender = () => tui.requestRender();
            return {
              render: (width) => renderChoiceDialog(question, choices, state.index, timeoutMs, width, theme),
              invalidate() { tui.requestRender(); },
              handleInput(data) { dispatchKeyboard(data); },
            };
          }).catch((error) => {
            if (!record.finished) finish(record, { status: "error", error: error?.message || String(error), index: state.index, choice: state.current() });
          });
        } else {
          // RPC/older-runtime fallback: consume recognized controls through the
          // terminal-input hook and render a normal widget.
          record.terminalUnsub = ctx?.ui?.onTerminalInput?.((data) => dispatchKeyboard(data) ? { consume: true } : undefined) || null;
          try { ctx?.ui?.setWidget?.("agent-utils-choice", renderChoiceWidget(question, choices, state.index), { placement: "belowEditor" }); } catch {}
        }
        // Keep the process alive while an interactive tool is awaiting input;
        // unlike background refresh timers, this timeout resolves a live call.
        if (timeoutMs > 0) record.timer = setTimer(() => finish(record, { status: "timeout", timeoutMs, index: state.index, choice: state.current() }), timeoutMs);
        emitSession({
          status: "started",
          sessionId,
          question,
          choiceCount: choices.length,
          timeoutMs,
          ring: params?.ring ?? null,
          prefix: promptPrefix,
          suffix: promptSuffix,
          repeat: { ...choiceConfig.repeat },
        });
        const speakIntroduction = () => speakerController.speak(formatChoiceIntroduction(question, choices, state.index, { prefix: promptPrefix, suffix: promptSuffix })).catch((error) => {
          if (record.warnedSpeech || record.finished) return;
          record.warnedSpeech = true;
          try { ctx?.ui?.notify?.(`choice speech unavailable; input remains active: ${error?.message || String(error)}`, "warning"); } catch {}
        });
        const scheduleRepeat = () => {
          if (!choiceConfig.speechEnabled || record.finished) return;
          if (choiceConfig.repeat.limit != null && record.repeatCount >= choiceConfig.repeat.limit) return;
          record.repeatTimer = setTimer(() => {
            record.repeatTimer = null;
            if (record.finished) return;
            record.repeatCount += 1;
            void speakIntroduction();
            scheduleRepeat();
          }, choiceConfig.repeat.interval * 1000);
        };
        if (choiceConfig.speechEnabled) {
          void speakIntroduction();
          scheduleRepeat();
        }
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
          prefix: ToolSchema.Optional(ToolSchema.String({ description: "Speech-only text placed before the initial choice question." })),
          suffix: ToolSchema.Optional(ToolSchema.String({ description: "Speech-only text placed after the initial choice question, before the unmodified options." })),
        }),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          try {
            const result = await elicit(params, ctx, signal, onUpdate);
            return {
              content: [{ type: "text", text: resultText(result) }],
              details: result,
              // In a forced-choice run the choice is the sole final tool. Escape
              // or q disables runtime force mode and terminates the automatic
              // follow-up LLM call, so the agent actually stops.
              terminate: result.reason === "escape-stop" || result.reason === "quit-stop",
            };
          } catch (error) {
            const result = { status: "error", error: error?.message || String(error) };
            return { content: [{ type: "text", text: resultText(result) }], details: result };
          }
        },
      });
    }

    pi.registerCommand("choice", {
      description: "Ask a spoken multi-input choice. Usage: /choice Question | Choice A | Choice B [| ...]; /choice cancel|status|settings prefix='...' suffix='...' key=value",
      handler: async (args, ctx) => {
        const raw = String(args || "").trim();
        if (raw.toLowerCase() === "cancel") {
          ctx.ui.notify(cancelActive("command") ? "choice cancelled" : "no active choice", "info");
          return;
        }
        if (raw.toLowerCase() === "status") {
          const state = active ? "active" : lastResult ? resultText(lastResult) : "idle";
          ctx.ui.notify(`choice:${state} · timeout=${choiceConfig.timeoutMs === 0 ? "off" : `${choiceConfig.timeoutMs}ms`} · wrap=${choiceConfig.wrap} · max=${choiceConfig.maxChoices} · speech=${choiceConfig.speechEnabled} · descriptions-on-navigate=${choiceConfig.descriptionOnNavigate} · prefix=${choiceConfig.prefix ? "set" : "none"} · suffix=${choiceConfig.suffix ? "set" : "none"} · repeat=${choiceConfig.repeat.interval}s/${choiceConfig.repeat.limit ?? "unlimited"} · force-at-end=${choiceConfig.forceAtAgentEnd}`, "info");
          return;
        }
        if (/^settings(?:\s|$)/i.test(raw)) {
          try {
            const parsed = parseEnvStyleArgs(raw.replace(/^settings\s*/i, ""));
            if (parsed.positionals.length) throw new Error(`/choice settings: unexpected '${parsed.positionals[0]}'`);
            const allowed = new Set(["timeout", "timeout_ms", "wrap", "max", "max_choices", "speech", "speech_enabled", "description", "descriptions", "description_on_navigate", "force", "force_at_end", "prefix", "suffix", "repeat.interval", "repeat_interval", "repeat.limit", "repeat_limit"]);
            for (const key of Object.keys(parsed.values)) if (!allowed.has(key)) throw new Error(`/choice settings: unknown '${key}'`);
            const number = (keys, field, min, max) => {
              const key = keys.find((candidate) => Object.hasOwn(parsed.values, candidate));
              if (!key) return;
              const value = Number(parsed.values[key]);
              if (!Number.isFinite(value) || value < min || value > max) throw new Error(`/choice settings: ${key} must be ${min}..${max}`);
              choiceConfig[field] = Math.trunc(value);
              persistChoiceSetting(field, choiceConfig[field], settingsPath);
            };
            const boolean = (keys, field, { persist = true } = {}) => {
              const key = keys.find((candidate) => Object.hasOwn(parsed.values, candidate));
              if (!key) return;
              const rawValue = String(parsed.values[key]).toLowerCase();
              if (!["1", "true", "yes", "on", "0", "false", "no", "off"].includes(rawValue)) throw new Error(`/choice settings: ${key} must be true or false`);
              choiceConfig[field] = ["1", "true", "yes", "on"].includes(rawValue);
              if (persist) persistChoiceSetting(field, choiceConfig[field], settingsPath);
            };
            const affix = (key, field) => {
              if (!Object.hasOwn(parsed.values, key)) return;
              choiceConfig[field] = expandEnvReferences(parsed.values[key], env, `/choice ${key}`);
              if (!ENV_REFERENCE.test(String(parsed.values[key]))) persistChoiceSetting(field, choiceConfig[field], settingsPath);
            };
            let repeatChanged = false;
            const repeatIntervalKey = ["repeat.interval", "repeat_interval"].find((key) => Object.hasOwn(parsed.values, key));
            if (repeatIntervalKey) {
              const value = Number(parsed.values[repeatIntervalKey]);
              if (!Number.isFinite(value) || value <= 0 || value > 86400) throw new Error(`/choice settings: ${repeatIntervalKey} must be greater than zero and at most 86400 seconds`);
              choiceConfig.repeat.interval = value;
              repeatChanged = true;
            }
            const repeatLimitKey = ["repeat.limit", "repeat_limit"].find((key) => Object.hasOwn(parsed.values, key));
            if (repeatLimitKey) {
              const rawLimit = String(parsed.values[repeatLimitKey]).trim().toLowerCase();
              if (["", "none", "null", "unlimited"].includes(rawLimit)) choiceConfig.repeat.limit = null;
              else {
                const value = Number(rawLimit);
                if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) throw new Error(`/choice settings: ${repeatLimitKey} must be a non-negative integer or null`);
                choiceConfig.repeat.limit = value;
              }
              repeatChanged = true;
            }
            number(["timeout", "timeout_ms"], "timeoutMs", 0, 300000);
            number(["max", "max_choices"], "maxChoices", 2, 9);
            boolean(["wrap"], "wrap");
            boolean(["speech", "speech_enabled"], "speechEnabled");
            boolean(["description", "descriptions", "description_on_navigate"], "descriptionOnNavigate");
            boolean(["force", "force_at_end"], "forceAtAgentEnd", { persist: false });
            affix("prefix", "prefix");
            affix("suffix", "suffix");
            if (repeatChanged) persistChoiceSetting("repeat", { ...choiceConfig.repeat }, settingsPath);
            ctx.ui.notify(`choice settings: timeout=${choiceConfig.timeoutMs === 0 ? "off" : `${choiceConfig.timeoutMs}ms`} wrap=${choiceConfig.wrap} max=${choiceConfig.maxChoices} speech=${choiceConfig.speechEnabled} descriptions-on-navigate=${choiceConfig.descriptionOnNavigate} prefix=${choiceConfig.prefix ? "set" : "none"} suffix=${choiceConfig.suffix ? "set" : "none"} repeat=${choiceConfig.repeat.interval}s/${choiceConfig.repeat.limit ?? "unlimited"} force-at-end=${choiceConfig.forceAtAgentEnd}`, "info");
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
        if (!choiceConfig.forceAtAgentEnd) {
          forcedRequestOutstanding = false;
          warnedUnsatisfiedForce = false;
        }
        ctx.ui.notify(`force-choice:${choiceConfig.forceAtAgentEnd ? "on" : "off"} (runtime; startup setting unchanged)`, "info");
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
