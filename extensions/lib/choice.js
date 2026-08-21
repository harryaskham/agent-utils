// Generic multi-input spoken choice primitives (bd-8b3005).
//
// Choice presentation is intentionally independent of every input device.
// Extensions publish semantic actions on the generic INPUT_ACTION_EVENT; the
// choice surface consumes them. Keyboard and ring are merely two producers on
// the same bus.

import { INPUT_ACTION_EVENT, INPUT_ACTIONS } from "./input-actions.js";
import { resolveAgentTtsSettings } from "./tts-narration.js";
import {
  DEFAULT_TTS_BACKEND,
  DEFAULT_TTS_DEVICE,
  createInterruptiblePcmPlayer,
  resolveSpeakToolParams,
  synthesizeSpeechDirect,
} from "./tts.js";

export const CHOICE_SESSION_EVENT = "agent-utils:choice-session";
// Compatibility aliases for choice consumers; the actual bus contract is
// generic and lives in input-actions.js so device adapters remain independent.
export const CHOICE_INPUT_EVENT = INPUT_ACTION_EVENT;
export const CHOICE_INPUT_ACTIONS = Object.freeze({
  PREVIOUS: INPUT_ACTIONS.SELECT_PREVIOUS,
  NEXT: INPUT_ACTIONS.SELECT_NEXT,
  CHOOSE_CURRENT: INPUT_ACTIONS.CHOOSE_CURRENT,
  CHOOSE_INDEX: INPUT_ACTIONS.CHOOSE_INDEX,
  CANCEL: INPUT_ACTIONS.CANCEL,
  FREEFORM_ENTER: INPUT_ACTIONS.FREEFORM_ENTER,
  FREEFORM_UPDATE: INPUT_ACTIONS.FREEFORM_UPDATE,
  FREEFORM_SUBMIT: INPUT_ACTIONS.FREEFORM_SUBMIT,
  FREEFORM_CANCEL: INPUT_ACTIONS.FREEFORM_CANCEL,
  FREEFORM_PTT_COMMIT: INPUT_ACTIONS.FREEFORM_PTT_COMMIT,
});
export { INPUT_ACTION_EVENT, INPUT_ACTIONS };
export const DEFAULT_CHOICE_TIMEOUT_MS = 30_000;
export const DEFAULT_CHOICE_STREAM_NAME = "/choice";

export function normalizeChoices(choices = []) {
  if (!Array.isArray(choices)) throw new Error("choice: choices must be an array");
  const out = choices.map((choice) => {
    if (typeof choice === "string") {
      const label = choice.trim();
      return { label, headline: label, summary: "", value: label };
    }
    const label = String(choice?.label ?? choice?.headline ?? choice?.value ?? "").trim();
    return {
      label,
      headline: String(choice?.headline ?? label).trim(),
      summary: String(choice?.summary ?? "").trim(),
      value: choice?.value ?? label,
      ...(choice?.tts === false ? { tts: false } : {}),
      ...(choice?.terminal === true ? { terminal: true } : {}),
      ...(choice?.appended === true ? { appended: true } : {}),
      ...(choice?.cacophonyAction ? { cacophonyAction: String(choice.cacophonyAction) } : {}),
    };
  }).filter((choice) => choice.label);
  if (out.length < 2) throw new Error("choice: at least two non-empty choices are required");
  return out.map((choice, index) => ({ ...choice, index }));
}

export class ChoiceStateMachine {
  constructor({ choices, initialIndex = 0, wrap = true } = {}) {
    this.choices = normalizeChoices(choices);
    this.wrap = wrap !== false;
    const initial = Number.isFinite(Number(initialIndex)) ? Math.trunc(Number(initialIndex)) : 0;
    this.index = Math.min(this.choices.length - 1, Math.max(0, initial));
    this.done = false;
  }

  current() {
    return this.choices[this.index];
  }

  apply(input = {}) {
    if (this.done) return { type: "ignored", reason: "finished", index: this.index, choice: this.current() };
    const action = String(input?.action ?? input ?? "").trim().toLowerCase();
    if (action === CHOICE_INPUT_ACTIONS.PREVIOUS || action === CHOICE_INPUT_ACTIONS.NEXT) {
      const direction = action === CHOICE_INPUT_ACTIONS.NEXT ? 1 : -1;
      const oldIndex = this.index;
      if (this.wrap) this.index = (this.index + direction + this.choices.length) % this.choices.length;
      else this.index = Math.min(this.choices.length - 1, Math.max(0, this.index + direction));
      return { type: "navigate", action, changed: this.index !== oldIndex, index: this.index, choice: this.current(), source: input?.source };
    }
    if (action === CHOICE_INPUT_ACTIONS.CHOOSE_INDEX) {
      const index = Math.trunc(Number(input?.index));
      if (!Number.isFinite(index) || index < 0 || index >= this.choices.length) {
        return { type: "ignored", reason: "index-out-of-range", index: this.index, choice: this.current(), source: input?.source };
      }
      this.index = index;
      this.done = true;
      return { type: "selected", action, index, choice: this.current(), source: input?.source };
    }
    if (action === CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT) {
      this.done = true;
      return { type: "selected", action, index: this.index, choice: this.current(), source: input?.source };
    }
    if (action === CHOICE_INPUT_ACTIONS.CANCEL) {
      this.done = true;
      return { type: "cancelled", action, index: this.index, choice: this.current(), source: input?.source };
    }
    return { type: "ignored", reason: "unmapped", index: this.index, choice: this.current(), source: input?.source };
  }
}

