import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { createChoiceExtension, resolveChoiceSettings } from "../extensions/choice.js";
import { persistChoiceSetting } from "../extensions/lib/tts-settings.js";

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

test("choice extension resolves keyboard and external event inputs through one bus", async () => {
  const spoken = [];
  const speaker = { speak: async (text) => { spoken.push(text); }, dispose() {} };
  const h = harness();
  createChoiceExtension({ speaker })(h.pi);
  const sessions = [];
  h.events.on(CHOICE_SESSION_EVENT, (event) => sessions.push(event));

  const pending = h.tools.get("interactive_choice").execute("id", { question: "Pick", choices, timeoutMs: 1000, prefix: "Agent: ", suffix: " please" }, null, null, h.ctx);
  await Promise.resolve();
  assert.ok(h.widgets.has("agent-utils-choice"));
  assert.match(spoken[0], /^Agent: Pick please Option 1: Alpha/, "interactive choice affixes wrap only the initial question");
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
  component.handleInput("2");
  const result = await pending;
  assert.equal(result.details.choice.label, "beta");
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

test("choice settings expand env affixes, persist literals, and leave option speech unmodified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "choice-affixes-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentUtils: { choice: {} } }, null, 2));
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
    const saved = JSON.parse(readFileSync(settingsPath, "utf8")).agentUtils.choice;
    assert.equal(saved.prefix, undefined, "env-derived prefix is runtime-only");
    assert.equal(saved.suffix, " now");
    assert.equal(saved.descriptionOnNavigate, false);
    assert.deepEqual(saved.repeat, { interval: 1.5, limit: 2 });
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
    assert.equal(persistChoiceSetting("forceAtAgentEnd", false, settingsPath), false, "startup-only field is rejected by the persistence helper");
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
    await stopPending;
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
