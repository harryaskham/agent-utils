import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHOICE_INPUT_ACTIONS,
  CHOICE_INPUT_EVENT,
  CHOICE_CAPABILITY_EVENT,
  CHOICE_SESSION_EVENT,
  ChoiceStateMachine,
  createChoiceSpeaker,
  formatChoiceIntroduction,
  keyboardChoiceAction,
  normalizeChoices,
} from "../extensions/lib/choice.js";
import {
  FORCE_CHOICE_CUSTOM_TYPE,
  createChoiceExtension,
  hasUnavailableForcedChoiceTail,
  normalizeChoiceAppendEntries,
  resolveChoiceSettings,
} from "../extensions/choice.js";

// Managed test processes inherit CACO_AGENT_ID/CACO_PROJECT. Never mirror unit
// test choices into the operator's durable Cacophony choice queue.
process.env.PI_CHOICE_CACO_ENABLED = "0";

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

test("choice repeat settings resolve defaults and env overrides", () => {
  assert.deepEqual(resolveChoiceSettings({}, {}).repeat, { interval: 300, limit: null });
  assert.deepEqual(resolveChoiceSettings({ PI_CHOICE_REPEAT_INTERVAL: "12.5", PI_CHOICE_REPEAT_LIMIT: "3" }, { repeat: { interval: 90, limit: null } }).repeat, { interval: 12.5, limit: 3 });
  assert.deepEqual(resolveChoiceSettings({ PI_CHOICE_REPEAT_LIMIT: "null" }, { repeat: { interval: 45, limit: 2 } }).repeat, { interval: 45, limit: null });
});

test("configured appended actions normalize without mutating startup settings", () => {
  const append = [
    { title: "Generate more", description: "Try another set", tts: false, cacophonyAction: "freeformReply" },
    { title: "Stop", description: "End here", terminal: true, tts: false, cacophonyAction: "discard" },
    { title: "Unknown", cacophonyAction: "unsupported" },
  ];
  const before = structuredClone(append);
  assert.deepEqual(normalizeChoiceAppendEntries(append), [
    { label: "Generate more", headline: "Generate more", summary: "Try another set", value: { cacophonyAction: "freeformReply" }, tts: false, terminal: false, cacophonyAction: "freeformReply", appended: true },
    { label: "Stop", headline: "Stop", summary: "End here", value: { cacophonyAction: "discard" }, tts: false, terminal: true, cacophonyAction: "discard", appended: true },
  ]);
  assert.deepEqual(append, before);
  assert.deepEqual(resolveChoiceSettings({}, { append }).append.map((choice) => choice.label), ["Generate more", "Stop"]);
});

test("choice state machine supports wrap, clamp, direct index, select, cancel, and invalid actions", () => {
  const state = new ChoiceStateMachine({ choices, wrap: true });
  assert.equal(state.apply({ action: CHOICE_INPUT_ACTIONS.PREVIOUS }).index, 2, "previous wraps to last");
  assert.equal(state.apply({ action: CHOICE_INPUT_ACTIONS.NEXT }).index, 0, "next wraps to first");
  assert.equal(state.apply({ action: CHOICE_INPUT_ACTIONS.CHOOSE_ID, choiceId: "option-2" }).choice.label, "beta");
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
  assert.equal(keyboardChoiceAction("\n", 3).action, CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT);
  assert.equal(keyboardChoiceAction("\u001b[13u", 3).action, CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT, "Kitty CSI-u Enter is recognized");
  assert.equal(keyboardChoiceAction("\u001b[13;1u", 3).action, CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT, "Kitty Enter with modifier field is recognized");
  assert.equal(keyboardChoiceAction("\u001b[13;1:1u", 3).action, CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT, "Kitty Enter with event field is recognized");
  assert.equal(keyboardChoiceAction("\u001b[13;1:1;13u", 3).action, CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT, "Kitty Enter with text field is recognized");
  assert.equal(keyboardChoiceAction("\u001bOM", 3).action, CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT, "application keypad Enter is recognized");
  assert.equal(keyboardChoiceAction("\u001b", 3).action, CHOICE_INPUT_ACTIONS.CANCEL);
  assert.equal(keyboardChoiceAction("q", 3).action, CHOICE_INPUT_ACTIONS.CANCEL);
  assert.equal(keyboardChoiceAction("Q", 3).action, CHOICE_INPUT_ACTIONS.CANCEL);
  assert.equal(keyboardChoiceAction("\u001b[27u", 3).action, CHOICE_INPUT_ACTIONS.CANCEL, "Kitty CSI-u Escape is recognized");
  assert.equal(keyboardChoiceAction("\u001b[113u", 3).action, CHOICE_INPUT_ACTIONS.CANCEL, "Kitty CSI-u q is recognized");
  assert.deepEqual(keyboardChoiceAction("3", 3), { action: CHOICE_INPUT_ACTIONS.CHOOSE_INDEX, index: 2, source: "keyboard", raw: "3" });
  assert.equal(keyboardChoiceAction("4", 3), null, "out-of-range numeric key passes through");
  assert.equal(keyboardChoiceAction("x", 3), null);
});

