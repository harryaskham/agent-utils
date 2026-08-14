import test from "node:test";
import assert from "node:assert/strict";

import {
  CHOICE_INPUT_ACTIONS,
  CHOICE_INPUT_EVENT,
  CHOICE_SESSION_EVENT,
  ChoiceStateMachine,
  createChoiceSpeaker,
  formatChoiceIntroduction,
  keyboardChoiceAction,
  normalizeChoices,
} from "../extensions/lib/choice.js";
import { createChoiceExtension } from "../extensions/choice.js";

function eventBus() {
  const handlers = new Map();
  return {
    on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); },
    off(name, fn) { handlers.set(name, (handlers.get(name) || []).filter((item) => item !== fn)); },
    emit(name, payload) { for (const fn of [...(handlers.get(name) || [])]) fn(payload); },
  };
}

function harness() {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const events = eventBus();
  const widgets = new Map();
  const notifications = [];
  const sentMessages = [];
  const terminalHandlers = [];
  const editor = { value: "" };
  const ctx = {
    ui: {
      setWidget(name, value) { if (value === undefined) widgets.delete(name); else widgets.set(name, value); },
      notify(message, level = "info") { notifications.push({ message, level }); },
      onTerminalInput(fn) { terminalHandlers.push(fn); return () => { const i = terminalHandlers.indexOf(fn); if (i >= 0) terminalHandlers.splice(i, 1); }; },
      getEditorText() { return editor.value; },
      setEditorText(value) { editor.value = String(value ?? ""); },
    },
  };
  const pi = {
    events,
    registerCommand(name, def) { commands.set(name, def); },
    registerTool(def) { tools.set(def.name, def); },
    registerMessageRenderer() {},
    sendMessage(message, options) { sentMessages.push({ message, options }); },
    on(name, fn) { handlers.set(name, fn); },
  };
  const input = (data) => [...terminalHandlers].map((fn) => fn(data));
  return { pi, ctx, commands, tools, handlers, widgets, notifications, sentMessages, editor, input, events };
}

const choices = [
  { label: "alpha", headline: "Alpha" },
  { label: "beta", headline: "Beta" },
  { label: "gamma", headline: "Gamma" },
];

test("choice state machine supports wrap, clamp, direct index, select, cancel, and invalid actions", () => {
  const state = new ChoiceStateMachine({ choices, wrap: true });
  assert.equal(state.apply({ action: CHOICE_INPUT_ACTIONS.PREVIOUS }).index, 2, "previous wraps to last");
  assert.equal(state.apply({ action: CHOICE_INPUT_ACTIONS.NEXT }).index, 0, "next wraps to first");
  assert.equal(state.apply({ action: CHOICE_INPUT_ACTIONS.CHOOSE_INDEX, index: 1 }).choice.label, "beta");
  assert.equal(state.done, true);
  assert.equal(state.apply({ action: "garbage" }).reason, "finished");

  const clamped = new ChoiceStateMachine({ choices, wrap: false });
  assert.equal(clamped.apply({ action: CHOICE_INPUT_ACTIONS.PREVIOUS }).index, 0);
  assert.equal(clamped.apply({ action: CHOICE_INPUT_ACTIONS.CHOOSE_INDEX, index: 99 }).reason, "index-out-of-range");
  assert.equal(clamped.apply({ action: CHOICE_INPUT_ACTIONS.CANCEL }).type, "cancelled");
});

