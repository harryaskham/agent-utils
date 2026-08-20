// Omni cast/event stream -> Agent Utils semantic input actions.

import { INPUT_ACTIONS } from "./input-actions.js";

export const OMNI_INPUT_STATUS_EVENT = "agent-utils:omni-input-status";

function normalized(value) {
  return String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
}

const SEMANTIC = new Map([
  ["select-previous", INPUT_ACTIONS.SELECT_PREVIOUS], ["previous", INPUT_ACTIONS.SELECT_PREVIOUS], ["prev", INPUT_ACTIONS.SELECT_PREVIOUS],
  ["select-next", INPUT_ACTIONS.SELECT_NEXT], ["next", INPUT_ACTIONS.SELECT_NEXT],
  ["choose-current", INPUT_ACTIONS.CHOOSE_CURRENT], ["select", INPUT_ACTIONS.CHOOSE_CURRENT], ["confirm", INPUT_ACTIONS.CHOOSE_CURRENT],
  ["cancel", INPUT_ACTIONS.CANCEL], ["back", INPUT_ACTIONS.CANCEL],
]);

export function parseOmniChoiceLine(line) {
  const rawText = String(line ?? "").trim();
  if (!rawText) return null;
  let envelope;
  try { envelope = JSON.parse(rawText); } catch { return null; }
  const event = normalized(envelope.event ?? envelope.semantic ?? envelope.action ?? envelope.payload?.event);
  let action = SEMANTIC.get(event);
  const command = envelope.command ?? envelope.cmd ?? envelope.payload?.command ?? envelope.payload?.cmd ?? envelope.payload ?? envelope;
  const type = normalized(command?.type);
  if (!action && type === "scroll") {
    const amount = Number(command.amount);
    if (Number.isFinite(amount) && amount !== 0) action = amount > 0 ? INPUT_ACTIONS.SELECT_NEXT : INPUT_ACTIONS.SELECT_PREVIOUS;
  }
  if (!action && type === "key") {
    const key = normalized(command.key);
    if (["up", "left"].includes(key)) action = INPUT_ACTIONS.SELECT_PREVIOUS;
    else if (["down", "right"].includes(key)) action = INPUT_ACTIONS.SELECT_NEXT;
    else if (["enter", "return", "space"].includes(key)) action = INPUT_ACTIONS.CHOOSE_CURRENT;
    else if (["esc", "escape", "back"].includes(key)) action = INPUT_ACTIONS.CANCEL;
  }
  if (!action && type === "text") action = SEMANTIC.get(normalized(command.text));
  if (!action) return null;
  return {
    action,
    source: "omni",
    event: event || type,
    device: envelope.device ?? envelope.source?.device ?? envelope.payload?.device ?? null,
    raw: envelope,
  };
}

export function resolveOmniInputConfig(env = process.env, persistedChoice = {}, persistedOmni = {}) {
  const source = normalized(env.PI_CHOICE_INPUT_SOURCE ?? persistedChoice.inputSource ?? "auto");
  const enabledRaw = env.PI_OMNI_CHOICE_ENABLED ?? persistedOmni.enabled;
  const enabled = enabledRaw == null ? source !== "ring" : /^(1|true|yes|on|enabled)$/i.test(String(enabledRaw));
  const daemon = String(env.PI_OMNI_DAEMON || persistedOmni.daemon || "127.0.0.1:8766");
  return {
    enabled: enabled && source !== "ring",
    source: ["auto", "omni", "ring"].includes(source) ? source : "auto",
    command: String(env.PI_OMNI_COMMAND || persistedOmni.command || "omni"),
    daemon,
    args: Array.isArray(persistedOmni.args) ? persistedOmni.args.map(String) : ["listen", "--daemon", daemon],
  };
}
