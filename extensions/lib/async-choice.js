// Non-blocking async choices (async_choice) for Agent Utils.
//
// An agent posts one or many questions and continues working. Each question is
// an independent record with its own opaque ID, published to every configured
// answer surface: the local Pi choices view (keyboard, mouse, Omni, ring, PTT),
// Paratenic AHP (as concurrent input requests from one provider), and
// Cacophony's async operator-decision queue. The first answer from any surface
// wins; the others are settled to match, and the answer is injected back into
// the agent as a steering message.

import { ChoiceView, choicePanelRows, choicePlainText, choiceTextWidth, choiceViewKey, fitChoiceText } from "./choice-layout.js";
import {
  CHOICE_SESSION_EVENT,
  ChoiceStateMachine,
  INPUT_ACTION_EVENT,
  INPUT_ACTIONS,
  formatChoiceIntroduction,
  isChoiceEnterKey,
  isChoiceEscapeKey,
  isChoiceQuitKey,
  keyboardChoiceAction,
  normalizeChoices,
} from "./choice.js";
import { ToolSchema } from "./tool-schema.js";

export const ASYNC_CHOICE_MESSAGE_TYPE = "agent-utils-async-choice";
export const ASYNC_CHOICE_ENTRY_TYPE = "agent-utils-async-choice-state";
export const ASYNC_CHOICE_EVENT = "agent-utils:async-choice";
export const ASYNC_CHOICE_VIEW_SESSION = "async-choices";
export const ASYNC_CHOICE_TOOL_NAMES = Object.freeze(["async_choice", "async_choice_status", "async_choice_cancel"]);
export const MAX_ASYNC_QUESTIONS_PER_CALL = 16;
const WIDGET_KEY = "agent-utils-async-choices";
const SIDEBAR_MIN_WIDTH = 64;

const TRUE_RE = /^(1|true|yes|on)$/i;
const FALSE_RE = /^(0|false|no|off)$/i;
const bool = (value, fallback) => {
  if (value == null || String(value).trim() === "") return fallback;
  if (TRUE_RE.test(String(value).trim())) return true;
  if (FALSE_RE.test(String(value).trim())) return false;
  return fallback;
};

export function resolveAsyncChoiceSettings(env = process.env, persisted = {}) {
  const int = (raw, fallback, min, max) => {
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
  };
  const indicator = String(env.PI_ASYNC_CHOICE_INDICATOR ?? persisted.indicator ?? "widget").trim().toLowerCase();
  return {
    shortcut: String(env.PI_ASYNC_CHOICE_SHORTCUT ?? persisted.shortcut ?? "ctrl+alt+q").trim(),
    // Async questions wait for the operator by default; 0 means no expiry.
    timeoutMs: int(env.PI_ASYNC_CHOICE_TIMEOUT_MS ?? persisted.timeoutMs, 0, 0, 30 * 24 * 60 * 60 * 1000),
    maxPending: int(env.PI_ASYNC_CHOICE_MAX_PENDING ?? persisted.maxPending, 32, 1, 256),
    indicator: ["widget", "status", "both", "none"].includes(indicator) ? indicator : "widget",
    notifyOnPost: bool(env.PI_ASYNC_CHOICE_NOTIFY, bool(persisted.notifyOnPost, true)),
    speakOnPost: bool(env.PI_ASYNC_CHOICE_SPEAK_ON_POST, bool(persisted.speakOnPost, false)),
    deliverDebounceMs: int(persisted.deliverDebounceMs, 250, 0, 10_000),
  };
}

let idSequence = 0;
export function newAsyncChoiceId(now = Date.now()) {
  idSequence = (idSequence + 1) % 1296;
  const random = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
  return `ac-${now.toString(36)}-${idSequence.toString(36).padStart(2, "0")}${random}`;
}

// Normalize `{question, choices}` or `{questions: [...]}` into a question list.
export function asyncChoiceQuestions(params = {}) {
  const shared = { context: params.context, initialIndex: params.initialIndex, key: params.key };
  const list = Array.isArray(params.questions) && params.questions.length
    ? params.questions
    : params.question !== undefined || params.choices !== undefined ? [{ ...shared, question: params.question, choices: params.choices }] : [];
  if (!list.length) throw new Error("async_choice: provide question+choices or a non-empty questions list");
  if (list.length > MAX_ASYNC_QUESTIONS_PER_CALL) throw new Error(`async_choice: at most ${MAX_ASYNC_QUESTIONS_PER_CALL} questions per call`);
  return list.map((entry, position) => {
    const question = String(entry?.question ?? entry?.prompt ?? "").trim();
    if (!question) throw new Error(`async_choice: question ${position + 1} is empty`);
    return {
      question,
      context: String(entry?.context ?? "").trim(),
      key: entry?.key == null ? "" : String(entry.key).trim().slice(0, 128),
      choices: entry?.choices,
      initialIndex: entry?.initialIndex,
    };
  });
}

const REASON_TEXT = Object.freeze({
  discarded: "the user dismissed it without answering",
  declined: "the user declined to answer",
  withdrawn: "withdrawn by the agent",
  disabled: "choices were turned off",
});

// Top-level status the agent reasons about; `answer.status` keeps the detail.
export function asyncChoiceStatus(result) {
  if (!result) return "pending";
  if (["selected", "freeform", "action"].includes(result.status)) return "answered";
  if (result.status === "timeout") return "expired";
  if (result.reason === "withdrawn") return "withdrawn";
  return "dismissed";
}

function resultLine(record) {
  const result = record.result || {};
  const choice = result.choice || {};
  const value = choice.value !== undefined && choice.value !== choice.label ? ` (value ${JSON.stringify(choice.value)})` : "";
  if (result.status === "selected") return `selected ${result.index + 1}: "${choice.label}"${value}`;
  if (result.status === "action") return `chose control "${choice.label}" (${result.action})`;
  if (result.status === "freeform") return `replied in their own words: ${JSON.stringify(result.text)}`;
  if (result.status === "timeout") return `expired unanswered after ${result.timeoutMs}ms`;
  if (result.status === "cancelled") return `no answer — ${REASON_TEXT[result.reason] || result.reason || "cancelled"}${result.source && result.source !== "agent" ? ` (via ${result.source})` : ""}`;
  return result.status || "pending";
}