test("keyboard input maps arrows, j/k, Enter, Escape, and one-indexed numeric choices", () => {
  assert.equal(keyboardChoiceAction("\u001b[A", 3).action, CHOICE_INPUT_ACTIONS.PREVIOUS);
  assert.equal(keyboardChoiceAction("k", 3).action, CHOICE_INPUT_ACTIONS.PREVIOUS);
  assert.equal(keyboardChoiceAction("\u001b[B", 3).action, CHOICE_INPUT_ACTIONS.NEXT);
  assert.equal(keyboardChoiceAction("j", 3).action, CHOICE_INPUT_ACTIONS.NEXT);
  assert.equal(keyboardChoiceAction("\r", 3).action, CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT);
  assert.equal(keyboardChoiceAction("\u001b", 3).action, CHOICE_INPUT_ACTIONS.CANCEL);
  assert.deepEqual(keyboardChoiceAction("3", 3), { action: CHOICE_INPUT_ACTIONS.CHOOSE_INDEX, index: 2, source: "keyboard", raw: "3" });
  assert.equal(keyboardChoiceAction("4", 3), null, "out-of-range numeric key passes through");
  assert.equal(keyboardChoiceAction("x", 3), null);
});

test("choice normalization and spoken introduction include every option", () => {
  assert.deepEqual(normalizeChoices(["A", { label: "b", headline: "Bee", summary: "second" }]).map((c) => c.label), ["A", "b"]);
  assert.match(formatChoiceIntroduction("Pick", choices), /Pick Option 1: Alpha Option 2: Beta Option 3: Gamma Selected: Alpha/);
  assert.throws(() => normalizeChoices(["one"]), /at least two/);
});

test("choice extension resolves keyboard and external event inputs through one bus", async () => {
  const spoken = [];
  const speaker = { speak: async (text) => { spoken.push(text); }, dispose() {} };
  const h = harness();
  createChoiceExtension({ speaker })(h.pi);
  const sessions = [];
  h.events.on(CHOICE_SESSION_EVENT, (event) => sessions.push(event));

  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 1000 }, null, null, h.ctx);
  await Promise.resolve();
  assert.ok(h.widgets.has("agent-utils-choice"));
  h.input("j");
  await Promise.resolve();
  assert.match(String(h.widgets.get("agent-utils-choice")?.[2]), /▶ 2\. Beta/);
  assert.ok(spoken.some((text) => text === "Beta"), "navigation speaks the new headline");

  // A device adapter emits the same semantic event as the keyboard.
  const sessionId = sessions.find((event) => event.status === "started").sessionId;
  h.events.emit(CHOICE_INPUT_EVENT, { action: CHOICE_INPUT_ACTIONS.CHOOSE_INDEX, index: 2, source: "test-adapter", sessionId });
  const result = await pending;
  assert.equal(result.details.status, "selected");
  assert.equal(result.details.choice.label, "gamma");
  assert.equal(result.details.source, "test-adapter");
  assert.equal(h.widgets.has("agent-utils-choice"), false);
  assert.equal(sessions.at(-1).status, "ended");
});

test("Escape dismisses the choice, preserves editor text, and waits for the next freeform submission", async () => {
  const h = harness();
  const speaker = { speak: async () => {}, interrupt() {}, dispose() {} };
  createChoiceExtension({ speaker })(h.pi);
  h.editor.value = "draft freeform";
  let settled = false;
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 1000 }, null, null, h.ctx);
  pending.then(() => { settled = true; });
  await Promise.resolve();
  const responses = h.input("\u001b");
  await Promise.resolve();
  assert.ok(responses.some((response) => response?.consume), "Escape is consumed by the visible choice");
  assert.equal(settled, false, "Escape alone does not return a tool result or resume the agent");
  assert.equal(h.widgets.has("agent-utils-choice"), false, "choice UI disappears immediately");
  assert.equal(h.editor.value, "draft freeform", "choice dismissal never clears or submits the editor");
  assert.equal(h.input("x").length, 0, "terminal interception is removed so freeform typing is ordinary editor input");

  const inputResult = h.handlers.get("input")({ text: "my freeform answer" }, h.ctx);
  assert.deepEqual(inputResult, { action: "continue" }, "the next user submission remains on Pi's normal input path");
  const result = await pending;
  assert.equal(result.details.status, "cancelled");
  assert.equal(result.details.reason, "freeform");
});