test("choice normalization and spoken introduction include every option", () => {
  assert.deepEqual(normalizeChoices(["A", { label: "b", headline: "Bee", summary: "second" }]).map((c) => c.label), ["A", "b"]);
  assert.match(formatChoiceIntroduction("Pick", choices), /Pick Option 1: Alpha Option 2: Beta Option 3: Gamma Selected: Alpha/);
  assert.match(formatChoiceIntroduction("Pick", choices, 0, { prefix: "Agent: ", suffix: " please" }), /^Agent: Pick please Option 1: Alpha/, "affixes wrap only the question before unmodified options");
  assert.throws(() => normalizeChoices(["one"]), /at least two/);
});

test("choice extension synchronizes its modal with an injected Cacophony bridge", async () => {
  const h = harness();
  const settled = [];
  let externalResolve;
  const cacophonyBridge = {
    config: { enabled: true },
    start({ onResolution }) {
      externalResolve = onResolution;
      return { settleLocal(result) { settled.push(result); } };
    },
  };
  createChoiceExtension({ speaker: { speak: async () => {}, interrupt() {}, dispose() {} }, cacophonyBridge })(h.pi);
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 1000 }, null, null, h.ctx);
  await Promise.resolve();
  externalResolve({ status: "selected", index: 1, source: "cacophony" });
  const result = await pending;
  assert.equal(result.details.choice.label, "beta");
  assert.equal(result.details.source, "cacophony");
  assert.equal(settled[0].source, "cacophony", "bridge sees terminal result but does not resolve itself again");
});

test("choice extension resolves keyboard and external event inputs through one bus", async () => {
  const spoken = [];
  const speaker = { speak: async (text) => { spoken.push(text); }, dispose() {} };
  const h = harness();
  createChoiceExtension({ speaker })(h.pi);
  const sessions = [];
  const capabilities = [];
  h.events.on(CHOICE_SESSION_EVENT, (event) => sessions.push(event));
  h.events.on(CHOICE_CAPABILITY_EVENT, (event) => capabilities.push(event));
  h.handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] }, ui: h.ctx.ui });
  assert.deepEqual(capabilities[0], {
    version: 1,
    questionKinds: ["single_select"],
    allowFreeform: true,
    drafts: false,
    maxQuestions: 1,
    maxOptions: 9,
  });

  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 1000, prefix: "Agent: ", suffix: " please" }, null, null, h.ctx);
  await Promise.resolve();
  assert.ok(h.widgets.has("agent-utils-choice"));
  assert.match(spoken[0], /^Agent: Pick please Option 1: Alpha/, "interactive choice affixes wrap only the initial question");
  h.input("j");
  await Promise.resolve();
  assert.match(String(h.widgets.get("agent-utils-choice")?.[2]), /▶ 2\. Beta/);
  assert.ok(spoken.some((text) => text === "Beta"), "navigation speaks the new headline");

  // A device adapter emits the same semantic event as the keyboard.
  const started = sessions.find((event) => event.status === "started");
  const sessionId = started.sessionId;
  assert.equal(started.requestId, sessionId);
  assert.deepEqual(started.choices.map((choice) => choice.id), ["option-1", "option-2", "option-3"]);
  h.events.emit(CHOICE_INPUT_EVENT, { action: CHOICE_INPUT_ACTIONS.CHOOSE_ID, choiceId: "option-3", source: "test-adapter", commandId: "remote-command-1", sessionId });
  const result = await pending;
  assert.equal(result.details.status, "selected");
  assert.equal(result.details.choice.label, "gamma");
  assert.equal(result.details.source, "test-adapter");
  assert.equal(result.details.commandId, "remote-command-1");
  assert.equal(h.widgets.has("agent-utils-choice"), false);
  assert.equal(sessions.at(-1).status, "ended");
  assert.equal(sessions.at(-1).result.commandId, "remote-command-1");
});