export function asyncChoiceSummary(record) {
  const result = record.result;
  return {
    id: record.id,
    ...(record.key ? { key: record.key } : {}),
    ...(record.batchId ? { batchId: record.batchId } : {}),
    status: record.status,
    question: record.question,
    postedAt: new Date(record.createdAt).toISOString(),
    ...(record.resolvedAt ? { resolvedAt: new Date(record.resolvedAt).toISOString() } : {}),
    ...(record.decisionId ? { cacophonyDecisionId: record.decisionId } : {}),
    ...(result ? {
      answer: {
        status: result.status,
        ...(Number.isInteger(result.index) && ["selected", "action"].includes(result.status) ? { index: result.index, label: result.choice?.label, value: result.choice?.value } : {}),
        ...(result.status === "freeform" ? { text: result.text } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.source ? { source: result.source } : {}),
      },
      text: resultLine(record),
    } : {}),
  };
}

export function formatAsyncDelivery(records, stillPending = 0) {
  const lines = [`[async choice] ${records.length === 1 ? "An async question was settled" : `${records.length} async questions were settled`}${stillPending ? ` (${stillPending} still pending)` : ""}:`];
  for (const record of records) {
    const question = String(record.question || "").replace(/\s+/g, " ").trim();
    lines.push(`- ${record.id}${record.key ? ` [key=${record.key}]` : ""} "${question.length > 160 ? `${question.slice(0, 159)}…` : question}" → ${resultLine(record)}`);
  }
  return lines.join("\n");
}

// Pure composite layout: optional left sidebar of pending questions plus the
// shared ChoiceView main panel. Narrow terminals collapse the sidebar into one
// strip row above the main panel.
export function renderAsyncChoicesView({ records, focusIndex, view, theme, width, height, hint, sidebarOffset = 0 }) {
  const w = Math.max(0, Math.trunc(Number(width) || 0));
  const h = Math.max(0, Math.trunc(Number(height) || 0));
  const record = records[focusIndex];
  if (!w || !h || !record) return { lines: [], layout: null, sidebarOffset: 0 };
  const paint = (role, text) => { try { return theme?.fg?.(role, text) ?? text; } catch { return text; } };
  const bold = (text) => { try { return theme?.bold?.(text) ?? text; } catch { return text; } };
  const sidebar = w >= SIDEBAR_MIN_WIDTH && records.length > 0;
  const sideWidth = sidebar ? Math.max(20, Math.min(40, Math.floor(w * 0.3))) : 0;
  const mainCol = sidebar ? sideWidth + 1 : 0;
  const mainWidth = Math.max(1, w - mainCol);
  const stripRows = sidebar ? 0 : 1;
  const questionText = record.context ? `${record.question}\n\n${record.context}` : record.question;
  const main = view.render({
    question: questionText,
    choices: record.state.choices,
    index: record.state.index,
    freeformMode: record.freeformMode,
    freeformText: record.freeformText,
    title: `Question ${focusIndex + 1}/${records.length}`,
    hint,
  }, mainWidth, Math.max(1, h - stripRows), theme);
  const lines = [];
  const itemRows = {};
  let offset = sidebarOffset;
  if (sidebar) {
    const total = Math.min(h, Math.max(main.length, Math.min(h, records.length + 1)));
    const listRows = Math.max(1, total - 1);
    if (focusIndex < offset) offset = focusIndex;
    if (focusIndex >= offset + listRows) offset = focusIndex - listRows + 1;
    offset = Math.max(0, Math.min(offset, Math.max(0, records.length - listRows)));
    const side = [paint("accent", bold(fitChoiceText(`Questions · ${records.length}${offset > 0 || records.length > offset + listRows ? ` ${offset + 1}–${Math.min(records.length, offset + listRows)}` : ""}`, sideWidth)))];
    for (let row = 0; row < listRows && offset + row < records.length; row += 1) {
      const index = offset + row;
      const item = records[index];
      const focused = index === focusIndex;
      const text = fitChoiceText(`${focused ? "▶" : " "} ${index + 1}. ${choicePlainText(item.question).replace(/\s+/g, " ")}`, sideWidth);
      side.push(focused ? paint("accent", bold(text)) : paint("text", text));
      itemRows[side.length - 1] = index;
    }
    for (let row = 0; row < total; row += 1) {
      const left = side[row] ?? "";
      const leftPlain = choiceTextWidth(left);
      const pad = " ".repeat(Math.max(0, sideWidth - leftPlain));
      lines.push(`${left}${pad}${paint("muted", "│")}${main[row] ?? ""}`);
    }
  } else {
    const label = `‹ ${focusIndex + 1}/${records.length} › ${choicePlainText(record.question).replace(/\s+/g, " ")}`;
    lines.push(paint("accent", bold(fitChoiceText(label, w))));
    lines.push(...main);
  }
  return {
    lines: lines.slice(0, h),
    sidebarOffset: offset,
    layout: { width: w, height: Math.min(lines.length, h), sidebar, sideWidth, mainCol, stripRows, itemRows },
  };
}