function kittyKeyCode(data) {
  // CSI unicode-key-code[:alternate-key-codes][;modifiers:event][;text] u
  // Keep only the primary key code; later fields describe modifiers, event type,
  // and optionally composed text. Kitty may emit any or all of them.
  const match = /^\u001b\[(\d+)(?::\d+)*(?:;[\d:]+)*u$/.exec(String(data ?? ""));
  return match ? Number(match[1]) : null;
}

export function isChoiceEscapeKey(data) {
  const key = String(data ?? "");
  return key === "\u001b" || kittyKeyCode(key) === 27;
}

// Modern terminals can report Enter through Kitty's CSI-u keyboard protocol
// (`ESC [ 13 u`, optionally with modifier/event fields) rather than the legacy
// CR/LF bytes. Pi's custom modal receives the raw terminal sequence, so direct
// `key === "\r"` checks silently stopped working when extended-key reporting was
// enabled. Keypad Enter in application mode is ESC O M.
export function isChoiceEnterKey(data) {
  const key = String(data ?? "");
  return key === "\r" || key === "\n" || key === "\u001bOM" || kittyKeyCode(key) === 13;
}

export function isChoiceQuitKey(data) {
  const key = String(data ?? "");
  const code = kittyKeyCode(key);
  return key === "q" || key === "Q" || code === 113 || code === 81;
}

// Map terminal input to the same semantic actions used by device adapters.
// Numeric keys are one-indexed: "1" chooses index 0; "9" chooses index 8.
export function keyboardChoiceAction(data, choiceCount = 0) {
  const key = String(data ?? "");
  if (key === "\u001b[A" || key === "k" || key === "K") return { action: CHOICE_INPUT_ACTIONS.PREVIOUS, source: "keyboard", raw: key };
  if (key === "\u001b[B" || key === "j" || key === "J") return { action: CHOICE_INPUT_ACTIONS.NEXT, source: "keyboard", raw: key };
  if (isChoiceEnterKey(key)) return { action: CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT, source: "keyboard", raw: key };
  if (isChoiceEscapeKey(key) || isChoiceQuitKey(key) || key === "\u0003") return { action: CHOICE_INPUT_ACTIONS.CANCEL, source: "keyboard", raw: key };
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    if (index < choiceCount) return { action: CHOICE_INPUT_ACTIONS.CHOOSE_INDEX, index, source: "keyboard", raw: key };
  }
  return null;
}

export function formatChoiceIntroduction(question, choices, initialIndex = 0, { prefix = "", suffix = "" } = {}) {
  const prompt = `${String(prefix ?? "")}${String(question ?? "").trim()}${String(suffix ?? "")}`;
  const normalized = normalizeChoices(choices);
  const index = Math.min(normalized.length - 1, Math.max(0, Math.trunc(Number(initialIndex) || 0)));
  const options = normalized
    .map((choice, i) => ({ choice, i }))
    .filter(({ choice }) => choice.tts !== false)
    .map(({ choice, i }) => `Option ${i + 1}: ${choice.headline}${choice.summary ? `. ${choice.summary}` : ""}`);
  const selected = normalized[index]?.tts === false ? "" : `Selected: ${normalized[index].headline}.`;
  return [prompt, ...options, selected].filter(Boolean).join(" ");
}

export function createChoiceSpeaker({
  env = process.env,
  persisted = {},
  synthesize = synthesizeSpeechDirect,
  player = createInterruptiblePcmPlayer(),
  streamName = DEFAULT_CHOICE_STREAM_NAME,
} = {}) {
  const shared = resolveAgentTtsSettings({ env, persisted }).config;
  let synthesis = null;

  const interrupt = () => {
    try { synthesis?.abort(); } catch {}
    synthesis = null;
    try { player.interrupt?.(); } catch {}
  };

  const speak = async (text) => {
    const body = String(text ?? "").trim();
    if (!body) return { skipped: true };
    interrupt();
    const controller = new AbortController();
    synthesis = controller;
    const resolved = resolveSpeakToolParams({ text: body }, { env, persisted });
    try {
      const options = {
        voice: resolved.voice,
        lang: resolved.lang,
        speed: resolved.speed,
        speakerProfileId: resolved.speakerProfileId,
        style: resolved.style,
        styleDegree: resolved.styleDegree,
        signal: controller.signal,
        env,
      };
      if (!env.AZURE_SPEECH_ENDPOINT && shared.endpoint !== undefined) options.endpoint = shared.endpoint;
      const pcm = await synthesize(body, options);
      if (synthesis !== controller || controller.signal.aborted) return { interrupted: true };
      return await player.play(pcm, {
        backend: env.PI_TTS_BACKEND || env.PI_CASCADE_AUDIO_BACKEND || shared.backend || DEFAULT_TTS_BACKEND,
        server: env.PULSE_SERVER || shared.server,
        device: env.PULSE_SINK || shared.device || DEFAULT_TTS_DEVICE,
        streamName,
        env,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") return { interrupted: true };
      throw error;
    } finally {
      if (synthesis === controller) synthesis = null;
    }
  };

  return { speak, interrupt, dispose: interrupt };
}