test("choice timeout resolves without inventing a selection", async () => {
  const h = harness();
  createChoiceExtension({ speaker: { speak: async () => {}, dispose() {} } })(h.pi);
  const result = await h.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 5 }, null, null, h.ctx);
  assert.equal(result.details.status, "timeout");
  assert.equal(h.widgets.has("agent-utils-choice"), false);
});

test("timeoutMs=0 leaves choice active indefinitely until explicit input", async () => {
  const h = harness();
  createChoiceExtension({ speaker: { speak: async () => {}, interrupt() {}, dispose() {} }, persistedSettings: { choice: {}, tts: {} } })(h.pi);
  let settled = false;
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2), timeoutMs: 0 }, null, null, h.ctx);
  pending.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  h.input("q");
  const result = await pending;
  assert.equal(result.details.status, "cancelled");
});

test("choice extension honors persisted agentUtils.choice defaults", async () => {
  const spoken = [];
  const h = harness();
  createChoiceExtension({
    speaker: { speak: async (text) => { spoken.push(text); }, interrupt() {}, dispose() {} },
    persistedSettings: { choice: { timeoutMs: 5, wrap: false, maxChoices: 2, speechEnabled: false }, tts: {} },
  })(h.pi);
  const tooMany = await h.tools.get("interactive_choice").execute("id", { question: "Pick", choices }, null, null, h.ctx);
  assert.equal(tooMany.details.status, "error");
  assert.match(tooMany.details.error, /at most 2/);
  const timed = await h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2) }, null, null, h.ctx);
  assert.equal(timed.details.status, "timeout");
  assert.deepEqual(spoken, [], "persisted speechEnabled=false suppresses choice TTS");
});

test("/force-choice injects once at agent_end, requires interactive_choice, then rearms", async () => {
  const h = harness();
  createChoiceExtension({
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    persistedSettings: { choice: { forceAtAgentEnd: true }, tts: {} },
  })(h.pi);
  h.handlers.get("agent_end")({}, h.ctx);
  assert.equal(h.sentMessages.length, 1);
  assert.match(h.sentMessages[0].message.content, /Present interactive_choice now/);
  assert.deepEqual(h.sentMessages[0].options, { deliverAs: "followUp", triggerTurn: true });
  h.handlers.get("agent_end")({}, h.ctx);
  assert.equal(h.sentMessages.length, 1, "unsatisfied force request does not hot-loop");

  const pending = h.tools.get("interactive_choice").execute("id", { question: "Next?", choices: choices.slice(0, 2), timeoutMs: 1000 }, null, null, h.ctx);
  await Promise.resolve();
  h.input("1");
  await pending;
  h.handlers.get("agent_end")({}, h.ctx);
  assert.equal(h.sentMessages.length, 2, "a real choice satisfies and rearms the next end-of-agent request");
});

test("choice speaker inherits persisted agentUtils.tts and interrupts stale speech/player", async () => {
  const calls = [];
  const synthOptions = [];
  const player = {
    interrupt() { calls.push("interrupt"); },
    async play(pcm, options) { calls.push({ pcm: String(pcm), options }); return { interrupted: false }; },
  };
  const speaker = createChoiceSpeaker({
    env: { AZURE_SPEECH_API_KEY: "secret" },
    persisted: { voice: "PersistedVoice", embedding: "profile", lang: "cy-GB", speed: 1.4, endpoint: "https://speech", backend: "pulse", device: "persisted_sink" },
    synthesize: async (text, options) => { synthOptions.push(options); return Buffer.from(text); },
    player,
  });
  await speaker.speak("hello");
  assert.equal(calls[0], "interrupt");
  assert.equal(calls[1].pcm, "hello");
  assert.equal(synthOptions[0].voice, "PersistedVoice");
  assert.equal(synthOptions[0].speakerProfileId, "profile");
  assert.equal(synthOptions[0].endpoint, "https://speech");
  assert.equal(calls[1].options.device, "persisted_sink");
  assert.equal(calls[1].options.streamName, "/choice");
});
