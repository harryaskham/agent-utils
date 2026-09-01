// Optional package-neutral Paratenic AHP input-provider adapter.
// Paratenic owns transport/projection; Agent Utils remains the sole choice-state
// owner and interprets completion only through its existing arbitration path.

export const AHP_BRIDGE_SYMBOL = Symbol.for("paratenic.pi.ahp-bridge.v1");
export const AHP_AVAILABLE_EVENT = "paratenic:ahp-bridge-available";
export const AHP_DISCOVERY_EVENT = "paratenic:ahp-bridge-discovery";

const TRUE_RE = /^(1|true|yes|on)$/i;
let providerSequence = 0;

export function isAhpDisabled(env = process.env) {
  return TRUE_RE.test(String(env.PI_DISABLE_AHP || env.PI_DISABLE_ACP || "").trim());
}

export function choiceAhpRequest(record) {
  if (!record || record.finished) return null;
  return {
    requestId: record.sessionId,
    message: record.question,
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

export function createAhpChoiceProvider({ pi, env = process.env, getActive, complete, bridge: explicitBridge, providerId, disabled = false } = {}) {
  if (disabled || isAhpDisabled(env)) return { enabled: false, requested() {}, updated() {}, resolved() {}, dispose() {} };
  let handle = null;
  let bridge = null;
  let disposed = false;
  const id = providerId || `agent-utils.choice.${process.pid}.${++providerSequence}`;

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
        snapshot: () => {
          const request = choiceAhpRequest(getActive?.());
          return request ? [request] : [];
        },
        complete: async (command) => {
          const active = getActive?.();
          if (!active || active.finished || command?.requestId !== active.sessionId) return { accepted: false, error: "Input request is no longer pending" };
          const response = String(command?.response || "").trim().toLowerCase();
          if (response === "accept") {
            const answer = normalizedAnswer(command);
            if (!answer) return { accepted: false, error: "Choice completion requires one selected or text answer" };
            if (answer.kind === "selected" && !active.state.choices.some((choice) => choice.id === answer.value)) {
              return { accepted: false, error: "Choice completion references an unknown option ID" };
            }
            setTimeout(() => complete?.({ response, answer, commandId: command.commandId, operationId: command.operationId }), 0);
            return { accepted: true };
          }
          if (["decline", "cancel", "timeout", "superseded"].includes(response)) {
            setTimeout(() => complete?.({ response, commandId: command.commandId, operationId: command.operationId }), 0);
            return { accepted: true };
          }
          return { accepted: false, error: "Unsupported choice completion response" };
        },
      });
      const current = choiceAhpRequest(getActive?.());
      if (current) handle.requested(current);
      return true;
    } catch {
      handle = null;
      bridge = null;
      return false;
    }
  };

  const available = (value) => register(value);
  pi?.events?.on?.(AHP_AVAILABLE_EVENT, available);
  register(explicitBridge || globalThis[AHP_BRIDGE_SYMBOL]);
  if (!handle) {
    try { pi?.events?.emit?.(AHP_DISCOVERY_EVENT, { consumer: "input-provider", version: 1 }); } catch {}
  }

  return {
    get enabled() { return Boolean(handle); },
    requested(record) { const request = choiceAhpRequest(record); if (request) { try { handle?.requested?.(request); } catch {} } },
    updated(record) { const request = choiceAhpRequest(record); if (request) { try { handle?.updated?.(request); } catch {} } },
    resolved(record, result) { if (handle) { try { handle.resolved(ahpResolutionForResult(record, result)); } catch {} } },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { pi?.events?.off?.(AHP_AVAILABLE_EVENT, available); } catch {}
      try { handle?.dispose?.(); } catch {}
      handle = null;
      bridge = null;
    },
  };
}
