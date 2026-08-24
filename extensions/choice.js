// Generic spoken multi-input choice extension (bd-8b3005).
//
// Inputs are event-based. This extension owns question/choice state, UI, TTS,
// timeout, and keyboard controls; device adapters (such as ring-input.js) emit
// the same semantic actions on CHOICE_INPUT_EVENT.

import { expandEnvReferences, parseEnvStyleArgs } from "./lib/env-args.js";
import { ToolSchema } from "./lib/tool-schema.js";
import { createCacophonyChoiceBridge } from "./lib/cacophony-choice.js";
import {
  INPUT_ACTION_EVENT,
  INPUT_ACTIONS,
  CHOICE_SESSION_EVENT,
  DEFAULT_CHOICE_TIMEOUT_MS,
  ChoiceStateMachine,
  createChoiceSpeaker,
  formatChoiceIntroduction,
  isChoiceEnterKey,
  isChoiceEscapeKey,
  isChoiceQuitKey,
  keyboardChoiceAction,
  normalizeChoices,
} from "./lib/choice.js";
import {
  readPersistedChoiceSettings,
  readPersistedTtsSettings,
} from "./lib/tts-settings.js";

export const FORCE_CHOICE_CUSTOM_TYPE = "agent-utils-force-choice";
export const CHOICE_CACOPHONY_ACTIONS = Object.freeze(["freeformReply", "discard"]);

function boolSetting(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function normalizeChoiceAppendEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const headline = String(entry.title ?? entry.headline ?? "").trim();
    const summary = String(entry.description ?? entry.summary ?? "").trim();
    const cacophonyAction = String(entry.cacophonyAction ?? "").trim();
    if (!headline || !CHOICE_CACOPHONY_ACTIONS.includes(cacophonyAction)) return [];
    return [{
      label: headline,
      headline,
      summary,
      value: { cacophonyAction },
      tts: entry.tts !== false,
      terminal: entry.terminal === true,
      cacophonyAction,
      appended: true,
    }];
  });
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
    append: normalizeChoiceAppendEntries(persisted.append),
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

function renderChoiceDialog(question, choices, index, timeoutMs, width, theme, freeform = {}) {
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
  if (freeform.mode === "text") {
    lines.push(`${color("accent", "Reply:")} ${color("text", fit(freeform.text || "", Math.max(4, maxWidth - 9)))}${color("accent", "▏")}`);
    lines.push(`${color("success", "Enter")} ${color("dim", "submit reply")}  ${color("warning", "Esc")} ${color("dim", "back to choices")}  ${color("muted", "Backspace")} ${color("dim", "delete")}`);
  } else if (freeform.mode === "ptt") {
    lines.push(color("accent", "🎤 Push-to-talk reply is recording/transcribing…"));
    lines.push(`${color("success", "Enter / Space")} ${color("dim", "finish")}  ${color("warning", "Esc / Ctrl-C")} ${color("dim", "cancel and return")}`);
  } else {
    lines.push(`${color("accent", "↑/k")} ${color("dim", "previous")}  ${color("accent", "↓/j")} ${color("dim", "next")}  ${color("success", "Enter / 1–9")} ${color("dim", "choose")}  ${color("accent", "i")} ${color("dim", "type reply")}  ${color("accent", "Space")} ${color("dim", "PTT reply")}  ${color("warning", "Esc/q")} ${color("dim", "cancel")}`);
  }
  lines.push(color("dim", timeoutMs === 0 ? "No timeout · editor input is suspended while this choice is open" : `Timeout: ${timeoutMs}ms · editor input is suspended while this choice is open`));
  lines.push(color("accent", "━".repeat(maxWidth)));
  return lines;
}

function resultText(result) {
  if (result?.status === "selected") return `selected ${result.index + 1}: ${result.choice?.label}`;
  if (result?.status === "freeform") return `freeform reply: ${result.text}`;
  if (result?.status === "action") return `choice action ${result.action}: ${result.choice?.label}`;
  if (result?.status === "timeout") return `choice timed out after ${result.timeoutMs}ms`;
  if (result?.status === "cancelled") return `choice cancelled (${result.reason || "cancelled"})`;
  return `choice failed: ${result?.error || "unknown error"}`;
}

