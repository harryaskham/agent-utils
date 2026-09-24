// Generic spoken multi-input choice extension (bd-8b3005).
//
// Inputs are event-based. This extension owns question/choice state, UI, TTS,
// timeout, and keyboard controls; device adapters (such as ring-input.js) emit
// the same semantic actions on CHOICE_INPUT_EVENT.

import { expandEnvReferences, parseEnvStyleArgs } from "./lib/env-args.js";
import { ChoiceView, choiceViewKey, choicePanelRows } from "./lib/choice-layout.js";
import { createChoicePreferenceStore } from "./lib/choice-preferences.js";
import { ToolSchema } from "./lib/tool-schema.js";
import { createCacophonyChoiceBridge } from "./lib/cacophony-choice.js";
import { createAhpChoiceProvider } from "./lib/ahp-choice.js";
import {
  INPUT_ACTION_EVENT,
  INPUT_ACTIONS,
  CHOICE_CAPABILITY_EVENT,
  CHOICE_SESSION_EVENT,
  CHOICE_SYNC_REQUEST_EVENT,
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
export const MAX_CHOICE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

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
    enabled: boolSetting(env.PI_CHOICE_ENABLED, boolSetting(persisted.enabled, true)),
    timeoutMs: number("PI_CHOICE_TIMEOUT_MS", "timeoutMs", DEFAULT_CHOICE_TIMEOUT_MS, 0, MAX_CHOICE_TIMEOUT_MS),
    maxChoices: number("PI_CHOICE_MAX_CHOICES", "maxChoices", 9, 2, 9),
    wrap: boolSetting(env.PI_CHOICE_WRAP, boolSetting(persisted.wrap, true)),
    speechEnabled: boolSetting(env.PI_CHOICE_SPEECH_ENABLED, boolSetting(persisted.speechEnabled, true)),
    descriptionOnNavigate: boolSetting(env.PI_CHOICE_DESCRIPTION_ON_NAVIGATE, boolSetting(persisted.descriptionOnNavigate, true)),
    expanded: boolSetting(env.PI_CHOICE_EXPANDED, boolSetting(persisted.expanded, true)),
    fullscreen: boolSetting(env.PI_CHOICE_FULLSCREEN, boolSetting(persisted.fullscreen, false)),
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

const CHOICE_UI_UNAVAILABLE_RE = /(?:extension_ui_unavailable|no controller client is attached|requires an attached controller client|interactive extension UI (?:is )?unavailable)/i;

function resultText(result) {
  if (result?.status === "selected") return `selected ${result.index + 1}: ${result.choice?.label}`;
  if (result?.status === "freeform") return `freeform reply: ${result.text}`;
  if (result?.status === "action") return `choice action ${result.action}: ${result.choice?.label}`;
  if (result?.status === "timeout") return `choice timed out after ${result.timeoutMs}ms`;
  if (result?.status === "cancelled") return `choice cancelled (${result.reason || "cancelled"})`;
  return `choice failed: ${result?.error || "unknown error"}`;
}

function entryIsForcedChoiceRequest(entry) {
  return entry?.customType === FORCE_CHOICE_CUSTOM_TYPE
    || (entry?.type === "message" && entry?.message?.role === "custom" && entry.message.customType === FORCE_CHOICE_CUSTOM_TYPE);
}

function interactiveChoiceToolResult(entry) {
  const message = entry?.type === "message" ? entry.message : null;
  if (message?.role !== "toolResult" || message.toolName !== "interactive_choice") return null;
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((item) => item?.type === "text").map((item) => item.text || "").join("\n")
      : "";
  return [message.details?.code, message.details?.error, content].filter(Boolean).join("\n");
}

// A Pi-Daemon process may reload the fixed extension while retaining a session
// transcript produced by the old livelocking implementation. Recover from that
// tail before agent_end can buy one more impossible model turn: the newest force
// request followed by an unavailable interactive_choice result is authoritative
// evidence that force mode must stand down for this session. No transcript edit
// is required; unrelated historical failures do not count because only the
// newest force request and its first choice result are considered.
export function hasUnavailableForcedChoiceTail(entries) {
  if (!Array.isArray(entries)) return false;
  let forceIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entryIsForcedChoiceRequest(entries[index])) {
      forceIndex = index;
      break;
    }
  }
  if (forceIndex < 0) return false;
  for (let index = forceIndex + 1; index < entries.length; index += 1) {
    const result = interactiveChoiceToolResult(entries[index]);
    if (result !== null) return CHOICE_UI_UNAVAILABLE_RE.test(result);
  }
  return false;
}

