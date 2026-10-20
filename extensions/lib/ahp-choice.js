// Optional package-neutral AHP input-provider adapter.
// Paratenic's Pi plugin owns transport/projection through its versioned bridge;
// Agent Utils remains the sole choice-state owner and interprets completion
// only through its existing arbitration path.
//
// The same pending questions are also published on Pi's event bus for
// pi-daemon's pi-durable-adaptor, which serves TUI Pis over the node bridge's
// /ahp (pi-daemon bd-27ef66). The first answer from any surface wins; the
// others are settled.

import { isIncognito } from "./privacy.js";

export const AHP_BRIDGE_SYMBOL = Symbol.for("paratenic.pi.ahp-bridge.v1");
export const AHP_AVAILABLE_EVENT = "paratenic:ahp-bridge-available";
export const AHP_DISCOVERY_EVENT = "paratenic:ahp-bridge-discovery";

/** pi-durable-adaptor's input bus: `{ id, question, choices?, answer(text), cancel() }`. */
export const DURABLE_QUESTION_EVENT = "pi-durable:question";
/** `{ id }`: the question settled here (answered, timed out, withdrawn). */
export const DURABLE_QUESTION_DONE_EVENT = "pi-durable:question-done";
const DURABLE_MAX_QUESTION = 4000;
const DURABLE_MAX_CHOICE = 500;
const DURABLE_MAX_CHOICES = 16;
const DURABLE_MAX_PUBLISHED = 256;

const TRUE_RE = /^(1|true|yes|on)$/i;
let providerSequence = 0;

export function isAhpDisabled(env = process.env) {
  return isIncognito(env) || TRUE_RE.test(String(env.PI_DISABLE_AHP || env.PI_DISABLE_ACP || "").trim());
}

export function choiceAhpRequest(record) {
  if (!record || record.finished) return null;
  return {
    requestId: record.sessionId,
    // Async choices may carry agent-supplied context; the question remains the
    // single prompt, so remote clients render the same option list.
    message: record.ahpMessage || record.question,
    questions: [{
      id: "choice",
      kind: "single_select",
      prompt: record.question,
      required: true,
      allowFreeform: true,
      options: record.state.choices.map((choice, index) => ({
        id: choice.id,
        label: choice.headline || choice.label,
        ...(choice.summary ? { description: choice.summary } : {}),
        recommended: index === record.state.index,
      })),
    }],
    ...(record.deadline == null ? {} : { deadline: new Date(record.deadline).toISOString() }),
  };
}

export function ahpResolutionForResult(record, result = {}) {
  const base = { requestId: record.sessionId, answers: {}, ...(result.commandId ? { commandId: result.commandId } : {}), source: result.source || "agent-utils" };
  if (result.status === "selected" || result.status === "action") {
    return { ...base, resolution: "accept", answers: { choice: { kind: "selected", value: result.choice?.id } } };
  }
  if (result.status === "freeform") {
    return { ...base, resolution: "accept", answers: { choice: { kind: "text", value: result.text } } };
  }
  if (result.status === "timeout") return { ...base, resolution: "timeout" };
  if (result.reason === "superseded") return { ...base, resolution: "superseded" };
  if (result.action === "discard" || /declin|discard/i.test(String(result.reason || ""))) return { ...base, resolution: "decline" };
  return { ...base, resolution: "cancel" };
}

function normalizedAnswer(command) {
  const answer = command?.answers?.choice;
  if (!answer || typeof answer !== "object") return null;
  const kind = String(answer.kind || "").trim().toLowerCase();
  if (kind === "selected") {
    const freeform = Array.isArray(answer.freeformValues)
      ? answer.freeformValues.map((value) => String(value).trim()).find(Boolean)
      : undefined;
    if (freeform) return { kind: "text", value: freeform };
    if (typeof answer.value === "string" && answer.value) return { kind, value: answer.value };
  }
  if (kind === "text" && typeof answer.value === "string" && answer.value.trim()) return { kind, value: answer.value.trim() };
  return null;
}

// One provider may own one blocking choice (`getActive`) or many concurrently
// pending async choices (`listActive`). Paratenic's v1 bridge already accepts
// many requests per provider; each record keeps its own opaque request ID.
/** A question as pi-durable-adaptor reads it; null when it cannot be one. */
export function durableQuestion(record) {
  const request = choiceAhpRequest(record);
  if (!request) return null;
  const text = String(request.message || record.question || "").slice(0, DURABLE_MAX_QUESTION);
  if (!text.trim()) return null;
  const labels = (record.state?.choices || []).map((choice) => String(choice.headline || choice.label || "").slice(0, DURABLE_MAX_CHOICE));
  // Answers come back as text, so the choices must be distinct and fit the bus.
  const usable = labels.length >= 2 && labels.length <= DURABLE_MAX_CHOICES && labels.every((label) => label.trim()) && new Set(labels).size === labels.length;
  return { id: String(request.requestId).slice(0, 200), question: text, ...(usable ? { choices: labels } : {}) };
}

/** The answer a chosen choice's text (or free text) stands for. */
export function durableAnswer(record, text) {
  const value = String(text ?? "");
  const choices = record.state?.choices || [];
  const label = (choice) => String(choice.headline || choice.label || "");
  const match = choices.find((choice) => label(choice) === value)
    || choices.find((choice) => label(choice).trim().toLowerCase() === value.trim().toLowerCase());
  return match ? { kind: "selected", value: match.id } : { kind: "text", value };
}