export function createChoiceExtension({ speaker, cacophonyBridge, env = process.env, settingsPath, persistedSettings, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return function choiceExtension(pi) {
    const persistedChoice = persistedSettings?.choice ?? readPersistedChoiceSettings(settingsPath);
    const choiceConfig = resolveChoiceSettings(env, persistedChoice);
    const speakerController = speaker || createChoiceSpeaker({ env, persisted: persistedSettings?.tts ?? readPersistedTtsSettings(settingsPath) });
    const cacoBridge = cacophonyBridge === false ? null : cacophonyBridge || createCacophonyChoiceBridge({ env, persisted: persistedChoice.cacophony || {}, setTimer, clearTimer });
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
      try { record.rpcAbort?.abort?.(); } catch {}
      record.rpcAbort = null;
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
      const unavailableForcedUi = record.forcedPresentation === true
        && result?.status === "error"
        && /(?:no controller client is attached|requires an attached controller client|interactive extension UI (?:is )?unavailable)/i.test(String(result?.error || ""));
      const discardedDurableForce = record.forcedPresentation === true
        && result?.source === "cacophony"
        && /discard/i.test(String(result?.reason || result?.action || ""));
      if (
        choiceConfig.forceAtAgentEnd && (
          (result?.status === "selected" && /^(?:stop|idle|pause|finish|stop continuous choices)$/i.test(String(result.choice?.label || "").trim()))
          || (result?.terminal === true && result?.action === "discard")
          || unavailableForcedUi
          || discardedDurableForce
        )
      ) {
        choiceConfig.forceAtAgentEnd = false;
        forcedRequestOutstanding = false;
        if (unavailableForcedUi) {
          try { record.ctx?.ui?.notify?.("force-choice disabled for this session: no interactive controller UI is attached.", "warning"); } catch {}
        }
      }
      endInputSession(record, result);
      void record.cacophony?.settleLocal?.(result);
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

    const pauseChoiceActivity = (record) => {
      if (record.timer) clearTimer(record.timer);
      record.timer = null;
      if (record.deadline) record.remainingTimeoutMs = Math.max(1, record.deadline - Date.now());
      if (record.repeatTimer) clearTimer(record.repeatTimer);
      record.repeatTimer = null;
      try { speakerController.interrupt?.(); } catch {}
    };

    const enterFreeform = (record, mode = "text") => {
      if (!record || record.finished) return;
      pauseChoiceActivity(record);
      record.freeformMode = mode === "ptt" ? "ptt" : "text";
      record.freeformText = "";
      if (record.requestRender) { try { record.requestRender(); } catch {} }
      else { try { record.ctx?.ui?.setWidget?.("agent-utils-choice", renderChoiceWidget(record.question, record.state.choices, record.state.index, `${record.freeformMode} reply`), { placement: "belowEditor" }); } catch {} }
      emitSession({ status: "freeform", phase: "start", mode: record.freeformMode, sessionId: record.sessionId });
    };

    const resumeChoiceList = (record, reason = "cancelled") => {
      if (!record || record.finished) return;
      const oldMode = record.freeformMode;
      record.freeformMode = null;
      record.freeformText = "";
      emitSession({ status: "freeform", phase: "cancel", mode: oldMode, reason, sessionId: record.sessionId });
      if (record.timeoutMs > 0 && record.remainingTimeoutMs > 0) {
        record.deadline = Date.now() + record.remainingTimeoutMs;
        record.timer = setTimer(() => finish(record, { status: "timeout", timeoutMs: record.timeoutMs, index: record.state.index, choice: record.state.current() }), record.remainingTimeoutMs);
      }
      record.scheduleRepeat?.();
      if (record.requestRender) { try { record.requestRender(); } catch {} }
      else { try { record.ctx?.ui?.setWidget?.("agent-utils-choice", renderChoiceWidget(record.question, record.state.choices, record.state.index), { placement: "belowEditor" }); } catch {} }
    };

    const handleInput = (input) => {
      const record = active;
      if (!record || record.finished) return null;
      if (input?.sessionId && input.sessionId !== record.sessionId) return null;
      const action = String(input?.action ?? "").trim().toLowerCase();
      if (action === INPUT_ACTIONS.FREEFORM_ENTER) {
        enterFreeform(record, input?.mode);
        return { type: "freeform-enter", mode: record.freeformMode };
      }
      if (action === INPUT_ACTIONS.FREEFORM_UPDATE) {
        if (record.freeformMode) {
          record.freeformText = String(input?.text ?? "");
          if (record.requestRender) { try { record.requestRender(); } catch {} }
        }
        return { type: "freeform-update", text: record.freeformText };
      }
      if (action === INPUT_ACTIONS.FREEFORM_SUBMIT) {
        const text = String(input?.text ?? "").trim();
        if (!text) {
          if (record.freeformMode) resumeChoiceList(record, "empty");
          return { type: "ignored", reason: "empty-freeform" };
        }
        finish(record, { status: "freeform", text, source: input?.source || "event" });
        return { type: "freeform", text };
      }
      if (action === INPUT_ACTIONS.FREEFORM_CANCEL) {
        if (record.freeformMode) resumeChoiceList(record, input?.reason || "cancelled");
        return { type: "freeform-cancel" };
      }
      if (action === INPUT_ACTIONS.FREEFORM_PTT_COMMIT) return { type: "freeform-ptt-commit" };
      const outcome = record.state.apply(input);
      if (outcome.type === "navigate") {
        if (record.requestRender) { try { record.requestRender(); } catch {} }
        else { try { record.ctx?.ui?.setWidget?.("agent-utils-choice", renderChoiceWidget(record.question, record.state.choices, outcome.index), { placement: "belowEditor" }); } catch {} }
        try { record.onUpdate?.({ content: [{ type: "text", text: `highlighted ${outcome.index + 1}: ${outcome.choice.headline}` }] }); } catch {}
        if (outcome.changed && choiceConfig.speechEnabled && outcome.choice.tts !== false) {
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
        const source = outcome.source || input?.source || "event";
        if (outcome.choice?.appended && outcome.choice?.terminal) {
          finish(record, {
            status: "cancelled",
            reason: "appended-terminal",
            action: outcome.choice.cacophonyAction,
            terminal: true,
            index: outcome.index,
            choice: outcome.choice,
            source,
          });
        } else if (outcome.choice?.appended && outcome.choice.cacophonyAction === "freeformReply") {
          // A control row enters a sub-flow; it is not itself a completed
          // ordinary selection. Re-arm the state machine so Escape can return
          // to the same list and choose again.
          record.state.done = false;
          enterFreeform(record, "text");
        } else if (outcome.choice?.appended) {
          finish(record, {
            status: "action",
            action: outcome.choice.cacophonyAction,
            terminal: false,
            index: outcome.index,
            choice: outcome.choice,
            source,
          });
        } else {
          finish(record, { status: "selected", index: outcome.index, choice: outcome.choice, source });
        }
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
      // Remember whether this presentation was requested by agent_end before
      // clearing the one-shot guard. If the controller UI cannot open, finish()
      // disables force mode for this session instead of letting the next
      // agent_end inject the same impossible request forever (bd-849b38).
      const forcedPresentation = forcedRequestOutstanding;
      forcedRequestOutstanding = false;
      warnedUnsatisfiedForce = false;
      const providedChoices = normalizeChoices(params?.choices);
      const choices = normalizeChoices([...providedChoices, ...choiceConfig.append]);
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
          cacophony: null,
          repeatCount: 0,
          deadline: timeoutMs > 0 ? Date.now() + timeoutMs : null,
          remainingTimeoutMs: timeoutMs,
          freeformMode: null,
          freeformText: "",
          scheduleRepeat: null,
          terminalUnsub: null,
          rpcAbort: null,
          onAbort: null,
          warnedSpeech: false,
          forcedPresentation,
          awaitingFreeform: false,
          sessionEnded: false,
          finished: false,
        };
        active = record;
        record.cacophony = cacoBridge?.start?.({
          question,
          choices,
          onResolution(external) {
            if (record.finished) return;
            if (external?.status === "freeform") {
              handleInput({ action: INPUT_ACTIONS.FREEFORM_SUBMIT, text: external.text, source: "cacophony", sessionId });
            } else if (external?.status === "selected" && Number.isInteger(external.index) && external.index >= 0 && external.index < choices.length) {
              handleInput({ action: INPUT_ACTIONS.CHOOSE_INDEX, index: external.index, source: "cacophony", sessionId });
            } else if (external?.status === "cancelled") {
              finish(record, { status: "cancelled", reason: external.reason || "cacophony", index: state.index, choice: state.current(), source: "cacophony" });
            }
          },
          onWarning(message) {
            if (record.warnedCacophony) return;
            record.warnedCacophony = true;
            try { ctx?.ui?.notify?.(`Cacophony choice mirror unavailable; Pi choice remains active: ${message}`, "warning"); } catch {}
          },
        }) || null;
        record.onAbort = () => finish(record, { status: "cancelled", reason: "aborted", index: state.index, choice: state.current() });
        signal?.addEventListener?.("abort", record.onAbort, { once: true });
        const emitInput = (input) => {
          try { pi.events?.emit?.(INPUT_ACTION_EVENT, { ...input, sessionId }); }
          catch { handleInput({ ...input, sessionId }); }
        };
        const dispatchKeyboard = (data) => {
          const key = String(data ?? "");
          if (record.freeformMode === "text") {
            if (isChoiceEscapeKey(key)) emitInput({ action: INPUT_ACTIONS.FREEFORM_CANCEL, source: "keyboard", reason: "escape" });
            else if (isChoiceEnterKey(key)) emitInput({ action: INPUT_ACTIONS.FREEFORM_SUBMIT, text: record.freeformText, source: "keyboard" });
            else if (key === "\u007f" || key === "\b") {
              record.freeformText = [...record.freeformText].slice(0, -1).join("");
              try { record.requestRender?.(); } catch {}
            } else if (key === "\u0003") emitInput({ action: INPUT_ACTIONS.FREEFORM_CANCEL, source: "keyboard", reason: "ctrl-c" });
            else if (key && !key.startsWith("\u001b")) {
              record.freeformText += key.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ");
              try { record.requestRender?.(); } catch {}
            }
            return true;
          }
          if (record.freeformMode === "ptt") {
            if (isChoiceEscapeKey(key) || key === "\u0003") emitInput({ action: INPUT_ACTIONS.FREEFORM_CANCEL, source: "keyboard", reason: key === "\u0003" ? "ctrl-c" : "escape" });
            else if (isChoiceEnterKey(key) || key === " ") emitInput({ action: INPUT_ACTIONS.FREEFORM_PTT_COMMIT, source: "keyboard" });
            return true;
          }
          if (key === "i" || key === "I") {
            emitInput({ action: INPUT_ACTIONS.FREEFORM_ENTER, mode: "text", source: "keyboard" });
            return true;
          }
          if (key === " ") {
            emitInput({ action: INPUT_ACTIONS.FREEFORM_ENTER, mode: "ptt", source: "keyboard" });
            return true;
          }
          const input = keyboardChoiceAction(key, choices.length);
          if (!input) return false;
          // Keyboard is another event producer, not a privileged state-machine path.
          emitInput(input);
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
              render: (width) => renderChoiceDialog(question, choices, state.index, timeoutMs, width, theme, { mode: record.freeformMode, text: record.freeformText }),
              invalidate() { tui.requestRender(); },
              handleInput(data) { dispatchKeyboard(data); },
            };
          }).catch((error) => {
            if (!record.finished) finish(record, { status: "error", error: error?.message || String(error), index: state.index, choice: state.current() });
          });
        } else if (ctx?.mode === "rpc") {
          if (typeof ctx?.ui?.select !== "function") {
            finish(record, { status: "error", error: "RPC interactive_choice requires the typed ctx.ui.select surface", index: state.index, choice: state.current() });
          } else {
            record.rpcAbort = new AbortController();
            const labels = choices.map((choice, index) => `${index + 1}. ${choice.headline}${choice.summary ? ` — ${choice.summary}` : ""}`);
            void (async () => {
              while (!record.finished) {
                let selected;
                try { selected = await ctx.ui.select(question, labels, { signal: record.rpcAbort.signal }); }
                catch (error) {
                  if (!record.finished) finish(record, { status: "error", error: error?.message || String(error), index: state.index, choice: state.current() });
                  return;
                }
                if (record.finished) return;
                if (selected === undefined) {
                  finish(record, { status: "cancelled", reason: "rpc-cancelled", index: state.index, choice: state.current(), source: "rpc" });
                  return;
                }
                const index = labels.indexOf(selected);
                if (index < 0) {
                  finish(record, { status: "error", error: "RPC choice returned an unknown option", index: state.index, choice: state.current() });
                  return;
                }
                handleInput({ action: INPUT_ACTIONS.CHOOSE_INDEX, index, source: "rpc", sessionId });
                if (record.finished) return;
                if (record.freeformMode === "text") {
                  if (typeof ctx.ui.input !== "function") {
                    finish(record, { status: "error", error: "RPC freeform choice requires the typed ctx.ui.input surface", index: state.index, choice: state.current() });
                    return;
                  }
                  let text;
                  try { text = await ctx.ui.input(`${question} — reply`, "", { signal: record.rpcAbort.signal }); }
                  catch (error) {
                    if (!record.finished) finish(record, { status: "error", error: error?.message || String(error), index: state.index, choice: state.current() });
                    return;
                  }
                  if (record.finished) return;
                  if (text === undefined) {
                    handleInput({ action: INPUT_ACTIONS.FREEFORM_CANCEL, source: "rpc", reason: "rpc-input-cancelled", sessionId });
                    continue;
                  }
                  handleInput({ action: INPUT_ACTIONS.FREEFORM_SUBMIT, text, source: "rpc", sessionId });
                  if (record.finished) return;
                }
              }
            })();
          }
        } else {
          // Older interactive runtimes may lack custom(); retain their terminal
          // hook, but never use it for RPC where terminal input is intentionally
          // unavailable and would deadlock the tool.
          record.terminalUnsub = ctx?.ui?.onTerminalInput?.((data) => dispatchKeyboard(data) ? { consume: true } : undefined) || null;
          try { ctx?.ui?.setWidget?.("agent-utils-choice", renderChoiceWidget(question, choices, state.index), { placement: "belowEditor" }); } catch {}
        }
        if (record.finished) return;
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
          if (!choiceConfig.speechEnabled || record.finished || record.freeformMode) return;
          if (choiceConfig.repeat.limit != null && record.repeatCount >= choiceConfig.repeat.limit) return;
          record.repeatTimer = setTimer(() => {
            record.repeatTimer = null;
            if (record.finished) return;
            record.repeatCount += 1;
            void speakIntroduction();
            scheduleRepeat();
          }, choiceConfig.repeat.interval * 1000);
        };
        record.scheduleRepeat = scheduleRepeat;
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
        description: "Present a spoken choice with keyboard, freeform text (i), push-to-talk (Space), numeric selection, cancellation, and external input adapters such as Finger One ring events.",
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
              terminate: result.reason === "escape-stop" || result.reason === "quit-stop" || result.terminal === true,
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
          ctx.ui.notify(`choice:${state} · timeout=${choiceConfig.timeoutMs === 0 ? "off" : `${choiceConfig.timeoutMs}ms`} · wrap=${choiceConfig.wrap} · max=${choiceConfig.maxChoices} · speech=${choiceConfig.speechEnabled} · descriptions-on-navigate=${choiceConfig.descriptionOnNavigate} · prefix=${choiceConfig.prefix ? "set" : "none"} · suffix=${choiceConfig.suffix ? "set" : "none"} · repeat=${choiceConfig.repeat.interval}s/${choiceConfig.repeat.limit ?? "unlimited"} · append=${choiceConfig.append.length} · caco=${cacoBridge?.config?.enabled ? "on" : "off"} · force-at-end=${choiceConfig.forceAtAgentEnd}`, "info");
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
            };
            const boolean = (keys, field) => {
              const key = keys.find((candidate) => Object.hasOwn(parsed.values, candidate));
              if (!key) return;
              const rawValue = String(parsed.values[key]).toLowerCase();
              if (!["1", "true", "yes", "on", "0", "false", "no", "off"].includes(rawValue)) throw new Error(`/choice settings: ${key} must be true or false`);
              choiceConfig[field] = ["1", "true", "yes", "on"].includes(rawValue);
            };
            const affix = (key, field) => {
              if (!Object.hasOwn(parsed.values, key)) return;
              choiceConfig[field] = expandEnvReferences(parsed.values[key], env, `/choice ${key}`);
            };
            const repeatIntervalKey = ["repeat.interval", "repeat_interval"].find((key) => Object.hasOwn(parsed.values, key));
            if (repeatIntervalKey) {
              const value = Number(parsed.values[repeatIntervalKey]);
              if (!Number.isFinite(value) || value <= 0 || value > 86400) throw new Error(`/choice settings: ${repeatIntervalKey} must be greater than zero and at most 86400 seconds`);
              choiceConfig.repeat.interval = value;
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
            }
            number(["timeout", "timeout_ms"], "timeoutMs", 0, 300000);
            number(["max", "max_choices"], "maxChoices", 2, 9);
            boolean(["wrap"], "wrap");
            boolean(["speech", "speech_enabled"], "speechEnabled");
            boolean(["description", "descriptions", "description_on_navigate"], "descriptionOnNavigate");
            boolean(["force", "force_at_end"], "forceAtAgentEnd");
            affix("prefix", "prefix");
            affix("suffix", "suffix");
            ctx.ui.notify(`choice settings: timeout=${choiceConfig.timeoutMs === 0 ? "off" : `${choiceConfig.timeoutMs}ms`} wrap=${choiceConfig.wrap} max=${choiceConfig.maxChoices} speech=${choiceConfig.speechEnabled} descriptions-on-navigate=${choiceConfig.descriptionOnNavigate} prefix=${choiceConfig.prefix ? "set" : "none"} suffix=${choiceConfig.suffix ? "set" : "none"} repeat=${choiceConfig.repeat.interval}s/${choiceConfig.repeat.limit ?? "unlimited"} append=${choiceConfig.append.length} force-at-end=${choiceConfig.forceAtAgentEnd}`, "info");
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