test("appended controls keep ordinary indices stable, remain visible, and honor tts:false", async () => {
  const provided = choices.slice(0, 2).map((choice) => ({ ...choice }));
  const before = structuredClone(provided);
  const spoken = [];
  const h = harness();
  createChoiceExtension({
    speaker: { speak: async (text) => { spoken.push(text); }, interrupt() {}, dispose() {} },
    persistedSettings: {
      choice: { append: [{ title: "Generate more", description: "Try another set", tts: false, cacophonyAction: "freeformReply" }] },
      tts: {},
    },
  })(h.pi);
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: provided, timeoutMs: 1000 }, null, null, h.ctx);
  await Promise.resolve();
  assert.deepEqual(provided, before, "agent-provided choice array is never mutated");
  assert.match(h.widgets.get("agent-utils-choice").join("\n"), /3\. Generate more — Try another set/);
  assert.match(spoken[0], /Option 1: Alpha/);
  assert.match(spoken[0], /Option 2: Beta/);
  assert.doesNotMatch(spoken[0], /Generate more|Try another set/);
  h.input("j");
  h.input("j");
  await Promise.resolve();
  assert.equal(spoken.some((text) => /Generate more/.test(text)), false, "tts:false suppresses navigation speech too");
  h.input("3");
  await Promise.resolve();
  assert.match(h.widgets.get("agent-utils-choice").join("\n"), /text reply/);
  h.input("new options please");
  h.input("\u007f");
  h.input("e");
  h.input("\r");
  const result = await pending;
  assert.equal(result.details.status, "freeform");
  assert.equal(result.details.text, "new options please");
  assert.equal(result.details.source, "keyboard");
  assert.equal(result.terminate, false);
});

test("Escape from an appended freeform action re-arms the original choice list", async () => {
  const h = harness();
  createChoiceExtension({
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    persistedSettings: { choice: { append: [{ title: "More", tts: false, cacophonyAction: "freeformReply" }] }, tts: {} },
  })(h.pi);
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2), timeoutMs: 1000 }, null, null, h.ctx);
  await Promise.resolve();
  h.input("3");
  h.input("\u001b");
  h.input("1");
  const result = await pending;
  assert.equal(result.details.status, "selected");
  assert.equal(result.details.choice.label, "alpha");
});

test("text freeform Escape returns to the choice without leaking or resolving", async () => {
  const h = harness();
  createChoiceExtension({ speaker: { speak: async () => {}, interrupt() {}, dispose() {} } })(h.pi);
  let settled = false;
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2), timeoutMs: 1000 }, null, null, h.ctx);
  pending.then(() => { settled = true; });
  await Promise.resolve();
  h.input("i");
  h.input("draft");
  h.input("\u001b");
  await Promise.resolve();
  assert.equal(settled, false);
  assert.match(h.widgets.get("agent-utils-choice").join("\n"), /1\. Alpha/);
  h.input("2");
  const result = await pending;
  assert.equal(result.details.choice.label, "beta");
});

test("freeform entry pauses timeout and repeat timers, then resumes them on cancel", async () => {
  const jobs = [];
  const setTimer = (fn, ms) => { const job = { fn, ms, cancelled: false }; jobs.push(job); return job; };
  const clearTimer = (job) => { if (job) job.cancelled = true; };
  const h = harness();
  createChoiceExtension({
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    persistedSettings: { choice: { repeat: { interval: 10, limit: 1 } }, tts: {} },
    setTimer,
    clearTimer,
  })(h.pi);
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2), timeoutMs: 1000 }, null, null, h.ctx);
  await Promise.resolve();
  assert.equal(jobs.filter((job) => !job.cancelled).length, 2, "timeout and repeat begin active");
  h.input("i");
  assert.equal(jobs.filter((job) => !job.cancelled).length, 0, "both timers pause while typing");
  h.input("\u001b");
  assert.equal(jobs.filter((job) => !job.cancelled).length, 2, "timeout and repeat resume on return to choices");
  h.input("1");
  await pending;
});

test("choice PTT emits generic start/commit/cancel actions and accepts successful transcription", async () => {
  const h = harness();
  const inputs = [];
  h.events.on(CHOICE_INPUT_EVENT, (input) => inputs.push(input));
  createChoiceExtension({ speaker: { speak: async () => {}, interrupt() {}, dispose() {} } })(h.pi);
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2), timeoutMs: 1000 }, null, null, h.ctx);
  await Promise.resolve();
  h.input(" ");
  await Promise.resolve();
  assert.equal(inputs.at(-1).action, CHOICE_INPUT_ACTIONS.FREEFORM_ENTER);
  assert.equal(inputs.at(-1).mode, "ptt");
  h.input("\u001b[13;1u");
  assert.equal(inputs.at(-1).action, CHOICE_INPUT_ACTIONS.FREEFORM_PTT_COMMIT);
  h.events.emit(CHOICE_INPUT_EVENT, { action: CHOICE_INPUT_ACTIONS.FREEFORM_SUBMIT, text: "spoken reply", source: "ptt", sessionId: inputs[0].sessionId });
  const result = await pending;
  assert.equal(result.details.status, "freeform");
  assert.equal(result.details.text, "spoken reply");
  assert.equal(result.details.source, "ptt");
});