export function createAhpChoiceProvider({ pi, env = process.env, getActive, listActive, complete, bridge: explicitBridge, providerId, providerPrefix = "agent-utils.choice", disabled = false } = {}) {
  if (disabled || isAhpDisabled(env)) return { enabled: false, requested() {}, updated() {}, resolved() {}, dispose() {} };
  let handle = null;
  let bridge = null;
  let disposed = false;
  const id = providerId || `${providerPrefix}.${process.pid}.${++providerSequence}`;
  const pending = () => {
    const records = typeof listActive === "function" ? listActive() : [getActive?.()];
    return (Array.isArray(records) ? records : []).filter((record) => record && !record.finished);
  };
  const find = (requestId) => pending().find((record) => record.sessionId === requestId) || null;

  const register = (candidate) => {
    if (disposed || handle || !candidate || candidate.version !== 1 || candidate.enabled !== true || typeof candidate.registerInputProvider !== "function") return false;
    bridge = candidate;
    try {
      handle = bridge.registerInputProvider({
        version: 1,
        providerId: id,
        questionKinds: ["single_select"],
        freeform: true,
        drafts: false,
        maxQuestions: 1,
        maxOptions: 9,
        snapshot: () => pending().map(choiceAhpRequest).filter(Boolean),
        complete: async (command) => {
          const active = find(command?.requestId);
          if (!active) return { accepted: false, error: "Input request is no longer pending" };
          const response = String(command?.response || "").trim().toLowerCase();
          if (response === "accept") {
            const answer = normalizedAnswer(command);
            if (!answer) return { accepted: false, error: "Choice completion requires one selected or text answer" };
            if (answer.kind === "selected" && !active.state.choices.some((choice) => choice.id === answer.value)) {
              return { accepted: false, error: "Choice completion references an unknown option ID" };
            }
            setTimeout(() => complete?.({ response, answer, requestId: command.requestId, commandId: command.commandId, operationId: command.operationId }), 0);
            return { accepted: true };
          }
          if (["decline", "cancel", "timeout", "superseded"].includes(response)) {
            setTimeout(() => complete?.({ response, requestId: command.requestId, commandId: command.commandId, operationId: command.operationId }), 0);
            return { accepted: true };
          }
          return { accepted: false, error: "Unsupported choice completion response" };
        },
      });
      for (const current of pending().map(choiceAhpRequest).filter(Boolean)) handle.requested(current);
      return true;
    } catch {
      handle = null;
      bridge = null;
      return false;
    }
  };

  // pi-durable-adaptor's bus: publish each pending question once; its
  // answer/cancel go through the same arbitration as an AHP completion.
  const published = new Set();
  const publish = (record) => {
    const events = pi?.events;
    if (disposed || typeof events?.emit !== "function") return;
    const question = durableQuestion(record);
    if (!question || published.has(question.id)) return;
    published.add(question.id);
    while (published.size > DURABLE_MAX_PUBLISHED) published.delete(published.values().next().value);
    let settled = false;
    const settle = (command) => {
      if (settled || disposed) return;
      const active = find(record.sessionId);
      if (!active) return;
      settled = true;
      setTimeout(() => complete?.({ ...command, requestId: record.sessionId, source: "pi-durable" }), 0);
    };
    try {
      events.emit(DURABLE_QUESTION_EVENT, {
        ...question,
        answer: (text) => settle({ response: "accept", answer: durableAnswer(record, text) }),
        cancel: () => settle({ response: "decline" }),
      });
    } catch {}
  };
  const unpublish = (requestId) => {
    if (!published.delete(String(requestId))) return;
    try { pi?.events?.emit?.(DURABLE_QUESTION_DONE_EVENT, { id: String(requestId) }); } catch {}
  };

  const available = (value) => register(value);
  pi?.events?.on?.(AHP_AVAILABLE_EVENT, available);
  register(explicitBridge || globalThis[AHP_BRIDGE_SYMBOL]);
  if (!handle) {
    try { pi?.events?.emit?.(AHP_DISCOVERY_EVENT, { consumer: "input-provider", version: 1 }); } catch {}
  }
  for (const current of pending()) publish(current);

  return {
    get enabled() { return Boolean(handle); },
    requested(record) {
      const request = choiceAhpRequest(record);
      if (request) { try { handle?.requested?.(request); } catch {} }
      publish(record);
    },
    // Highlight moves and redraws: the question itself is unchanged.
    updated(record) { const request = choiceAhpRequest(record); if (request) { try { handle?.updated?.(request); } catch {} } },
    resolved(record, result) {
      if (handle) { try { handle.resolved(ahpResolutionForResult(record, result)); } catch {} }
      unpublish(record?.sessionId);
    },
    dispose() {
      if (disposed) return;
      for (const requestId of [...published]) unpublish(requestId);
      disposed = true;
      try { pi?.events?.off?.(AHP_AVAILABLE_EVENT, available); } catch {}
      try { handle?.dispose?.(); } catch {}
      handle = null;
      bridge = null;
    },
  };
}