export function createAsyncChoiceController({
  pi,
  env = process.env,
  choiceConfig,
  asyncConfig,
  getSpeaker,
  getAhp,
  decisionBridge,
  isSyncActive = () => false,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
} = {}) {
  const records = new Map(); // id -> record, insertion ordered
  const deliveries = [];
  let deliveryTimer = null;
  let lastCtx = null;
  let view = null;
  let disposed = false;
  let warnedCaco = false;

  const pending = () => [...records.values()].filter((record) => !record.finished);
  const speaker = () => { try { return getSpeaker?.() || null; } catch { return null; } };
  const append = (data) => { try { pi.appendEntry?.(ASYNC_CHOICE_ENTRY_TYPE, data); } catch {} };
  const emit = (name, payload) => { try { pi.events?.emit?.(name, payload); } catch {} };
  const notify = (message, level = "info") => { try { lastCtx?.ui?.notify?.(message, level); } catch {} };
  const remember = (ctx) => { if (ctx?.ui) lastCtx = ctx; };

  const sessionPayload = (record, status) => ({
    status,
    version: 2,
    kind: "async",
    sessionId: ASYNC_CHOICE_VIEW_SESSION,
    requestId: record.sessionId,
    revision: record.revision,
    question: record.question,
    questionId: "choice",
    choices: record.state.choices.map((choice, index) => ({ id: choice.id, label: choice.headline || choice.label, description: choice.summary || "", recommended: index === record.state.index })),
    allowFreeform: true,
    timeoutMs: record.timeoutMs,
    deadline: record.deadline == null ? null : new Date(record.deadline).toISOString(),
    pendingCount: pending().length,
  });

  // ---- indicator ---------------------------------------------------------
  const indicatorText = (count) => `◆ ${count} question${count === 1 ? "" : "s"} waiting for you · ${asyncConfig.shortcut || "/choices"}${asyncConfig.shortcut ? " or /choices" : ""} to answer`;
  const updateIndicator = () => {
    const ui = lastCtx?.ui;
    if (!ui) return;
    const count = pending().length;
    const mode = asyncConfig.indicator;
    try {
      if (["widget", "both"].includes(mode) && count > 0 && !view) {
        ui.setWidget?.(WIDGET_KEY, (_tui, theme) => ({
          render: (width) => [theme?.fg?.("accent", fitChoiceText(indicatorText(count), width)) ?? fitChoiceText(indicatorText(count), width)],
          invalidate() {},
        }));
      } else ui.setWidget?.(WIDGET_KEY, undefined);
    } catch {}
    try {
      if (["status", "both"].includes(mode) && count > 0) ui.setStatus?.(WIDGET_KEY, `◆ ${count} question${count === 1 ? "" : "s"}`);
      else ui.setStatus?.(WIDGET_KEY, undefined);
    } catch {}
  };

  // ---- delivery ----------------------------------------------------------
  const flushDeliveries = () => {
    deliveryTimer = null;
    const batch = deliveries.splice(0).filter((record) => !record.delivered);
    if (!batch.length || disposed) return;
    for (const record of batch) record.delivered = true;
    try {
      pi.sendMessage?.({
        customType: ASYNC_CHOICE_MESSAGE_TYPE,
        content: formatAsyncDelivery(batch, pending().length),
        display: true,
        details: { ids: batch.map((record) => record.id), results: batch.map(asyncChoiceSummary) },
      }, { deliverAs: "steer", triggerTurn: true });
    } catch (error) {
      for (const record of batch) record.delivered = false;
      notify(`async choice answer could not be delivered to the agent: ${error?.message || String(error)}`, "warning");
    }
  };
  const queueDelivery = (record) => {
    if (record.delivered || deliveries.includes(record)) return;
    deliveries.push(record);
    if (deliveryTimer) return;
    if (asyncConfig.deliverDebounceMs <= 0) { flushDeliveries(); return; }
    deliveryTimer = setTimer(flushDeliveries, asyncConfig.deliverDebounceMs);
  };

  // ---- AHP ---------------------------------------------------------------
  // The extension owns one AHP input provider for both blocking and async
  // choices; it lists our pending records and routes completions here.
  const ahp = () => { try { return getAhp?.() || null; } catch { return null; } };
  const completeAhp = (command) => {
    const record = records.get(command.requestId);
    if (!record || record.finished) return false;
    const common = { source: "ahp", commandId: command.commandId };
    if (command.response === "accept" && command.answer?.kind === "selected") applyInput(record, { ...common, action: INPUT_ACTIONS.CHOOSE_ID, choiceId: command.answer.value });
    else if (command.response === "accept" && command.answer?.kind === "text") applyInput(record, { ...common, action: INPUT_ACTIONS.FREEFORM_SUBMIT, text: command.answer.value });
    else if (command.response === "timeout") finish(record, { status: "timeout", timeoutMs: record.timeoutMs, ...common });
    else finish(record, { status: "cancelled", reason: command.response === "decline" ? "declined" : command.response, ...common });
    return true;
  };

  // ---- lifecycle ---------------------------------------------------------
  const armTimeout = (record) => {
    if (record.timer) clearTimer(record.timer);
    record.timer = null;
    if (record.deadline == null || record.finished) return;
    const remaining = record.deadline - now();
    if (remaining <= 0) { finish(record, { status: "timeout", timeoutMs: record.timeoutMs, source: "timer" }); return; }
    record.timer = setTimer(() => finish(record, { status: "timeout", timeoutMs: record.timeoutMs, source: "timer" }), remaining);
    record.timer?.unref?.();
  };

  const mirrorToCacophony = (record) => {
    if (!decisionBridge) return;
    const callbacks = {
      onResolution(external) {
        if (record.finished) return;
        if (external?.status === "freeform") applyInput(record, { action: INPUT_ACTIONS.FREEFORM_SUBMIT, text: external.text, source: "cacophony" });
        else if (external?.status === "selected") applyInput(record, { action: INPUT_ACTIONS.CHOOSE_INDEX, index: external.index, source: "cacophony" });
        else finish(record, { status: "cancelled", reason: external?.reason || "cacophony", source: "cacophony" });
      },
      onWarning(message) {
        if (warnedCaco) return;
        warnedCaco = true;
        notify(`Cacophony decision mirror unavailable; async choices remain answerable in Pi: ${message}`, "warning");
      },
    };
    record.cacophony = record.decisionId
      ? decisionBridge.attach?.({ decisionId: record.decisionId, choices: record.state.choices, ...callbacks }) || null
      : decisionBridge.start?.({
        asyncId: record.id,
        question: record.question,
        context: record.context,
        choices: record.state.choices,
        recommendIndex: record.state.index,
        onDecisionId(decisionId) {
          record.decisionId = decisionId;
          append({ type: "decision", id: record.id, decisionId });
        },
        ...callbacks,
      }) || null;
  };

  const createRecord = (spec, batchId) => {
    const appended = (choiceConfig.append || []).map((entry) => ({ ...entry }));
    const provided = normalizeChoices(spec.choices);
    const choices = normalizeChoices([...provided, ...appended]);
    if (choices.length > choiceConfig.maxChoices) throw new Error(`async_choice: at most ${choiceConfig.maxChoices} choices per question are configured${appended.length ? ` (including ${appended.length} appended control row${appended.length === 1 ? "" : "s"})` : ""}`);
    const id = spec.id || newAsyncChoiceId(now());
    const createdAt = spec.createdAt ?? now();
    const timeoutMs = spec.timeoutMs ?? asyncConfig.timeoutMs;
    return {
      id,
      sessionId: id,
      batchId: spec.batchId ?? batchId ?? null,
      key: spec.key || "",
      question: spec.question,
      context: spec.context || "",
      ahpMessage: spec.context ? `${spec.question}\n\n${spec.context}` : spec.question,
      choices,
      state: new ChoiceStateMachine({ choices, initialIndex: spec.initialIndex, wrap: choiceConfig.wrap }),
      initialIndex: spec.initialIndex ?? 0,
      revision: 1,
      createdAt,
      timeoutMs,
      deadline: spec.deadline !== undefined ? spec.deadline : timeoutMs > 0 ? createdAt + timeoutMs : null,
      status: "pending",
      result: null,
      resolvedAt: null,
      decisionId: spec.decisionId || null,
      cacophony: null,
      timer: null,
      freeformMode: null,
      freeformText: "",
      lastInputCommandId: null,
      delivered: false,
      finished: false,
    };
  };

  const activate = (record) => {
    records.set(record.id, record);
    armTimeout(record);
    if (record.finished) return;
    ahp()?.requested(record);
    mirrorToCacophony(record);
  };

  function finish(record, result, { notifyAgent = true } = {}) {
    if (!record || record.finished) return false;
    if (record.lastInputCommandId && result?.commandId === undefined) result = { ...result, commandId: record.lastInputCommandId };
    if (Number.isInteger(result?.index) && !result.choice) result = { ...result, choice: record.state.choices[result.index] };
    record.finished = true;
    record.status = asyncChoiceStatus(result);
    record.result = result;
    record.resolvedAt = now();
    record.freeformMode = null;
    if (record.timer) clearTimer(record.timer);
    record.timer = null;
    ahp()?.resolved(record, result);
    void record.cacophony?.settleLocal?.(result);
    append({ type: "resolved", id: record.id, result: serializableResult(result), at: record.resolvedAt, notify: notifyAgent });
    emit(ASYNC_CHOICE_EVENT, { status: "resolved", id: record.id, result: asyncChoiceSummary(record), pendingCount: pending().length });
    if (notifyAgent) queueDelivery(record);
    else record.delivered = true;
    afterResolution(record);
    updateIndicator();
    return true;
  }

  const serializableResult = (result) => {
    try { return JSON.parse(JSON.stringify(result)); } catch { return { status: result?.status, reason: result?.reason }; }
  };

  // ---- view --------------------------------------------------------------
  const viewRecords = () => pending();
  const focused = () => (view ? records.get(view.focusId) : null) || null;

  const speakIntro = (record) => {
    const voice = speaker();
    if (!voice || !choiceConfig.speechEnabled || !record) return;
    try { voice.interrupt?.(); } catch {}
    void voice.speak(formatChoiceIntroduction(record.question, record.state.choices, record.state.index, { prefix: choiceConfig.prefix, suffix: choiceConfig.suffix })).catch(() => {});
  };

  const render = () => { try { view?.requestRender?.(); } catch {} };

  const setFocus = (record, { speak = true } = {}) => {
    if (!view || !record || record.finished) return;
    const changed = view.focusId !== record.id;
    view.focusId = record.id;
    view.confirmDismiss = null;
    if (changed) {
      view.choiceView = new ChoiceView({ expanded: choiceConfig.expanded, fullscreen: view.choiceView?.fullscreen ?? choiceConfig.fullscreen });
      record.revision += 1;
      emit(CHOICE_SESSION_EVENT, sessionPayload(record, "updated"));
      if (speak) speakIntro(record);
    }
    render();
  };

  const moveFocus = (delta) => {
    const list = viewRecords();
    if (!view || !list.length) return;
    const index = Math.max(0, list.findIndex((record) => record.id === view.focusId));
    setFocus(list[(index + delta + list.length) % list.length]);
  };

  function afterResolution(record) {
    if (!view) return;
    const list = viewRecords();
    if (!list.length) {
      closeView("all-answered");
      notify("All async questions answered.", "info");
      return;
    }
    if (view.focusId !== record.id) { render(); return; }
    // Advance to the next pending question in posting order.
    const ordered = [...records.values()];
    const position = ordered.indexOf(record);
    const next = ordered.slice(position + 1).find((item) => !item.finished) || list[0];
    setFocus(next);
  }

  function closeView(reason = "closed") {
    const current = view;
    if (!current) return false;
    view = null;
    const record = records.get(current.focusId);
    if (record?.freeformMode) { record.freeformMode = null; record.freeformText = ""; }
    try { current.disposeView?.(); } catch {}
    if (current.done) { const done = current.done; current.done = null; try { done(reason); } catch {} }
    try { current.rpcAbort?.abort?.(); } catch {}
    emit(CHOICE_SESSION_EVENT, { status: "ended", version: 2, kind: "async", sessionId: ASYNC_CHOICE_VIEW_SESSION, result: { status: "closed", reason } });
    const voice = speaker();
    try { voice?.interrupt?.(); } catch {}
    try { voice?.endChoice?.(ASYNC_CHOICE_VIEW_SESSION); } catch {}
    updateIndicator();
    return true;
  }

  const enterFreeform = (record, mode = "text") => {
    if (!record || record.finished) return;
    try { speaker()?.interrupt?.(); } catch {}
    record.freeformMode = mode === "ptt" ? "ptt" : "text";
    record.freeformText = "";
    emit(CHOICE_SESSION_EVENT, { status: "freeform", phase: "start", mode: record.freeformMode, sessionId: ASYNC_CHOICE_VIEW_SESSION });
    render();
  };
  const leaveFreeform = (record, reason = "cancelled") => {
    if (!record?.freeformMode) return;
    const mode = record.freeformMode;
    record.freeformMode = null;
    record.freeformText = "";
    emit(CHOICE_SESSION_EVENT, { status: "freeform", phase: "cancel", mode, reason, sessionId: ASYNC_CHOICE_VIEW_SESSION });
    render();
  };

  // One semantic path for every producer: keyboard, mouse, Omni, ring, PTT,
  // AHP and Cacophony all end up here for a specific record.
  function applyInput(record, input = {}) {
    if (!record || record.finished) return null;
    if (input.commandId) record.lastInputCommandId = String(input.commandId);
    const action = String(input.action ?? "").trim().toLowerCase();
    const source = input.source || "event";
    if (action === INPUT_ACTIONS.FREEFORM_ENTER) { enterFreeform(record, input.mode); return { type: "freeform-enter" }; }
    if (action === INPUT_ACTIONS.FREEFORM_UPDATE) {
      if (record.freeformMode) { record.freeformText = String(input.text ?? ""); render(); }
      return { type: "freeform-update" };
    }
    if (action === INPUT_ACTIONS.FREEFORM_SUBMIT) {
      const text = String(input.text ?? "").trim();
      if (!text) { leaveFreeform(record, "empty"); return { type: "ignored", reason: "empty-freeform" }; }
      finish(record, { status: "freeform", text, source });
      return { type: "freeform", text };
    }
    if (action === INPUT_ACTIONS.FREEFORM_CANCEL) { leaveFreeform(record, input.reason || "cancelled"); return { type: "freeform-cancel" }; }
    if (action === INPUT_ACTIONS.FREEFORM_PTT_COMMIT) return { type: "freeform-ptt-commit" };
    if (action === INPUT_ACTIONS.CANCEL) {
      // Cancel from a local device closes the view; the question stays pending.
      if (view && records.get(view.focusId) === record) closeView(source);
      return { type: "closed" };
    }
    const outcome = record.state.apply(input);
    if (outcome.type === "navigate") {
      render();
      const voice = speaker();
      if (view && outcome.changed && voice && choiceConfig.speechEnabled && outcome.choice.tts !== false) {
        const speech = choiceConfig.descriptionOnNavigate && outcome.choice.summary ? `${outcome.choice.headline}. ${outcome.choice.summary}` : outcome.choice.headline;
        void voice.speak(speech).catch(() => {});
      }
    } else if (outcome.type === "selected") {
      const choice = outcome.choice;
      if (choice?.appended && choice.cacophonyAction === "freeformReply") {
        record.state.done = false;
        enterFreeform(record, "text");
      } else if (choice?.appended && (choice.terminal || choice.cacophonyAction === "discard")) {
        finish(record, { status: "cancelled", reason: "discarded", action: choice.cacophonyAction, index: outcome.index, choice, source });
      } else if (choice?.appended) {
        finish(record, { status: "action", action: choice.cacophonyAction, index: outcome.index, choice, source });
      } else {
        finish(record, { status: "selected", index: outcome.index, choice, source });
      }
    }
    return outcome;
  }

  const viewInputHandler = (input) => {
    if (!view || input?.sessionId !== ASYNC_CHOICE_VIEW_SESSION) return;
    const record = focused();
    if (record) applyInput(record, input);
  };

  const emitViewInput = (input) => {
    const payload = { ...input, sessionId: ASYNC_CHOICE_VIEW_SESSION };
    try { pi.events?.emit?.(INPUT_ACTION_EVENT, payload); }
    catch { viewInputHandler(payload); }
  };

  const dismissFocused = (source = "keyboard") => {
    const record = focused();
    if (!record) return;
    if (view.confirmDismiss !== record.id) {
      view.confirmDismiss = record.id;
      notify("Press x again to dismiss this question without answering (the agent is told it was dismissed).", "info");
      render();
      return;
    }
    finish(record, { status: "cancelled", reason: "discarded", source });
  };

  const dispatchKey = (data) => {
    const record = focused();
    if (!view || !record) return true;
    const key = String(data ?? "");
    if (view.bracketedPaste) {
      if (key.includes("\u001b[201~")) { view.bracketedPaste = false; view.suppressPasteSubmit = true; }
      return true;
    }
    if (key.includes("\u001b[200~")) { view.bracketedPaste = !key.includes("\u001b[201~"); view.suppressPasteSubmit = true; return true; }
    if (view.suppressPasteSubmit && isChoiceEnterKey(key)) { view.suppressPasteSubmit = false; return true; }
    if (record.freeformMode === "text") {
      if (isChoiceEscapeKey(key)) emitViewInput({ action: INPUT_ACTIONS.FREEFORM_CANCEL, source: "keyboard", reason: "escape" });
      else if (isChoiceEnterKey(key)) emitViewInput({ action: INPUT_ACTIONS.FREEFORM_SUBMIT, text: record.freeformText, source: "keyboard" });
      else if (key === "\u007f" || key === "\b") { record.freeformText = [...record.freeformText].slice(0, -1).join(""); render(); }
      else if (key === "\u0003") emitViewInput({ action: INPUT_ACTIONS.FREEFORM_CANCEL, source: "keyboard", reason: "ctrl-c" });
      else if (key && !key.startsWith("\u001b")) { record.freeformText += key.replace(/[\r\n\u0000-\u001f\u007f]+/g, " "); render(); }
      return true;
    }
    if (record.freeformMode === "ptt") {
      if (isChoiceEscapeKey(key) || key === "\u0003") emitViewInput({ action: INPUT_ACTIONS.FREEFORM_CANCEL, source: "keyboard", reason: key === "\u0003" ? "ctrl-c" : "escape" });
      else if (isChoiceEnterKey(key) || key === " ") emitViewInput({ action: INPUT_ACTIONS.FREEFORM_PTT_COMMIT, source: "keyboard" });
      return true;
    }
    if (isChoiceEscapeKey(key) || isChoiceQuitKey(key) || key === "\u0003") { closeView("keyboard"); return true; }
    if (["\u001b[D", "\u001bOD", "h", "H"].includes(key)) { moveFocus(-1); return true; }
    if (["\u001b[C", "\u001bOC", "l", "L"].includes(key)) { moveFocus(1); return true; }
    if (["x", "X", "\u001b[3~"].includes(key)) { dismissFocused("keyboard"); return true; }
    view.confirmDismiss = null;
    const viewAction = choiceViewKey(key);
    if (viewAction === "toggle") { view.choiceView.setExpanded(!view.choiceView.expanded); render(); return true; }
    if (viewAction === "toggle-fullscreen") { view.choiceView.fullscreen = !view.choiceView.fullscreen; view.choiceView.invalidate(); render(); return true; }
    if (viewAction && view.choiceView.input(viewAction)) { render(); return true; }
    if (view.choiceView.focus === "question" && ["\u001b[A", "\u001b[B", "j", "k"].includes(key)) {
      view.choiceView.input(key === "j" || key === "\u001b[B" ? "down" : "up");
      render();
      return true;
    }
    if (key === "i" || key === "I") { emitViewInput({ action: INPUT_ACTIONS.FREEFORM_ENTER, mode: "text", source: "keyboard" }); return true; }
    if (key === " ") { emitViewInput({ action: INPUT_ACTIONS.FREEFORM_ENTER, mode: "ptt", source: "keyboard" }); return true; }
    const input = keyboardChoiceAction(key, record.state.choices.length);
    if (input) emitViewInput(input);
    return true;
  };

  const hint = (width) => width >= 96
    ? "↑↓ options · Enter/1–9 answer · ←→ question · i reply · Space PTT · x dismiss · Esc close"
    : width >= 56 ? "↑↓ · Enter answer · ←→ question · i reply · x dismiss · Esc" : "↑↓ · Enter · ←→ · Esc";

  const handleMouse = (data, columns, rows) => {
    const record = focused();
    const layout = view?.layout;
    if (!record || !layout) return false;
    const event = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(String(data ?? ""));
    if (!event) return false;
    const button = Number(event[1]);
    const x = Number(event[2]) - 1;
    const y = Number(event[3]) - 1 - (rows - layout.height);
    if (y < 0 || y >= layout.height || x < 0 || x >= layout.width) return true;
    if (record.freeformMode) return true;
    const press = event[4] === "M" && !(button & 32) && !(button & 64) && (button & 3) === 0;
    if (layout.sidebar && x < layout.mainCol) {
      if (press && layout.itemRows[y] !== undefined) setFocus(viewRecords()[layout.itemRows[y]]);
      return true;
    }
    if (!layout.sidebar && y < layout.stripRows) {
      if (press) moveFocus(x < Math.floor(layout.width / 2) ? -1 : 1);
      return true;
    }
    const action = view.choiceView.mouse(data, columns, rows);
    if (action?.type === "choose") emitViewInput({ action: INPUT_ACTIONS.CHOOSE_INDEX, index: action.index, source: "mouse" });
    else if (action?.type === "toggle") { view.choiceView.setExpanded(!view.choiceView.expanded); render(); }
    else if (action?.type === "render") render();
    return true;
  };

  const openTuiView = (ctx) => {
    view.mode = "tui";
    void ctx.ui.custom((tui, theme, _keybindings, done) => {
      if (!view) { done(null); return { render: () => [], invalidate() {}, handleInput() {} }; }
      const current = view;
      current.done = done;
      current.requestRender = () => tui.requestRender();
      const mouse = tui.mode !== "fullscreen" && typeof tui.terminal?.write === "function";
      if (mouse) tui.terminal.write("\u001b[?1000s\u001b[?1006s\u001b[?1000h\u001b[?1006h");
      let released = false;
      current.disposeView = () => {
        if (released) return;
        released = true;
        if (mouse) tui.terminal.write("\u001b[?1006r\u001b[?1000r");
      };
      const size = () => ({ columns: tui.terminal?.columns || 80, rows: tui.terminal?.rows || 24 });
      return {
        render(width) {
          if (view !== current) return [];
          const list = viewRecords();
          const focusIndex = Math.max(0, list.findIndex((record) => record.id === current.focusId));
          if (!list.length) return [];
          const rows = size().rows;
          const height = choicePanelRows(rows, current.choiceView.fullscreen);
          const out = renderAsyncChoicesView({ records: list, focusIndex, view: current.choiceView, theme, width, height, hint, sidebarOffset: current.sidebarOffset });
          current.sidebarOffset = out.sidebarOffset;
          current.layout = out.layout;
          if (current.choiceView.layout && out.layout) {
            current.choiceView.layout.terminalRows = rows;
            current.choiceView.layout.width = size().columns;
            current.choiceView.layout.rowOffset = rows - out.layout.height + out.layout.stripRows;
            current.choiceView.layout.colOffset = out.layout.mainCol;
          }
          return out.lines;
        },
        invalidate() { current.choiceView.invalidate(); },
        snapshot: () => ({ kind: "async", focusId: current.focusId, pending: viewRecords().map((record) => record.id), expanded: current.choiceView.expanded, fullscreen: current.choiceView.fullscreen, layout: current.choiceView.layout, composite: current.layout }),
        handleInput(data) {
          if (view !== current) return;
          const { columns, rows } = size();
          if (/^\u001b\[</.test(String(data ?? ""))) { handleMouse(data, columns, rows); return; }
          dispatchKey(data);
        },
      };
    }, { overlay: true, overlayOptions: { anchor: "bottom-left", col: 0, width: "100%", maxHeight: "100%", margin: 0 } }).catch((error) => {
      notify(`async choices view failed: ${error?.message || String(error)}`, "warning");
      closeView("error");
    });
  };

  // Typed RPC fallback: one select per pending question, plus reply/skip/dismiss.
  const openRpcView = (ctx) => {
    view.mode = "rpc";
    view.rpcAbort = new AbortController();
    const current = view;
    void (async () => {
      const REPLY = "↩ Reply in my own words…";
      const SKIP = "⏭ Skip for now";
      const DISMISS = "✕ Dismiss without answering";
      const skipped = new Set();
      while (view === current) {
        const record = pending().find((item) => !skipped.has(item.id));
        if (!record) break;
        setFocus(record, { speak: false });
        const labels = record.state.choices.map((choice, index) => `${index + 1}. ${choice.headline}${choice.summary ? ` — ${choice.summary}` : ""}`);
        let selected;
        try { selected = await ctx.ui.select(record.context ? `${record.question}\n\n${record.context}` : record.question, [...labels, REPLY, SKIP, DISMISS], { signal: current.rpcAbort.signal }); }
        catch { break; }
        if (view !== current) return;
        if (selected === undefined) break;
        if (selected === SKIP) { skipped.add(record.id); continue; }
        if (selected === DISMISS) { finish(record, { status: "cancelled", reason: "discarded", source: "rpc" }); continue; }
        if (selected === REPLY) {
          if (typeof ctx.ui.input !== "function") { skipped.add(record.id); continue; }
          let text;
          try { text = await ctx.ui.input(`${record.question} — reply`, "", { signal: current.rpcAbort.signal }); } catch { break; }
          if (view !== current) return;
          if (text !== undefined && String(text).trim()) applyInput(record, { action: INPUT_ACTIONS.FREEFORM_SUBMIT, text, source: "rpc" });
          continue;
        }
        const index = labels.indexOf(selected);
        if (index >= 0) applyInput(record, { action: INPUT_ACTIONS.CHOOSE_INDEX, index, source: "rpc" });
      }
      if (view === current) closeView("rpc-done");
    })();
  };

  const openView = (ctx, { focusId } = {}) => {
    remember(ctx);
    const list = pending();
    if (!list.length) { notify("No async questions are waiting.", "info"); return false; }
    if (isSyncActive()) { notify("Finish the active interactive choice first.", "warning"); return false; }
    if (view) { if (focusId && records.get(focusId)) setFocus(records.get(focusId)); return true; }
    const record = (focusId && records.get(focusId) && !records.get(focusId).finished) ? records.get(focusId) : list[0];
    view = { focusId: record.id, choiceView: new ChoiceView({ expanded: choiceConfig.expanded, fullscreen: choiceConfig.fullscreen }), sidebarOffset: 0, confirmDismiss: null, done: null, requestRender: null, disposeView: null, layout: null };
    updateIndicator();
    try { speaker()?.beginChoice?.(ASYNC_CHOICE_VIEW_SESSION); } catch {}
    emit(CHOICE_SESSION_EVENT, { ...sessionPayload(record, "started"), ring: null, prefix: choiceConfig.prefix, suffix: choiceConfig.suffix, repeat: { interval: 0, limit: 0 } });
    if (ctx?.mode === "tui" && typeof ctx.ui?.custom === "function") openTuiView(ctx);
    else if (ctx?.mode === "rpc" && typeof ctx.ui?.select === "function") openRpcView(ctx);
    else {
      const lines = list.map((item, index) => `${index + 1}. ${item.id} — ${item.question}`);
      closeView("no-ui");
      notify(`Async questions waiting:\n${lines.join("\n")}\nAnswer with /choices answer <id> <option-number|text>.`, "info");
      return false;
    }
    speakIntro(record);
    return true;
  };

  // ---- tools -------------------------------------------------------------
  const post = (params, ctx) => {
    remember(ctx);
    if (!choiceConfig.enabled) throw new Error("async_choice: choices are disabled (/choice on)");
    const specs = asyncChoiceQuestions(params);
    if (pending().length + specs.length > asyncConfig.maxPending) throw new Error(`async_choice: at most ${asyncConfig.maxPending} questions may wait at once (${pending().length} pending)`);
    const batchId = specs.length > 1 ? `batch-${newAsyncChoiceId(now()).slice(3)}` : null;
    const created = specs.map((spec) => createRecord(spec, batchId)); // validate all before publishing any
    for (const record of created) {
      append({ type: "posted", id: record.id, batchId: record.batchId, key: record.key, question: record.question, context: record.context, choices: record.choices.filter((choice) => !choice.appended), initialIndex: record.initialIndex, createdAt: record.createdAt, timeoutMs: record.timeoutMs, deadline: record.deadline });
      activate(record);
      emit(ASYNC_CHOICE_EVENT, { status: "posted", id: record.id, question: record.question, pendingCount: pending().length });
    }
    updateIndicator();
    render();
    const count = pending().length;
    if (asyncConfig.notifyOnPost) notify(`${created.length === 1 ? "Agent asked a question" : `Agent asked ${created.length} questions`} (${count} waiting) · ${asyncConfig.shortcut || "/choices"} to answer`, "info");
    if (asyncConfig.speakOnPost && choiceConfig.speechEnabled && !view) void speaker()?.speak?.(`${created.length === 1 ? "A new question is" : `${created.length} new questions are`} waiting.`).catch?.(() => {});
    return created;
  };

  const lookup = (ids) => {
    const wanted = Array.isArray(ids) ? ids.map(String) : ids ? [String(ids)] : null;
    if (!wanted) return [...records.values()];
    // Keys may be reused after a withdrawal: prefer the newest pending match.
    const byKey = (key) => {
      const matches = [...records.values()].filter((record) => record.key && record.key === key).reverse();
      return matches.find((record) => !record.finished) || matches[0];
    };
    return wanted.map((id) => records.get(id) || byKey(id) || { id, missing: true });
  };

  const tools = [
    {
      name: "async_choice",
      label: "Async Choice",
      description: "Post one or more non-blocking multiple-choice questions to the user and keep working. Returns question IDs immediately. Each answer is injected back as a steering message when the user answers in Pi (choices view), Paratenic/AHP, or Cacophony decisions; use async_choice_status to poll.",
      promptSnippet: "Use async_choice to ask the user non-urgent questions without blocking; continue working and act on answers when they arrive.",
      promptGuidelines: [
        "Prefer async_choice over interactive_choice when you can make progress without the answer.",
        "Batch related questions in one call with `questions`; give each a short `key` so answers are easy to correlate.",
        "Do not re-ask a pending question; poll with async_choice_status or wait for the injected answer. Withdraw obsolete ones with async_choice_cancel.",
        "Treat dismissal or expiry as no answer; never infer one.",
      ],
      parameters: ToolSchema.Object({
        question: ToolSchema.Optional(ToolSchema.String({ description: "Single question to ask (use with choices)." })),
        choices: ToolSchema.Optional(ToolSchema.Array(ToolSchema.Object({
          id: ToolSchema.Optional(ToolSchema.String({ description: "Stable option ID; generated when omitted." })),
          label: ToolSchema.String({ description: "Choice label returned on selection." }),
          headline: ToolSchema.Optional(ToolSchema.String({ description: "Short spoken/display headline; defaults to label." })),
          summary: ToolSchema.Optional(ToolSchema.String({ description: "Optional short explanation." })),
          value: ToolSchema.Optional(ToolSchema.Any({ description: "Optional caller value returned with the answer." })),
        }), { minItems: 2, maxItems: 9 })),
        context: ToolSchema.Optional(ToolSchema.String({ description: "Optional longer background shown under the question." })),
        key: ToolSchema.Optional(ToolSchema.String({ description: "Optional caller correlation key echoed with the answer; also accepted by status/cancel." })),
        initialIndex: ToolSchema.Optional(ToolSchema.Integer({ minimum: 0, maximum: 8, description: "Recommended/initially highlighted zero-based option." })),
        questions: ToolSchema.Optional(ToolSchema.Array(ToolSchema.Object({
          question: ToolSchema.String({ description: "Question text." }),
          choices: ToolSchema.Array(ToolSchema.Object({
            id: ToolSchema.Optional(ToolSchema.String()),
            label: ToolSchema.String(),
            headline: ToolSchema.Optional(ToolSchema.String()),
            summary: ToolSchema.Optional(ToolSchema.String()),
            value: ToolSchema.Optional(ToolSchema.Any()),
          }), { minItems: 2, maxItems: 9 }),
          context: ToolSchema.Optional(ToolSchema.String()),
          key: ToolSchema.Optional(ToolSchema.String()),
          initialIndex: ToolSchema.Optional(ToolSchema.Integer({ minimum: 0, maximum: 8 })),
        }), { minItems: 1, maxItems: MAX_ASYNC_QUESTIONS_PER_CALL, description: "Several independent questions posted at once, answered in any order." })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const created = post(params, ctx);
          const count = pending().length;
          const lines = created.map((record) => `- ${record.id}${record.key ? ` [key=${record.key}]` : ""}: ${record.question}`);
          return {
            content: [{ type: "text", text: `Posted ${created.length} async question${created.length === 1 ? "" : "s"} (${count} pending). Continue working; each answer arrives as a steering message.\n${lines.join("\n")}` }],
            details: { status: "posted", ids: created.map((record) => record.id), questions: created.map(asyncChoiceSummary), pendingCount: count },
          };
        } catch (error) {
          return { content: [{ type: "text", text: `async_choice failed: ${error?.message || String(error)}` }], details: { status: "error", error: error?.message || String(error) } };
        }
      },
    },
    {
      name: "async_choice_status",
      label: "Async Choice Status",
      description: "Report the status and any answers of async_choice questions by ID or key, or of all questions in this session. Non-blocking.",
      promptSnippet: "Use async_choice_status to check whether async_choice questions have been answered.",
      parameters: ToolSchema.Object({
        ids: ToolSchema.Optional(ToolSchema.Array(ToolSchema.String(), { description: "Question IDs or keys; omit for all." })),
        pendingOnly: ToolSchema.Optional(ToolSchema.Boolean({ description: "Only list questions still waiting." })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        remember(ctx);
        const found = lookup(params?.ids).filter((record) => !(params?.pendingOnly && (record.missing || record.finished)));
        const summaries = found.map((record) => record.missing ? { id: record.id, status: "unknown" } : asyncChoiceSummary(record));
        const text = summaries.length
          ? summaries.map((item) => `- ${item.id}${item.key ? ` [key=${item.key}]` : ""}: ${item.status}${item.text ? ` — ${item.text}` : item.question ? ` — "${item.question}"` : ""}`).join("\n")
          : "No async questions.";
        return { content: [{ type: "text", text }], details: { questions: summaries, pendingCount: pending().length } };
      },
    },
    {
      name: "async_choice_cancel",
      label: "Async Choice Cancel",
      description: "Withdraw pending async_choice questions that are no longer needed (by ID or key, or all). Withdrawn questions are removed from Pi, AHP and Cacophony; no answer is delivered.",
      promptSnippet: "Use async_choice_cancel to withdraw async_choice questions that became obsolete.",
      parameters: ToolSchema.Object({
        ids: ToolSchema.Optional(ToolSchema.Array(ToolSchema.String(), { description: "Question IDs or keys to withdraw." })),
        all: ToolSchema.Optional(ToolSchema.Boolean({ description: "Withdraw every pending question." })),
        reason: ToolSchema.Optional(ToolSchema.String({ description: "Optional short reason recorded with the withdrawal." })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        remember(ctx);
        if (!params?.all && !(Array.isArray(params?.ids) && params.ids.length)) {
          return { content: [{ type: "text", text: "async_choice_cancel: pass ids or all=true" }], details: { status: "error" } };
        }
        const targets = params?.all ? pending() : lookup(params.ids).filter((record) => !record.missing);
        const withdrawn = [];
        for (const record of targets) {
          if (finish(record, { status: "cancelled", reason: "withdrawn", detail: params?.reason ? String(params.reason).slice(0, 500) : undefined, source: "agent" }, { notifyAgent: false })) withdrawn.push(record.id);
        }
        return {
          content: [{ type: "text", text: withdrawn.length ? `Withdrew ${withdrawn.length} question${withdrawn.length === 1 ? "" : "s"}: ${withdrawn.join(", ")} (${pending().length} still pending)` : "No matching pending questions." }],
          details: { withdrawn, pendingCount: pending().length },
        };
      },
    },
  ];

  // ---- restore & teardown ------------------------------------------------
  const restore = (ctx) => {
    remember(ctx);
    let entries = [];
    try { entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || []; } catch { entries = []; }
    const posted = new Map();
    const resolved = new Map();
    const decisions = new Map();
    const delivered = new Set();
    for (const entry of entries) {
      if (entry?.type === "custom" && entry.customType === ASYNC_CHOICE_ENTRY_TYPE) {
        const data = entry.data || {};
        if (data.type === "posted" && data.id) posted.set(data.id, data);
        else if (data.type === "resolved" && data.id) resolved.set(data.id, data);
        else if (data.type === "decision" && data.id) decisions.set(data.id, data.decisionId);
      }
      const message = entry?.type === "custom_message" ? entry : entry?.type === "message" && entry.message?.role === "custom" ? entry.message : null;
      if (message?.customType === ASYNC_CHOICE_MESSAGE_TYPE) for (const id of message.details?.ids || []) delivered.add(id);
    }
    let restoredPending = 0;
    for (const data of posted.values()) {
      if (records.has(data.id)) continue;
      let record;
      try { record = createRecord({ ...data, decisionId: decisions.get(data.id) }, data.batchId); } catch { continue; }
      const outcome = resolved.get(data.id);
      if (outcome) {
        record.finished = true;
        record.result = outcome.result || { status: "cancelled" };
        record.status = asyncChoiceStatus(record.result);
        record.resolvedAt = outcome.at || null;
        record.delivered = outcome.notify === false || delivered.has(data.id);
        records.set(record.id, record);
        // The answer was recorded but the agent never saw it: deliver now.
        if (!record.delivered) queueDelivery(record);
        continue;
      }
      activate(record);
      if (!record.finished) restoredPending += 1;
    }
    updateIndicator();
    if (restoredPending) notify(`${restoredPending} async question${restoredPending === 1 ? " is" : "s are"} still waiting · ${asyncConfig.shortcut || "/choices"} to answer`, "info");
  };

  const cancelAll = (reason, { notifyAgent = true } = {}) => {
    for (const record of pending()) finish(record, { status: "cancelled", reason, source: "pi" }, { notifyAgent });
  };

  // Command-line answer path for UI-less modes: a 1-based option number or text.
  const answer = (idOrKey, reply, source = "command") => {
    const record = lookup([idOrKey])[0];
    if (!record || record.missing) return { ok: false, error: `no async question ${idOrKey}` };
    if (record.finished) return { ok: false, error: `${record.id} is already ${record.status}` };
    const text = String(reply ?? "").trim();
    if (!text) return { ok: false, error: "answer is empty" };
    if (/^\d+$/.test(text)) {
      const index = Number(text) - 1;
      if (index < 0 || index >= record.state.choices.length) return { ok: false, error: `option must be 1..${record.state.choices.length}` };
      applyInput(record, { action: INPUT_ACTIONS.CHOOSE_INDEX, index, source });
    } else applyInput(record, { action: INPUT_ACTIONS.FREEFORM_SUBMIT, text, source });
    return { ok: record.finished, record };
  };

  const dismiss = (idOrKey, source = "command") => {
    const record = lookup([idOrKey])[0];
    if (!record || record.missing || record.finished) return false;
    return finish(record, { status: "cancelled", reason: "discarded", source });
  };

  pi.events?.on?.(INPUT_ACTION_EVENT, viewInputHandler);

  return {
    tools,
    toolNames: ASYNC_CHOICE_TOOL_NAMES,
    completeAhp,
    restore,
    openView,
    closeView,
    cancelAll,
    answer,
    dismiss,
    remember,
    applyInput,
    get viewOpen() { return Boolean(view); },
    get view() { return view; },
    records: () => [...records.values()],
    pending,
    summary: asyncChoiceSummary,
    flushDeliveries,
    // A blocking interactive_choice owns the screen and input devices.
    yieldToSync() { if (view) closeView("superseded"); },
    dispose() {
      disposed = true;
      closeView("shutdown");
      for (const record of records.values()) { if (record.timer) clearTimer(record.timer); record.timer = null; }
      if (deliveryTimer) clearTimer(deliveryTimer);
      deliveryTimer = null;
      try { pi.events?.off?.(INPUT_ACTION_EVENT, viewInputHandler); } catch {}
      try { decisionBridge?.dispose?.(); } catch {}
      try { lastCtx?.ui?.setWidget?.(WIDGET_KEY, undefined); lastCtx?.ui?.setStatus?.(WIDGET_KEY, undefined); } catch {}
    },
  };
}