test("terminal appended discard ends once without returning an ordinary selection", async () => {
  const h = harness();
  createChoiceExtension({
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    persistedSettings: {
      choice: {
        forceAtAgentEnd: true,
        append: [{ title: "Stop Choices", description: "Stop here", terminal: true, tts: false, cacophonyAction: "discard" }],
      },
      tts: {},
    },
  })(h.pi);
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2), timeoutMs: 1000 }, null, null, h.ctx);
  await Promise.resolve();
  h.input("3");
  const result = await pending;
  assert.equal(result.details.status, "cancelled");
  assert.equal(result.details.reason, "appended-terminal");
  assert.equal(result.details.action, "discard");
  assert.equal(result.details.terminal, true);
  assert.equal(result.terminate, true);
  h.handlers.get("agent_end")({}, h.ctx);
  assert.equal(h.sentMessages.length, 0, "terminal discard disables runtime force mode and does not restart the flow");
});

test("Cacophony selection of an appended action uses the same single local outcome", async () => {
  const h = harness();
  const settled = [];
  let resolveExternal;
  const bridge = {
    config: { enabled: true },
    start({ choices: mirrored, onResolution }) {
      assert.equal(mirrored[2].cacophonyAction, "freeformReply");
      resolveExternal = onResolution;
      return { settleLocal(result) { settled.push(result); } };
    },
  };
  createChoiceExtension({
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    cacophonyBridge: bridge,
    persistedSettings: { choice: { append: [{ title: "More", tts: false, cacophonyAction: "freeformReply" }] }, tts: {} },
  })(h.pi);
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2), timeoutMs: 1000 }, null, null, h.ctx);
  await Promise.resolve();
  resolveExternal({ status: "selected", index: 2, source: "cacophony" });
  resolveExternal({ status: "freeform", text: "mobile reply", source: "cacophony" });
  resolveExternal({ status: "freeform", text: "duplicate", source: "cacophony" });
  const result = await pending;
  assert.equal(result.details.status, "freeform");
  assert.equal(result.details.text, "mobile reply");
  assert.equal(result.details.source, "cacophony");
  assert.equal(settled.length, 1, "duplicate external resolution settles the local choice exactly once");
});

test("choice navigation speaks descriptions by default and can preserve headline-only behavior", async () => {
  const describedChoices = [
    { label: "alpha", headline: "Alpha", summary: "first description" },
    { label: "beta", headline: "Beta", summary: "second description" },
  ];
  const navigate = async (persistedChoice) => {
    const spoken = [];
    const h = harness();
    createChoiceExtension({
      speaker: { speak: async (text) => { spoken.push(text); }, interrupt() {}, dispose() {} },
      persistedSettings: { choice: persistedChoice, tts: {} },
    })(h.pi);
    const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: describedChoices, timeoutMs: 1000 }, null, null, h.ctx);
    await Promise.resolve();
    h.input("j");
    await Promise.resolve();
    h.input("2");
    await pending;
    return spoken;
  };
  const enabled = await navigate({});
  assert.equal(enabled.at(-1), "Beta. second description", "default announces headline plus description");
  const disabled = await navigate({ descriptionOnNavigate: false });
  assert.equal(disabled.at(-1), "Beta", "disabled setting exactly preserves prior headline-only navigation");
});