export function createChoiceExtension({ speaker, cacophonyBridge, ahpBridge, preferenceStore, env = process.env, settingsPath, persistedSettings, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return function choiceExtension(pi) {
    const persistedChoice = persistedSettings?.choice ?? readPersistedChoiceSettings(settingsPath);
    const choiceConfig = resolveChoiceSettings(env, persistedChoice);
    let speakerController = speaker || null;
    const ensureSpeaker = (ctx) => {
      if (!speakerController) speakerController = createChoiceSpeaker({ env, persisted: persistedSettings?.tts ?? readPersistedTtsSettings(settingsPath) });
      if (ctx) speakerController.assignSession?.(ctx);
    };
    if (choiceConfig.enabled) ensureSpeaker();
    let enablementGeneration = 0;
    const cacoBridge = cacophonyBridge === false ? null : cacophonyBridge || createCacophonyChoiceBridge({ env, persisted: persistedChoice.cacophony || {}, setTimer, clearTimer });
    let active = null;
    let lastResult = null;
    let nextSessionId = 1;
    let forcedRequestOutstanding = false;
    let warnedUnsatisfiedForce = false;
    let ahpProvider = null;
    const viewPreferences = preferenceStore || createChoicePreferenceStore({ env });
    const initialExpanded = choiceConfig.expanded;
    const initialFullscreen = choiceConfig.fullscreen;
    let preferenceLoad = null;
    let viewSaveStatus = viewPreferences.persistent === false ? "session only" : "local preference";
    const loadViewPreference = (ctx) => preferenceLoad ||= viewPreferences.load().then(value => {
      if (env.PI_CHOICE_EXPANDED == null && typeof value.expanded === "boolean") choiceConfig.expanded = value.expanded;
      if (env.PI_CHOICE_FULLSCREEN == null && typeof value.fullscreen === "boolean") choiceConfig.fullscreen = value.fullscreen;
    }).catch(error => { ctx?.ui?.notify?.(`Choice view preference unavailable: ${error.message}`, "warning"); });
    const setViewPreference = async (action, ctx) => {
      await loadViewPreference(ctx);
      const layoutOnly = ["bottom", "fullscreen", "toggle-fullscreen"].includes(action);
      const expanded = layoutOnly ? choiceConfig.expanded : action === "reset" ? initialExpanded : action === "toggle" ? !choiceConfig.expanded : action === "expanded";
      const fullscreen = action === "reset" ? initialFullscreen : layoutOnly ? action === "toggle-fullscreen" ? !choiceConfig.fullscreen : action === "fullscreen" : choiceConfig.fullscreen;
      choiceConfig.expanded = expanded;
      choiceConfig.fullscreen = fullscreen;
      active?.view?.setExpanded(expanded);
      if (active?.view) { active.view.fullscreen = fullscreen; active.view.invalidate(); }
      active?.requestRender?.();
      try {
        await viewPreferences.save(action === "reset" ? null : expanded, action === "reset" ? null : fullscreen);
        viewSaveStatus = viewPreferences.persistent === false ? "session only" : "saved locally";
      } catch (error) {
        viewSaveStatus = "not saved";
        ctx?.ui?.notify?.(`Choice view changed but was not saved: ${error.message}`, "warning");
      }
      return expanded;
    };

    const emitSession = (payload) => {
      try { pi.events?.emit?.(CHOICE_SESSION_EVENT, payload); } catch {}
    };

    const capabilityPayload = (requestId) => ({
      version: 1,
      questionKinds: ["single_select"],
      allowFreeform: true,
      drafts: false,
      maxQuestions: 1,
      maxOptions: choiceConfig.maxChoices,
      ...(requestId ? { requestId } : {}),
    });

    const announceCapability = (requestId) => {
      if (!choiceConfig.enabled) return;
      try { pi.events?.emit?.(CHOICE_CAPABILITY_EVENT, capabilityPayload(requestId)); } catch {}
    };

    const choiceSessionPayload = (record, status) => ({
      status,
      version: 2,
      sessionId: record.sessionId,
      requestId: record.sessionId,
      revision: record.revision,
      question: record.question,
      questionId: "choice",
      choices: record.state.choices.map((choice, index) => ({
        id: choice.id,
        label: choice.headline || choice.label,
        description: choice.summary || "",
        recommended: index === record.state.index,
      })),
      allowFreeform: true,
      timeoutMs: record.timeoutMs,
      deadline: record.deadline == null ? null : new Date(record.deadline).toISOString(),
      confirmingStop: record.confirmingStop === true,
    });

    const emitChoiceUpdate = (record) => {
      record.revision += 1;
      record.lastInputCommandId = null;
      emitSession(choiceSessionPayload(record, "updated"));
      ahpProvider?.updated(record);
    };

    const endInputSession = (record, result) => {
      if (record.sessionEnded) return;
      record.sessionEnded = true;
      emitSession({
        status: "ended",
        version: 2,
        sessionId: record.sessionId,
        requestId: record.sessionId,
        revision: record.revision,
        result,
      });
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
      try { record.disposeView?.(); } catch {}
      record.disposeView = null;
      if (record.customDone) {
        const done = record.customDone;
        record.customDone = null;
        try { done(result); } catch {}
      }
      // Cancellation/selection must stop an in-flight spoken prompt immediately;
      // Escape should not leave the old question talking over freeform input.
      try { speakerController.interrupt?.(); } catch {}
      try { speakerController.endChoice?.(record.sessionId); } catch {}
      try { record.ctx?.ui?.setWidget?.("agent-utils-choice", undefined); } catch {}
    };

    const isStopChoice = (choice) => /^(?:stop|idle|pause|finish|stop continuous choices)$/i.test(String(choice?.label || "").trim());

    const finish = (record, result) => {
      if (!record || record.finished) return;
      if (record.lastInputCommandId && result?.commandId === undefined) {
        result = { ...result, commandId: record.lastInputCommandId };
      }
      record.finished = true;
      releaseChoiceUi(record, result);
      record.signal?.removeEventListener?.("abort", record.onAbort);
      if (active === record) active = null;
      lastResult = result;
      const unavailableForcedUi = record.forcedPresentation === true
        && result?.status === "error"
        && CHOICE_UI_UNAVAILABLE_RE.test(`${String(result?.code || "")}\n${String(result?.error || "")}`);
      const discardedDurableForce = record.forcedPresentation === true
        && result?.source === "cacophony"
        && /discard/i.test(String(result?.reason || result?.action || ""));
      if (
        choiceConfig.forceAtAgentEnd && (
          (result?.status === "selected" && isStopChoice(result.choice))
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
      ahpProvider?.resolved(record, result);
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
      if (!choiceConfig.enabled || !record || record.finished) return null;
      if (input?.sessionId && input.sessionId !== record.sessionId) return null;
      if (input?.commandId) record.lastInputCommandId = String(input.commandId);
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
        if (record.confirmingStop) {
          if (outcome.choice?.value === true) {
            const original = record.stopSelection;
            finish(record, { status: "selected", index: original.index, choice: original.choice, inputChoiceId: "yes-stop", source });
          } else {
            record.question = record.originalQuestion;
            record.state = new ChoiceStateMachine({ choices: record.originalChoices, initialIndex: record.stopSelection.index, wrap: record.wrap });
            record.confirmingStop = false;
            record.stopSelection = null;
            emitChoiceUpdate(record);
            if (record.requestRender) { try { record.requestRender(); } catch {} }
            else { try { record.ctx?.ui?.setWidget?.("agent-utils-choice", renderChoiceWidget(record.question, record.state.choices, record.state.index), { placement: "belowEditor" }); } catch {} }
            if (choiceConfig.speechEnabled) void speakerController.speak("Stop cancelled. Back to choices.");
          }
        } else if (isStopChoice(outcome.choice)) {
          record.stopSelection = { index: outcome.index, choice: outcome.choice };
          record.confirmingStop = true;
          record.question = "Stop continuous choices?";
          record.state = new ChoiceStateMachine({ choices: [
            { id: "yes-stop", label: "Yes", headline: "Yes — stop", value: true },
            { id: "no-continue", label: "No", headline: "No — keep choosing", value: false },
          ], initialIndex: 1, wrap: record.wrap });
          emitChoiceUpdate(record);
          if (record.requestRender) { try { record.requestRender(); } catch {} }
          else { try { record.ctx?.ui?.setWidget?.("agent-utils-choice", renderChoiceWidget(record.question, record.state.choices, record.state.index, "confirm stop"), { placement: "belowEditor" }); } catch {} }
          try { record.onUpdate?.({ content: [{ type: "text", text: "Confirm stop: Yes or No (selected: No)" }] }); } catch {}
          if (choiceConfig.speechEnabled) void speakerController.speak("Stop continuous choices? Option 1: Yes, stop. Option 2: No, keep choosing. Selected: No.");
        } else if (outcome.choice?.appended && outcome.choice?.terminal) {
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

    const startAhpProvider = () => createAhpChoiceProvider({
      pi,
      env,
      bridge: ahpBridge,
      disabled: ahpBridge === false,
      getActive: () => active,
      complete(command) {
        const record = active;
        if (!choiceConfig.enabled || !record || record.finished || command.requestId !== record.sessionId) return;
        const common = { source: "ahp", commandId: command.commandId, sessionId: record.sessionId };
        if (command.response === "accept" && command.answer?.kind === "selected") {
          handleInput({ ...common, action: INPUT_ACTIONS.CHOOSE_ID, choiceId: command.answer.value });
        } else if (command.response === "accept" && command.answer?.kind === "text") {
          handleInput({ ...common, action: INPUT_ACTIONS.FREEFORM_SUBMIT, text: command.answer.value });
        } else if (command.response === "timeout") {
          finish(record, { status: "timeout", timeoutMs: record.timeoutMs, index: record.state.index, choice: record.state.current(), ...common });
        } else {
          finish(record, { status: "cancelled", reason: command.response, index: record.state.index, choice: record.state.current(), ...common });
        }
      },
    });

    if (choiceConfig.enabled) ahpProvider = startAhpProvider();

    const eventInputHandler = (input) => { handleInput(input); };
    const choiceSyncRequestHandler = (request = {}) => {
      announceCapability(String(request?.requestId || "").trim() || undefined);
      if (active && !active.finished) emitSession(choiceSessionPayload(active, "updated"));
    };
    pi.events?.on?.(INPUT_ACTION_EVENT, eventInputHandler);
    pi.events?.on?.(CHOICE_SYNC_REQUEST_EVENT, choiceSyncRequestHandler);
    queueMicrotask(() => announceCapability());
    pi.registerMessageRenderer?.(FORCE_CHOICE_CUSTOM_TYPE, (message, _options, theme) => ({
      render: (width) => [theme.fg("dim", String(message.content || "").slice(0, width))],
      invalidate() {},
    }));

    const elicit = async (params, ctx, signal, onUpdate) => {
      if (!choiceConfig.enabled) return { status: "cancelled", reason: "disabled" };
      const generation = enablementGeneration;
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
      // The resolved operator setting is policy, not an advisory default. Models
      // commonly emit the schema's 30-second default, which must not silently
      // replace a long-lived or disabled operator timeout.
      const timeoutMs = choiceConfig.timeoutMs;
      if (ctx?.mode === "tui") await loadViewPreference(ctx);
      if (!choiceConfig.enabled || generation !== enablementGeneration) return { status: "cancelled", reason: "disabled" };
      if (signal?.aborted) return { status: "cancelled", reason: "aborted" };
      cancelActive();
      const state = new ChoiceStateMachine({ choices, initialIndex: params?.initialIndex, wrap: params?.wrap ?? choiceConfig.wrap });
      const sessionId = `choice-${nextSessionId++}`;

      const result = await new Promise((resolve) => {
        const record = {
          sessionId,
          view: new ChoiceView({ expanded: choiceConfig.expanded, fullscreen: choiceConfig.fullscreen }),
          disposeView: null,
          revision: 1,
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
          bracketedPaste: false,
          suppressPasteSubmit: false,
          lastInputCommandId: null,
          forcedPresentation,
          originalQuestion: question,
          originalChoices: choices,
          wrap: params?.wrap ?? choiceConfig.wrap,
          confirmingStop: false,
          stopSelection: null,
          awaitingFreeform: false,
          sessionEnded: false,
          finished: false,
        };
        active = record;
        speakerController.beginChoice?.(sessionId);
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
          // Bracketed paste is message/composer input, never modal shortcuts.
          // Consume it and the legacy injector's following Enter so pasted
          // words containing i/j/k or digits cannot mutate the choice.
          if (record.bracketedPaste) {
            if (key.includes("\u001b[201~")) {
              record.bracketedPaste = false;
              record.suppressPasteSubmit = true;
            }
            return true;
          }
          if (key.includes("\u001b[200~")) {
            record.bracketedPaste = !key.includes("\u001b[201~");
            record.suppressPasteSubmit = true;
            return true;
          }
          if (record.suppressPasteSubmit && isChoiceEnterKey(key)) {
            record.suppressPasteSubmit = false;
            return true;
          }
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
          if (record.requestRender) {
            const action = choiceViewKey(key);
            if (action === "toggle" || action === "toggle-fullscreen") { void setViewPreference(action, ctx); return true; }
            if (action && record.view.input(action)) { record.requestRender(); return true; }
            if (record.view.focus === "question" && ["\u001b[A", "\u001b[B", "j", "k"].includes(key)) {
              record.view.input(key === "j" || key === "\u001b[B" ? "down" : "up");
              record.requestRender(); return true;
            }
          }
          if (key === "i" || key === "I") {
            emitInput({ action: INPUT_ACTIONS.FREEFORM_ENTER, mode: "text", source: "keyboard" });
            return true;
          }
          if (key === " ") {
            emitInput({ action: INPUT_ACTIONS.FREEFORM_ENTER, mode: "ptt", source: "keyboard" });
            return true;
          }
          const input = keyboardChoiceAction(key, record.state.choices.length);
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
            if (record.finished || record.awaitingFreeform) {
              done(null);
              return { render: () => [], invalidate() {}, handleInput() {} };
            }
            record.customDone = done;
            record.requestRender = () => tui.requestRender();
            const dimensions = () => ({ columns: tui.terminal?.columns || 80, rows: tui.terminal?.rows || 24 });
            // Save/restore terminal mouse modes, rather than disabling a mode
            // owned by fullscreen Pi or the surrounding terminal on dismissal.
            const mouse = tui.mode !== "fullscreen" && typeof tui.terminal?.write === "function";
            if (mouse) tui.terminal.write("\u001b[?1000s\u001b[?1006s\u001b[?1000h\u001b[?1006h");
            let disposed = false;
            record.disposeView = () => {
              if (disposed) return; disposed = true;
              if (mouse) tui.terminal.write("\u001b[?1006r\u001b[?1000r");
              record.view.invalidate();
            };
            return {
              render(width) {
                const rows = dimensions().rows;
                const height = choicePanelRows(rows, record.view.fullscreen);
                const lines = record.view.render({ question: record.question, choices: record.state.choices, index: record.state.index, timeoutMs, freeformMode: record.freeformMode, freeformText: record.freeformText }, width, height, theme);
                if (record.view.layout) {
                  record.view.layout.terminalRows = rows;
                  record.view.layout.rowOffset = rows - lines.length;
                }
                return lines;
              },
              snapshot: () => ({ expanded: record.view.expanded, fullscreen: record.view.fullscreen, focus: record.view.focus, layout: record.view.layout }),
              invalidate() { record.view.invalidate(); },
              handleInput(data) {
                const size = dimensions();
                const action = record.view.mouse(data, size.columns, size.rows);
                if (action) {
                  if (record.freeformMode) return;
                  if (action.type === "choose") emitInput({ action: INPUT_ACTIONS.CHOOSE_INDEX, index: action.index, source: "mouse" });
                  else if (action.type === "toggle") void setViewPreference("toggle", ctx);
                  else if (action.type === "render") record.requestRender();
                  return;
                }
                dispatchKeyboard(data);
              },
            };
          }, { overlay: true, overlayOptions: { anchor: "bottom-left", col: 0, width: "100%", maxHeight: "100%", margin: 0 } }).catch((error) => {
            if (!record.finished) finish(record, { status: "error", error: error?.message || String(error), index: state.index, choice: state.current() });
          });
        } else if (ctx?.mode === "rpc") {
          if (typeof ctx?.ui?.select !== "function") {
            finish(record, { status: "error", error: "RPC interactive_choice requires the typed ctx.ui.select surface", index: state.index, choice: state.current() });
          } else {
            record.rpcAbort = new AbortController();
            void (async () => {
              while (!record.finished) {
                const labels = record.state.choices.map((choice, index) => `${index + 1}. ${choice.headline}${choice.summary ? ` — ${choice.summary}` : ""}`);
                let selected;
                try { selected = await ctx.ui.select(record.question, labels, { signal: record.rpcAbort.signal }); }
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
        ahpProvider?.requested(record);
        emitSession({
          ...choiceSessionPayload(record, "started"),
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

    const choiceTool = {
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
            id: ToolSchema.Optional(ToolSchema.String({ description: "Stable option ID for external input surfaces; generated when omitted." })),
            label: ToolSchema.String({ description: "Stable choice label returned on selection." }),
            headline: ToolSchema.Optional(ToolSchema.String({ description: "Short spoken/display headline; defaults to label." })),
            summary: ToolSchema.Optional(ToolSchema.String({ description: "Optional short explanation spoken in the initial list." })),
            value: ToolSchema.Optional(ToolSchema.Any({ description: "Optional caller value returned in details." })),
          }), { minItems: 2, maxItems: 9 }),
          timeoutMs: ToolSchema.Optional(ToolSchema.Integer({ minimum: 0, maximum: MAX_CHOICE_TIMEOUT_MS, description: "Advisory selection timeout in milliseconds. The operator's configured choice timeout is authoritative; 0 disables timeout." })),
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
    };
    let toolRegistered = false;
    let runtimeReady = false;
    const syncToolVisibility = () => {
      if (choiceConfig.enabled && !toolRegistered && typeof pi.registerTool === "function") {
        pi.registerTool(choiceTool);
        toolRegistered = true;
      }
      if (!runtimeReady || !toolRegistered || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
      const current = pi.getActiveTools();
      const present = current.includes("interactive_choice");
      if (present !== choiceConfig.enabled) pi.setActiveTools(choiceConfig.enabled ? [...current, "interactive_choice"] : current.filter(name => name !== "interactive_choice"));
    };
    syncToolVisibility();
    const setChoiceEnabled = (enabled, ctx) => {
      runtimeReady = true; // command handlers run after the runtime is bound
      if (enabled === choiceConfig.enabled) { syncToolVisibility(); return; }
      if (enabled) ensureSpeaker(ctx);
      choiceConfig.enabled = enabled;
      enablementGeneration++;
      forcedRequestOutstanding = false;
      warnedUnsatisfiedForce = false;
      if (enabled) ahpProvider ||= startAhpProvider();
      else {
        // Keep the optional bridge registration stable. With no active request
        // its snapshot is empty; only the model's callable tool set changes.
        cancelActive("disabled");
        speakerController?.dispose?.(); speakerController = speaker || null;
      }
      syncToolVisibility();
      announceCapability();
    };

    pi.registerCommand("choice", {
      description: "Ask a spoken multi-input choice. Usage: /choice Question | Choice A | Choice B [| ...]; /choice view expanded|compact|bottom|fullscreen|toggle|reset; /choice on|off|cancel|status|settings key=value",
      handler: async (args, ctx) => {
        const raw = String(args || "").trim();
        if (["on", "off"].includes(raw.toLowerCase())) {
          setChoiceEnabled(raw.toLowerCase() === "on", ctx);
          ctx.ui.notify(`choice:${choiceConfig.enabled ? "on" : "off"} · force-choice:${choiceConfig.forceAtAgentEnd ? "on" : "off"}${!choiceConfig.enabled && choiceConfig.forceAtAgentEnd ? " (suspended)" : ""} · runtime only`, "info");
          return;
        }
        if (raw.toLowerCase() === "cancel") {
          ctx.ui.notify(cancelActive("command") ? "choice cancelled" : "no active choice", "info");
          return;
        }
        if (/^view(?:\s|$)/i.test(raw)) {
          const action = raw.split(/\s+/)[1]?.toLowerCase() || "status";
          if (!["expanded", "compact", "toggle", "bottom", "fullscreen", "reset", "status"].includes(action)) { ctx.ui.notify("Usage: /choice view expanded|compact|bottom|fullscreen|toggle|reset|status", "warning"); return; }
          if (action === "status") await loadViewPreference(ctx);
          else await setViewPreference(action, ctx);
          ctx.ui.notify(`choice view: ${choiceConfig.expanded ? "expanded" : "compact"} · ${choiceConfig.fullscreen ? "fullscreen" : "bottom"} · ${viewSaveStatus}`, "info");
          return;
        }
        if (raw.toLowerCase() === "status") {
          const state = active ? "active" : lastResult ? resultText(lastResult) : "idle";
          ctx.ui.notify(`choice:${choiceConfig.enabled ? "on" : "off"} · ${state} · timeout=${choiceConfig.timeoutMs === 0 ? "off" : `${choiceConfig.timeoutMs}ms`} · wrap=${choiceConfig.wrap} · max=${choiceConfig.maxChoices} · speech=${choiceConfig.speechEnabled} · descriptions-on-navigate=${choiceConfig.descriptionOnNavigate} · prefix=${choiceConfig.prefix ? "set" : "none"} · suffix=${choiceConfig.suffix ? "set" : "none"} · repeat=${choiceConfig.repeat.interval}s/${choiceConfig.repeat.limit ?? "unlimited"} · append=${choiceConfig.append.length} · caco=${cacoBridge?.config?.enabled ? "on" : "off"} · force-at-end=${choiceConfig.forceAtAgentEnd}`, "info");
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
            number(["timeout", "timeout_ms"], "timeoutMs", 0, MAX_CHOICE_TIMEOUT_MS);
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

    pi.on("session_start", (_event, ctx) => {
      runtimeReady = true;
      try { if (choiceConfig.enabled) ensureSpeaker(ctx); } catch {}
      syncToolVisibility();
      announceCapability();
      if (!choiceConfig.enabled || !choiceConfig.forceAtAgentEnd) return;
      let entries = [];
      try { entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || []; }
      catch { entries = []; }
      if (!hasUnavailableForcedChoiceTail(entries)) return;
      choiceConfig.forceAtAgentEnd = false;
      forcedRequestOutstanding = false;
      warnedUnsatisfiedForce = true;
      try {
        ctx?.ui?.notify?.(
          "force-choice disabled for this session: recovered a prior no-controller UI failure without starting another agent turn.",
          "warning",
        );
      } catch {}
    });

    pi.registerCommand("force-choice", {
      description: "Require an interactive choice whenever the agent would otherwise stop. Usage: /force-choice [on|off|status]",
      handler: async (args, ctx) => {
        const action = String(args || "on").trim().toLowerCase() || "on";
        if (action === "status") {
          ctx.ui.notify(`force-choice:${choiceConfig.forceAtAgentEnd ? "on" : "off"}${forcedRequestOutstanding ? " · awaiting choice" : ""}${!choiceConfig.enabled ? " · choices off (suspended)" : ""}`, "info");
          return;
        }
        if (!["on", "off"].includes(action)) { ctx.ui.notify("Usage: /force-choice [on|off|status]", "warning"); return; }
        choiceConfig.forceAtAgentEnd = action === "on";
        if (!choiceConfig.forceAtAgentEnd) {
          forcedRequestOutstanding = false;
          warnedUnsatisfiedForce = false;
        }
        ctx.ui.notify(`force-choice:${choiceConfig.forceAtAgentEnd ? "on" : "off"}${!choiceConfig.enabled ? " · choices off (suspended)" : ""} (runtime; startup setting unchanged)`, "info");
      },
    });

    pi.on("agent_end", (_event, ctx) => {
      if (!choiceConfig.enabled || !choiceConfig.forceAtAgentEnd || active) return;
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

    pi.on("session_shutdown", async () => {
      choiceConfig.enabled = false;
      enablementGeneration++;
      cancelActive("shutdown");
      try { pi.events?.off?.(INPUT_ACTION_EVENT, eventInputHandler); } catch {}
      try { pi.events?.off?.(CHOICE_SYNC_REQUEST_EVENT, choiceSyncRequestHandler); } catch {}
      try { ahpProvider?.dispose?.(); } catch {}
      try { speakerController?.dispose?.(); } catch {}
      await viewPreferences.flush?.();
    });
  };
}

export default createChoiceExtension();