test("pending choices repeat at the configured interval with finite and unlimited limits", async () => {
  const exercise = async (repeat, repeatRuns) => {
    const jobs = [];
    const setTimer = (fn, ms) => { const job = { fn, ms, cancelled: false }; jobs.push(job); return job; };
    const clearTimer = (job) => { if (job) job.cancelled = true; };
    const runNext = () => {
      const job = jobs.shift();
      assert.ok(job && !job.cancelled, "a live repeat timer is queued");
      job.fn();
      return job.ms;
    };
    const spoken = [];
    const h = harness();
    createChoiceExtension({
      speaker: { speak: async (text) => { spoken.push(text); }, interrupt() {}, dispose() {} },
      persistedSettings: { choice: { timeoutMs: 0, repeat }, tts: {} },
      setTimer,
      clearTimer,
    })(h.pi);
    const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2), timeoutMs: 0 }, null, null, h.ctx);
    await Promise.resolve();
    assert.equal(spoken.length, 1, "initial announcement is not counted as a repeat");
    const delays = [];
    for (let i = 0; i < repeatRuns; i += 1) {
      delays.push(runNext());
      await Promise.resolve();
    }
    return { h, pending, jobs, spoken, delays };
  };

  const finite = await exercise({ interval: 2.5, limit: 2 }, 2);
  assert.deepEqual(finite.delays, [2500, 2500]);
  assert.equal(finite.spoken.length, 3, "initial plus exactly two repeats");
  assert.equal(finite.jobs.length, 0, "finite limit schedules no extra repeat");
  finite.h.input("1");
  await finite.pending;

  const unlimited = await exercise({ interval: 1, limit: null }, 3);
  assert.equal(unlimited.spoken.length, 4, "null limit remains unbounded");
  assert.equal(unlimited.jobs.length, 1, "unlimited mode keeps the next repeat scheduled");
  unlimited.h.input("1");
  await unlimited.pending;
  assert.equal(unlimited.jobs[0].cancelled, true, "selection clears the pending repeat timer");
});

test("TUI custom choice owns focus, swallows ordinary keys, captures arrows, and renders colored selection", async () => {
  const h = harness();
  let component;
  let renders = 0;
  h.ctx.mode = "tui";
  h.ctx.ui.custom = (factory) => new Promise((resolve) => {
    const tui = { requestRender() { renders += 1; } };
    const theme = { fg: (name, text) => `<${name}>${text}</${name}>`, bold: (text) => `<b>${text}</b>` };
    component = factory(tui, theme, null, resolve);
  });
  createChoiceExtension({ speaker: { speak: async () => {}, interrupt() {}, dispose() {} }, persistedSettings: { choice: {}, tts: {} } })(h.pi);
  h.editor.value = "editor must stay untouched";
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 1000 }, null, null, h.ctx);
  await Promise.resolve();
  const first = component.render(80).join("\n");
  assert.match(first, /<accent>.*1\./, "selected number is colored");
  assert.match(first, /<accent>.*Alpha/, "selected headline is colored");
  component.handleInput("x");
  assert.equal(h.editor.value, "editor must stay untouched", "ordinary keys never leak into editor while modal is open");
  component.handleInput("\u001b[B");
  assert.ok(renders > 0, "arrow navigation requests modal redraw");
  assert.match(component.render(80).join("\n"), /<accent>.*2\./);
  component.handleInput("\u001b[13;1u");
  const result = await pending;
  assert.equal(result.details.choice.label, "beta", "raw Kitty Enter selects the highlighted modal row");
});

test("TUI freeform field owns focus, renders typed text, and submits without touching the editor", async () => {
  const h = harness();
  let component;
  h.ctx.mode = "tui";
  h.ctx.ui.custom = (factory) => new Promise((resolve) => {
    component = factory({ requestRender() {} }, { fg: (_name, text) => text, bold: (text) => text }, null, resolve);
  });
  createChoiceExtension({ speaker: { speak: async () => {}, interrupt() {}, dispose() {} } })(h.pi);
  h.editor.value = "main editor draft";
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2), timeoutMs: 1000 }, null, null, h.ctx);
  await Promise.resolve();
  component.handleInput("i");
  component.handleInput("typed reply");
  assert.match(component.render(80).join("\n"), /Reply: typed reply/);
  assert.equal(h.editor.value, "main editor draft");
  component.handleInput("\u001b[13;1u");
  const result = await pending;
  assert.equal(result.details.status, "freeform");
  assert.equal(result.details.text, "typed reply");
  assert.equal(h.editor.value, "main editor draft");
});

test("Escape dismisses the choice, preserves editor text, and waits for the next freeform submission", async () => {
  const h = harness();
  const speaker = { speak: async () => {}, interrupt() {}, dispose() {} };
  createChoiceExtension({ speaker, persistedSettings: { choice: { forceAtAgentEnd: false }, tts: {} } })(h.pi);
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

test("RPC choice uses typed select and resolves the exact response once", async () => {
  const h = harness();
  h.ctx.mode = "rpc";
  const calls = [];
  h.ctx.ui.select = async (title, options, config) => {
    calls.push({ title, options, config });
    return options[1];
  };
  createChoiceExtension({ speaker: { speak: async () => {}, interrupt() {}, dispose() {} }, persistedSettings: { choice: {}, tts: {} } })(h.pi);
  const result = await h.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 1000 }, null, null, h.ctx);
  assert.equal(result.details.status, "selected");
  assert.equal(result.details.choice.label, "beta");
  assert.equal(result.details.source, "rpc");
  assert.equal(calls.length, 1);
  assert.match(calls[0].options[1], /^2\. Beta/);
  assert.ok(calls[0].config.signal instanceof AbortSignal);
  assert.equal(h.widgets.size, 0, "RPC never installs a terminal-only widget");
});

test("RPC typed cancellation, timeout, external resolution, and missing surface settle promptly", async () => {
  const cancel = harness();
  cancel.ctx.mode = "rpc";
  cancel.ctx.ui.select = async () => undefined;
  createChoiceExtension({ speaker: { speak: async () => {}, interrupt() {}, dispose() {} } })(cancel.pi);
  const cancelled = await cancel.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 1000 }, null, null, cancel.ctx);
  assert.equal(cancelled.details.reason, "rpc-cancelled");

  const missing = harness();
  missing.ctx.mode = "rpc";
  createChoiceExtension({ speaker: { speak: async () => {}, interrupt() {}, dispose() {} } })(missing.pi);
  const failed = await missing.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 1000 }, null, null, missing.ctx);
  assert.equal(failed.details.status, "error");
  assert.match(failed.details.error, /typed ctx\.ui\.select/);

  const jobs = [];
  const timeout = harness();
  timeout.ctx.mode = "rpc";
  timeout.ctx.ui.select = (_title, _options, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
  createChoiceExtension({
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    persistedSettings: { choice: { timeoutMs: 20 }, tts: {} },
    setTimer(fn, ms) { const job = { fn, ms }; jobs.push(job); return job; },
    clearTimer() {},
  })(timeout.pi);
  const pending = timeout.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 20 }, null, null, timeout.ctx);
  await Promise.resolve();
  jobs.find((job) => job.ms === 20).fn();
  const timed = await pending;
  assert.equal(timed.details.status, "timeout");

  let externalResolve;
  let lateSelect;
  const external = harness();
  external.ctx.mode = "rpc";
  external.ctx.ui.select = () => new Promise((resolve) => { lateSelect = resolve; });
  createChoiceExtension({
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    cacophonyBridge: { config: { enabled: true }, start({ onResolution }) { externalResolve = onResolution; return { settleLocal() {} }; } },
  })(external.pi);
  const externalPending = external.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 1000 }, null, null, external.ctx);
  await Promise.resolve();
  externalResolve({ status: "selected", index: 2, source: "cacophony" });
  const externalResult = await externalPending;
  assert.equal(externalResult.details.choice.label, "gamma");
  lateSelect("1. Alpha");
  await Promise.resolve();
  assert.equal(externalResult.details.choice.label, "gamma", "late RPC response cannot settle twice");
});

test("choice timeout resolves without inventing a selection", async () => {
  const h = harness();
  createChoiceExtension({ speaker: { speak: async () => {}, dispose() {} }, persistedSettings: { choice: { timeoutMs: 30000 }, tts: {} } })(h.pi);
  const result = await h.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 5 }, null, null, h.ctx);
  assert.equal(result.details.status, "timeout");
  assert.equal(h.widgets.has("agent-utils-choice"), false);
});

test("persisted timeoutMs=0 is a hard no-timeout policy even if the model passes 30000", async () => {
  const h = harness();
  createChoiceExtension({ speaker: { speak: async () => {}, interrupt() {}, dispose() {} }, persistedSettings: { choice: { timeoutMs: 0 }, tts: {} } })(h.pi);
  let settled = false;
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2), timeoutMs: 30000 }, null, null, h.ctx);
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

test("choice settings are runtime-only, expand env affixes, and leave startup settings immutable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "choice-affixes-"));
  const settingsPath = join(dir, "settings.json");
  const startup = JSON.stringify({ agentUtils: { choice: { descriptionOnNavigate: true, prefix: "", suffix: "", repeat: { interval: 300, limit: null } } }, unrelated: 7 }, null, 2) + "\n";
  writeFileSync(settingsPath, startup);
  try {
    const spoken = [];
    const h = harness();
    createChoiceExtension({
      speaker: { speak: async (text) => { spoken.push(text); }, interrupt() {}, dispose() {} },
      env: { AGENT_ID: "agent-9: " },
      settingsPath,
      persistedSettings: { choice: {}, tts: {} },
    })(h.pi);
    await h.commands.get("choice").handler("settings descriptions=false prefix='$AGENT_ID' suffix=' now' repeat.interval=1.5 repeat.limit=2", h.ctx);
    assert.equal(readFileSync(settingsPath, "utf8"), startup, "runtime choice settings never rewrite startup policy");
    const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices: choices.slice(0, 2), timeoutMs: 1000 }, null, null, h.ctx);
    await Promise.resolve();
    assert.match(spoken[0], /^agent-9: Pick now Option 1: Alpha/);
    h.input("j");
    await Promise.resolve();
    assert.equal(spoken.at(-1), "Beta", "navigation option speech has no prompt prefix/suffix");
    h.input("2");
    await pending;
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test("force-choice stands down when no controller UI is attached", async () => {
  const h = harness();
  h.ctx.mode = "tui";
  h.ctx.ui.custom = () => Promise.reject(new Error("interactive extension UI requires an attached controller client"));
  createChoiceExtension({
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    persistedSettings: { choice: { forceAtAgentEnd: true }, tts: {} },
  })(h.pi);

  h.handlers.get("agent_end")({}, h.ctx);
  assert.equal(h.sentMessages.length, 1);
  const result = await h.tools.get("interactive_choice").execute(
    "forced",
    { question: "Next?", choices: choices.slice(0, 2), timeoutMs: 0 },
    null,
    null,
    h.ctx,
  );
  assert.equal(result.details.status, "error");
  assert.match(result.details.error, /attached controller client/);
  h.handlers.get("agent_end")({}, h.ctx);
  h.handlers.get("agent_end")({}, h.ctx);
  assert.equal(h.sentMessages.length, 1, "unavailable forced UI disables the session loop");
  assert.equal(h.notifications.filter(({ message }) => /force-choice disabled/.test(message)).length, 1);

  await h.commands.get("force-choice").handler("on", h.ctx);
  h.handlers.get("agent_end")({}, h.ctx);
  assert.equal(h.sentMessages.length, 2, "explicit runtime re-arm remains available");
});

test("unavailable forced-choice history detection uses only the newest forced result", () => {
  const forced = (id) => ({ type: "custom_message", id, customType: FORCE_CHOICE_CUSTOM_TYPE, content: "force" });
  const result = (id, error) => ({
    type: "message",
    id,
    message: {
      role: "toolResult",
      toolName: "interactive_choice",
      content: [{ type: "text", text: error ? `choice failed: ${error}` : "selected 1: continue" }],
      details: error ? { status: "error", code: "extension_ui_unavailable", error } : { status: "selected" },
    },
  });

  assert.equal(hasUnavailableForcedChoiceTail([]), false);
  assert.equal(hasUnavailableForcedChoiceTail([forced("a")]), false, "request without a result is not classified");
  assert.equal(
    hasUnavailableForcedChoiceTail([forced("a"), result("b", "interactive extension UI requires an attached controller client")]),
    true,
  );
  assert.equal(
    hasUnavailableForcedChoiceTail([
      forced("old"),
      result("old-result", "no controller client is attached"),
      forced("new"),
      result("new-result", null),
    ]),
    false,
    "a newer successful forced choice supersedes an old unavailable result",
  );
});

test("session reload recovers a stale headless force-choice tail without another paid turn", async () => {
  const h = harness();
  h.ctx.sessionManager = {
    getBranch: () => [
      { type: "custom_message", id: "forced", customType: FORCE_CHOICE_CUSTOM_TYPE, content: "force" },
      {
        type: "message",
        id: "failed",
        message: {
          role: "toolResult",
          toolName: "interactive_choice",
          content: [{ type: "text", text: "choice failed: interactive extension UI requires an attached controller client" }],
          details: { status: "error", code: "extension_ui_unavailable" },
        },
      },
    ],
  };
  createChoiceExtension({
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    persistedSettings: { choice: { forceAtAgentEnd: true }, tts: {} },
  })(h.pi);

  h.handlers.get("session_start")({}, h.ctx);
  h.handlers.get("agent_end")({}, h.ctx);
  h.handlers.get("agent_end")({}, h.ctx);
  assert.equal(h.sentMessages.length, 0, "reload recovery injects no second force turn");
  assert.equal(h.notifications.filter(({ message }) => /recovered a prior no-controller/.test(message)).length, 1);

  await h.commands.get("force-choice").handler("on", h.ctx);
  h.handlers.get("agent_end")({}, h.ctx);
  assert.equal(h.sentMessages.length, 1, "explicit runtime re-arm remains possible after recovery");
});

test("discarded durable forced choice stands down instead of reinjecting", async () => {
  const h = harness();
  let resolveExternal;
  createChoiceExtension({
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    cacophonyBridge: {
      start({ onResolution }) {
        resolveExternal = onResolution;
        return { settleLocal: async () => {} };
      },
    },
    persistedSettings: { choice: { forceAtAgentEnd: true }, tts: {} },
  })(h.pi);

  h.handlers.get("agent_end")({}, h.ctx);
  const pending = h.tools.get("interactive_choice").execute(
    "forced",
    { question: "Next?", choices: choices.slice(0, 2), timeoutMs: 0 },
    null,
    null,
    h.ctx,
  );
  await Promise.resolve();
  resolveExternal({ status: "cancelled", reason: "discarded" });
  const result = await pending;
  assert.equal(result.details.status, "cancelled");
  assert.equal(result.details.reason, "discarded");
  h.handlers.get("agent_end")({}, h.ctx);
  assert.equal(h.sentMessages.length, 1, "durable discard disables force mode for this session");
});

test("q in the true TUI modal hard-stops force-choice and terminates the follow-up", async () => {
  const h = harness();
  let component;
  h.ctx.mode = "tui";
  h.ctx.ui.custom = (factory) => new Promise((resolve) => {
    component = factory({ requestRender() {} }, { fg: (_name, text) => text, bold: (text) => text }, null, resolve);
  });
  createChoiceExtension({
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    persistedSettings: { choice: { forceAtAgentEnd: true }, tts: {} },
  })(h.pi);
  const pending = h.tools.get("interactive_choice").execute("id", { question: "Next?", choices: choices.slice(0, 2), timeoutMs: 0 }, null, null, h.ctx);
  await Promise.resolve();
  component.handleInput("q");
  const result = await pending;
  assert.equal(result.details.reason, "quit-stop");
  assert.equal(result.terminate, true);
  h.handlers.get("agent_end")({}, h.ctx);
  assert.equal(h.sentMessages.length, 0, "q leaves runtime force mode off so the agent may stop");
});

test("force-choice runtime controls and Escape preserve startup policy while letting the agent stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "force-choice-escape-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentUtils: { choice: { forceAtAgentEnd: true } } }, null, 2));
  try {
    const h = harness();
    createChoiceExtension({
      speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
      settingsPath,
      persistedSettings: { choice: { forceAtAgentEnd: true }, tts: {} },
    })(h.pi);
    await h.commands.get("force-choice").handler("off", h.ctx);
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).agentUtils.choice.forceAtAgentEnd, true, "runtime command does not rewrite startup policy");
    await h.commands.get("force-choice").handler("on", h.ctx);
    await h.commands.get("choice").handler("settings force=false", h.ctx);
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).agentUtils.choice.forceAtAgentEnd, true, "choice settings force toggle is runtime-only");
    await h.commands.get("choice").handler("settings force=true", h.ctx);

    const stopPending = h.tools.get("interactive_choice").execute("stop", { question: "Next?", choices: [{ label: "Stop continuous choices" }, { label: "Continue" }], timeoutMs: 0 }, null, null, h.ctx);
    await Promise.resolve();
    h.input("1");
    assert.match(h.widgets.get("agent-utils-choice").join("\n"), /Stop continuous choices\?/);
    h.events.emit(CHOICE_INPUT_EVENT, { action: CHOICE_INPUT_ACTIONS.CHOOSE_INDEX, index: 1, source: "omni" });
    assert.match(h.widgets.get("agent-utils-choice").join("\n"), /Next\?/);
    h.input("1");
    h.events.emit(CHOICE_INPUT_EVENT, { action: CHOICE_INPUT_ACTIONS.CHOOSE_INDEX, index: 0, source: "omni" });
    const stopResult = await stopPending;
    assert.equal(stopResult.details.choice.label, "Stop continuous choices", "confirmation returns the original stop choice");
    assert.equal(stopResult.details.source, "omni", "confirmation accepts semantic Omni input");
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).agentUtils.choice.forceAtAgentEnd, true, "Stop selection does not rewrite startup policy");
    h.handlers.get("agent_end")({}, h.ctx);
    assert.equal(h.sentMessages.length, 0, "Stop selection disables force mode for this session");

    await h.commands.get("force-choice").handler("on", h.ctx);
    const pending = h.tools.get("interactive_choice").execute("id", { question: "Next?", choices: choices.slice(0, 2), timeoutMs: 0 }, null, null, h.ctx);
    await Promise.resolve();
    h.input("\u001b");
    const result = await pending;
    assert.equal(result.details.reason, "escape-stop");
    assert.equal(result.terminate, true, "Escape marks the forced choice as a terminating final tool result");
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).agentUtils.choice.forceAtAgentEnd, true, "Escape preserves startup policy");
    h.handlers.get("agent_end")({}, h.ctx);
    assert.equal(h.sentMessages.length, 0, "force-choice remains off for this session so agent_end may stop");
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
