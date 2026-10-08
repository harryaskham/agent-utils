import test from "node:test";
import assert from "node:assert/strict";

import { createChoiceExtension } from "../extensions/choice.js";
import {
  ASYNC_CHOICE_ENTRY_TYPE,
  ASYNC_CHOICE_MESSAGE_TYPE,
  ASYNC_CHOICE_VIEW_SESSION,
  asyncChoiceQuestions,
  formatAsyncDelivery,
  renderAsyncChoicesView,
} from "../extensions/lib/async-choice.js";
import { createCacophonyDecisionBridge, decisionContext, decisionOutcome } from "../extensions/lib/cacophony-decision.js";
import { ChoiceStateMachine, CHOICE_SESSION_EVENT, INPUT_ACTION_EVENT, INPUT_ACTIONS, normalizeChoices } from "../extensions/lib/choice.js";
import { ChoiceView, choiceTextWidth } from "../extensions/lib/choice-layout.js";

process.env.PI_CHOICE_CACO_ENABLED = "0";

const theme = { fg: (_role, text) => text, bold: (text) => text };
const speakerStub = () => ({ spoken: [], speak(text) { this.spoken.push(text); return Promise.resolve(); }, interrupt() {}, dispose() {}, beginChoice() {}, endChoice() {} });

function bus() {
  const handlers = new Map();
  const emitted = [];
  return {
    emitted,
    on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
    off(name, fn) { handlers.set(name, (handlers.get(name) || []).filter((value) => value !== fn)); },
    emit(name, value) { emitted.push({ name, value }); for (const fn of [...(handlers.get(name) || [])]) fn(value); },
  };
}

function fakeBridge() {
  const calls = { registrations: [], requested: [], updated: [], resolved: [], disposed: 0 };
  let provider;
  return {
    version: 1,
    enabled: true,
    calls,
    registerInputProvider(value) {
      provider = value;
      calls.registrations.push(value);
      return {
        requested: (request) => calls.requested.push(request),
        updated: (request) => calls.updated.push(request),
        resolved: (result) => calls.resolved.push(result),
        dispose: () => { calls.disposed += 1; },
      };
    },
    get provider() { return provider; },
  };
}

function harness({ settings = {}, ahpBridge = false, decisionBridge = false, entries = [], mode = "tui" } = {}) {
  const commands = new Map();
  const shortcuts = new Map();
  const tools = new Map();
  const handlers = new Map();
  const events = bus();
  const widgets = new Map();
  const statuses = new Map();
  const notifications = [];
  const sent = [];
  const appended = [];
  let activeTools = ["read", "bash"];
  const ui = { component: null, closed: [], renders: 0 };
  const ctx = {
    mode,
    ui: {
      setWidget(name, value) { if (value === undefined) widgets.delete(name); else widgets.set(name, value); },
      setStatus(name, value) { if (value === undefined) statuses.delete(name); else statuses.set(name, value); },
      notify(message, level = "info") { notifications.push({ message, level }); },
      onTerminalInput() { return () => {}; },
      custom(factory) {
        return new Promise((resolve) => {
          const tui = { terminal: { columns: 120, rows: 30, write() {} }, requestRender() { ui.renders += 1; }, mode: "fullscreen" };
          ui.component = factory(tui, theme, {}, (value) => { ui.closed.push(value); ui.component = null; resolve(value); });
        });
      },
    },
    sessionManager: { getBranch: () => entries },
  };
  const pi = {
    events,
    registerCommand(name, def) { commands.set(name, def); },
    registerShortcut(key, def) { shortcuts.set(key, def); },
    registerTool(def) { tools.set(def.name, def); activeTools.push(def.name); },
    getActiveTools: () => [...activeTools],
    setActiveTools(names) { activeTools = [...names]; },
    registerMessageRenderer() {},
    sendMessage(message, options) { sent.push({ message, options }); },
    appendEntry(customType, data) { appended.push({ type: "custom", customType, data }); },
    on(name, fn) { handlers.set(name, fn); },
  };
  const speaker = speakerStub();
  createChoiceExtension({
    speaker,
    ahpBridge,
    decisionBridge,
    cacophonyBridge: false,
    preferenceStore: { load: async () => ({}), save: async () => {} },
    env: { PI_CHOICE_SPEECH_ENABLED: "0" },
    persistedSettings: { choice: { timeoutMs: 0, ...settings, async: { deliverDebounceMs: 0, ...(settings.async || {}) } }, tts: {} },
  })(pi);
  handlers.get("session_start")?.({}, ctx);
  const key = (data) => ui.component?.handleInput(data);
  const post = (params) => tools.get("async_choice").execute("call", params, null, null, ctx);
  return { pi, ctx, ui, key, post, tools, commands, shortcuts, handlers, events, widgets, statuses, notifications, sent, appended, speaker, get activeTools() { return activeTools; } };
}

const choices = [{ label: "Alpha" }, { label: "Beta", summary: "second" }, { label: "Gamma" }];

test("async_choice posts many questions without blocking and shows a waiting indicator", async () => {
  const h = harness();
  assert.ok(h.activeTools.includes("async_choice"));
  assert.ok(h.activeTools.includes("async_choice_status"));
  assert.ok(h.shortcuts.has("ctrl+alt+q"));
  const result = await h.post({ questions: [
    { question: "Which database?", choices, key: "db" },
    { question: "Which region?", choices: [{ label: "West" }, { label: "East" }], key: "region" },
  ] });
  assert.equal(result.details.status, "posted");
  assert.equal(result.details.ids.length, 2);
  assert.equal(result.details.pendingCount, 2);
  assert.match(result.content[0].text, /Posted 2 async questions/);
  const widget = h.widgets.get("agent-utils-async-choices");
  assert.equal(typeof widget, "function");
  assert.match(widget(null, theme).render(120)[0], /2 questions waiting/);
  assert.match(h.notifications.at(-1).message, /Agent asked 2 questions/);
  assert.equal(h.appended.filter((entry) => entry.data.type === "posted").length, 2);
  assert.equal(h.sent.length, 0, "posting never injects a message");
});

test("choices view answers questions in place, auto-advances, and steers each answer to the agent", async () => {
  const h = harness();
  const { details } = await h.post({ questions: [
    { question: "Which database?", choices, key: "db" },
    { question: "Which region?", choices: [{ label: "West" }, { label: "East" }] },
  ] });
  await h.shortcuts.get("ctrl+alt+q").handler(h.ctx);
  assert.ok(h.ui.component, "view opened");
  assert.equal(h.widgets.has("agent-utils-async-choices"), false, "indicator hidden while answering");
  const started = h.events.emitted.find((event) => event.name === CHOICE_SESSION_EVENT && event.value.status === "started");
  assert.equal(started.value.sessionId, ASYNC_CHOICE_VIEW_SESSION);
  const lines = h.ui.component.render(120);
  assert.ok(lines.some((line) => line.includes("Questions · 2")));
  assert.ok(lines.some((line) => line.includes("Which database?")));
  for (const line of lines) assert.ok(choiceTextWidth(line) <= 120, `line fits: ${line}`);

  h.key("2");
  assert.equal(h.sent.length, 1);
  const [{ message, options }] = h.sent;
  assert.equal(message.customType, ASYNC_CHOICE_MESSAGE_TYPE);
  assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
  assert.deepEqual(message.details.ids, [details.ids[0]]);
  assert.match(message.content, /\[key=db\] "Which database\?" → selected 2: "Beta"/);
  assert.match(message.content, /1 still pending/);
  assert.ok(h.ui.component, "view stays open on the next question");
  assert.ok(h.ui.component.render(120).some((line) => line.includes("Which region?")));

  h.key("\u001b[B");
  h.key("\r");
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].message.content, /selected 2: "East"/);
  assert.equal(h.ui.component, null, "view closes when everything is answered");
  assert.ok(h.notifications.some((note) => /All async questions answered/.test(note.message)));
  assert.equal(h.events.emitted.filter((event) => event.name === CHOICE_SESSION_EVENT).at(-1).value.status, "ended");

  const status = await h.tools.get("async_choice_status").execute("s", { ids: ["db"] }, null, null, h.ctx);
  assert.equal(status.details.questions[0].status, "answered");
  assert.equal(status.details.questions[0].answer.label, "Beta");
});

test("view supports question switching, freeform reply, two-step dismiss and Esc close without answering", async () => {
  const h = harness();
  await h.post({ questions: [
    { question: "First?", choices },
    { question: "Second?", choices },
    { question: "Third?", choices },
  ] });
  await h.commands.get("choices").handler("", h.ctx);
  h.key("\u001b[C");
  assert.ok(h.ui.component.render(120).some((line) => line.includes("▶ 2. Second?")));
  h.key("i");
  for (const ch of "use the cache") h.key(ch);
  h.key("\r");
  assert.match(h.sent.at(-1).message.content, /"Second\?" → replied in their own words: "use the cache"/);
  // Focus advanced to Third; dismiss requires confirmation.
  h.key("x");
  assert.equal(h.sent.length, 1);
  h.key("x");
  assert.equal(h.sent.length, 2);
  assert.match(h.sent.at(-1).message.content, /"Third\?" → no answer — the user dismissed it/);
  h.key("\u001b");
  assert.equal(h.ui.component, null);
  const status = await h.tools.get("async_choice_status").execute("s", { pendingOnly: true }, null, null, h.ctx);
  assert.equal(status.details.questions.length, 1, "Esc leaves the remaining question pending");
  assert.equal(status.details.questions[0].question, "First?");
});

test("mouse clicks focus sidebar questions and choose options", async () => {
  const h = harness();
  await h.post({ questions: [{ question: "First?", choices }, { question: "Second?", choices }] });
  await h.commands.get("choices").handler("", h.ctx);
  const lines = h.ui.component.render(120);
  const top = 30 - lines.length;
  const sidebarRow = lines.findIndex((line) => line.includes("2. Second?"));
  h.key(`\u001b[<0;3;${top + sidebarRow + 1}M`);
  const after = h.ui.component.render(120);
  assert.ok(after.some((line) => line.includes("▶ 2. Second?")));
  const optionRow = after.findIndex((line) => line.includes("3. Gamma"));
  const column = after[optionRow].indexOf("3. Gamma") + 2;
  h.key(`\u001b[<0;${column};${top + optionRow + 1}M`);
  assert.match(h.sent.at(-1).message.content, /"Second\?" → selected 3: "Gamma"/);
});

test("Omni/ring style semantic input drives the focused async question", async () => {
  const h = harness();
  await h.post({ question: "Ring pick?", choices });
  await h.commands.get("choices").handler("", h.ctx);
  h.events.emit(INPUT_ACTION_EVENT, { action: INPUT_ACTIONS.SELECT_NEXT, source: "ring", sessionId: ASYNC_CHOICE_VIEW_SESSION });
  h.events.emit(INPUT_ACTION_EVENT, { action: INPUT_ACTIONS.CHOOSE_CURRENT, source: "ring", sessionId: "choice-unrelated" });
  assert.equal(h.sent.length, 0, "input for other sessions is ignored");
  h.events.emit(INPUT_ACTION_EVENT, { action: INPUT_ACTIONS.CHOOSE_CURRENT, source: "ring", sessionId: ASYNC_CHOICE_VIEW_SESSION });
  assert.match(h.sent.at(-1).message.content, /selected 2: "Beta"/);
  assert.equal(h.sent.at(-1).message.details.results[0].answer.source, "ring");
});

test("agent withdrawal settles every surface without injecting an answer", async () => {
  const bridge = fakeBridge();
  const h = harness({ ahpBridge: bridge });
  const { details } = await h.post({ questions: [{ question: "Keep?", choices, key: "keep" }, { question: "Drop?", choices, key: "drop" }] });
  assert.equal(bridge.calls.requested.length, 2);
  const cancel = await h.tools.get("async_choice_cancel").execute("c", { ids: ["drop"], reason: "no longer needed" }, null, null, h.ctx);
  assert.deepEqual(cancel.details.withdrawn, [details.ids[1]]);
  assert.equal(h.sent.length, 0);
  assert.equal(bridge.calls.resolved.at(-1).requestId, details.ids[1]);
  assert.equal(bridge.calls.resolved.at(-1).resolution, "cancel");
  const status = await h.tools.get("async_choice_status").execute("s", {}, null, null, h.ctx);
  assert.deepEqual(status.details.questions.map((item) => item.status), ["pending", "withdrawn"]);
});

test("one AHP provider carries the blocking choice and many async requests with exact routing", async () => {
  const bridge = fakeBridge();
  const h = harness({ ahpBridge: bridge });
  const { details } = await h.post({ questions: [{ question: "A?", choices }, { question: "B?", choices }] });
  assert.equal(bridge.calls.registrations.length, 1);
  const snapshot = await bridge.provider.snapshot();
  assert.deepEqual(snapshot.map((request) => request.requestId), details.ids);
  const optionId = snapshot[1].questions[0].options[2].id;
  assert.deepEqual(await bridge.provider.complete({ operationId: "op", commandId: "cmd-1", requestId: details.ids[1], response: "accept", answers: { choice: { kind: "selected", value: optionId } } }), { accepted: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(h.sent.at(-1).message.content, /"B\?" → selected 3: "Gamma"/);
  assert.equal(bridge.calls.resolved.at(-1).commandId, "cmd-1");
  assert.equal(bridge.calls.resolved.at(-1).resolution, "accept");
  assert.deepEqual((await bridge.provider.snapshot()).map((request) => request.requestId), [details.ids[0]]);
  // A remote decline is the user's answer and is reported to the agent.
  await bridge.provider.complete({ operationId: "op2", commandId: "cmd-2", requestId: details.ids[0], response: "decline", answers: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(h.sent.at(-1).message.content, /declined to answer/);
  assert.equal(bridge.calls.resolved.at(-1).resolution, "decline");
});

test("a blocking interactive_choice takes over from an open async view", async () => {
  const h = harness();
  h.ctx.mode = "rpc";
  await h.post({ question: "Async?", choices });
  h.ctx.mode = "tui";
  await h.commands.get("choices").handler("", h.ctx);
  assert.ok(h.ui.component);
  const pending = h.tools.get("interactive_choice").execute("sync", { question: "Now?", choices }, null, null, { ...h.ctx, mode: "other" });
  assert.deepEqual(h.ui.closed.at(-1), "superseded");
  await h.commands.get("choices").handler("", h.ctx);
  assert.match(h.notifications.at(-1).message, /Finish the active interactive choice first/);
  await h.commands.get("choice").handler("cancel", h.ctx);
  await pending;
});

test("/choice off withdraws pending async questions, tells the agent and hides the tools", async () => {
  const h = harness();
  await h.post({ question: "Pending?", choices });
  await h.commands.get("choice").handler("off", h.ctx);
  assert.match(h.sent.at(-1).message.content, /choices were turned off/);
  assert.ok(!h.activeTools.includes("async_choice"));
  assert.ok(!h.activeTools.includes("interactive_choice"));
  await h.commands.get("choice").handler("on", h.ctx);
  assert.ok(h.activeTools.includes("async_choice"));
});

test("restore re-publishes pending questions and redelivers answers the agent never saw", () => {
  const bridge = fakeBridge();
  const attached = [];
  const decisionBridge = { attach: (value) => { attached.push(value); return { settleLocal() {} }; }, start() { throw new Error("must not refile"); }, dispose() {} };
  const posted = (id, question) => ({ type: "custom", customType: ASYNC_CHOICE_ENTRY_TYPE, data: { type: "posted", id, question, choices: normalizeChoices(choices), createdAt: Date.now(), timeoutMs: 0, deadline: null } });
  const entries = [
    posted("ac-pending", "Still waiting?"),
    { type: "custom", customType: ASYNC_CHOICE_ENTRY_TYPE, data: { type: "decision", id: "ac-pending", decisionId: "decision-1" } },
    posted("ac-unseen", "Answered offline?"),
    { type: "custom", customType: ASYNC_CHOICE_ENTRY_TYPE, data: { type: "resolved", id: "ac-unseen", result: { status: "selected", index: 0, choice: { label: "Alpha" }, source: "cacophony" }, notify: true } },
    posted("ac-seen", "Already delivered?"),
    { type: "custom", customType: ASYNC_CHOICE_ENTRY_TYPE, data: { type: "resolved", id: "ac-seen", result: { status: "freeform", text: "ok" }, notify: true } },
    { type: "custom_message", customType: ASYNC_CHOICE_MESSAGE_TYPE, details: { ids: ["ac-seen"] } },
  ];
  const h = harness({ ahpBridge: bridge, decisionBridge, entries });
  assert.deepEqual(bridge.calls.requested.map((request) => request.requestId), ["ac-pending"]);
  assert.equal(attached[0].decisionId, "decision-1");
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].message.details.ids, ["ac-unseen"]);
  assert.match(h.notifications.at(-1).message, /1 async question is still waiting/);
  // An answer arriving from Cacophony after restore flows through normally.
  attached[0].onResolution({ status: "selected", index: 2, source: "cacophony" });
  assert.match(h.sent.at(-1).message.content, /"Still waiting\?" → selected 3: "Gamma" .*via cacophony|"Still waiting\?" → selected 3: "Gamma"/);
});

test("Cacophony decision mirror files, polls, settles both ways, and degrades without discard", async () => {
  const calls = [];
  const remote = new Map();
  let discardSupported = true;
  const execFileImpl = (_command, args, _options, callback) => {
    calls.push(args);
    const [group, verb] = args;
    const value = (flag) => args[args.indexOf(flag) + 1];
    let out;
    if (group === "decision" && verb === "file") {
      const id = `decision-${remote.size + 1}`;
      remote.set(id, { id, status: "active", options: args.filter((_, i) => args[i - 1] === "--option") });
      out = { data: { decision_id: id, inserted: true } };
    } else if (verb === "list") out = { data: { decisions: [...remote.values()].filter((item) => item.status === "active") } };
    else if (verb === "show") out = { data: remote.get(value("--id")) || { found: false } };
    else if (verb === "resolve") { remote.get(value("--id")).status = "resolved"; out = { data: { resolved: true } }; }
    else if (verb === "discard") {
      if (!discardSupported) { callback(Object.assign(new Error("exit 2"), { code: 2 }), "", "error: unknown subcommand 'discard' for 'caco decision'. Allowed: file, list, resolve, show"); return; }
      remote.get(value("--id")).status = "discarded"; out = { data: { discarded: true } };
    }
    callback(null, JSON.stringify(out), "");
  };
  const timers = [];
  const bridge = createCacophonyDecisionBridge({
    env: { CACO_AGENT_ID: "agent-1", CACO_PROJECT: "proj" },
    execFileImpl,
    setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
    clearTimer() {},
  });
  assert.equal(bridge.config.enabled, true);
  const normalized = normalizeChoices([...choices, { label: "Reply", appended: true, cacophonyAction: "freeformReply" }]);
  const resolutions = [];
  const warnings = [];
  const first = bridge.start({ asyncId: "ac-1", question: "Q1?", context: "why", choices: normalized, recommendIndex: 1, onDecisionId() {}, onResolution: (value) => resolutions.push(value), onWarning: (value) => warnings.push(value) });
  const second = bridge.start({ asyncId: "ac-2", question: "Q2?", choices: normalized, onResolution: (value) => resolutions.push(value), onWarning: (value) => warnings.push(value) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fileArgs = calls.find((args) => args[1] === "file");
  assert.deepEqual(fileArgs.filter((_, i) => fileArgs[i - 1] === "--option"), ["Alpha", "Beta", "Gamma"], "appended control rows are not filed");
  assert.equal(fileArgs[fileArgs.indexOf("--recommend") + 1], "Beta");
  assert.equal(fileArgs[fileArgs.indexOf("--filer") + 1], "agent-1");
  assert.equal(fileArgs[fileArgs.indexOf("--notify-filer") + 1], "false");
  assert.match(fileArgs[fileArgs.indexOf("--context") + 1], /why[\s\S]*\[1\] Beta — second[\s\S]*ac-1/);

  // Operator answers decision-1 in Cacophony; one list + one show per tick.
  Object.assign(remote.get("decision-1"), { status: "resolved", resolution: { selected_index: 2, selected_label: "Gamma" } });
  calls.length = 0;
  await bridge.pollNow();
  assert.deepEqual(resolutions, [{ status: "selected", index: 2, label: "Gamma", source: "cacophony" }]);
  assert.deepEqual(calls.map((args) => args[1]), ["list", "show"]);

  // Local withdrawal of the second discards it remotely.
  await second.settleLocal({ status: "cancelled", reason: "withdrawn" });
  assert.equal(remote.get("decision-2").status, "discarded");
  assert.equal(bridge.pendingCount, 0);

  // Older caco: discard is unknown; warn once, never invent an answer.
  discardSupported = false;
  const third = bridge.start({ asyncId: "ac-3", question: "Q3?", choices: normalized, onResolution() {}, onWarning: (value) => warnings.push(value) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await third.settleLocal({ status: "cancelled", reason: "withdrawn" });
  assert.equal(remote.get("decision-3").status, "active");
  assert.match(warnings.at(-1), /no `decision discard`/);
  assert.equal(first.handle.stopped, true);
});

test("decision outcome mapping and pure helpers", () => {
  assert.equal(decisionOutcome({ status: "active" }, 3), null);
  assert.deepEqual(decisionOutcome({ status: "resolved", resolution: { freeform_text: " hi " } }, 3), { status: "freeform", text: "hi", source: "cacophony" });
  assert.deepEqual(decisionOutcome({ status: "discarded" }, 3), { status: "cancelled", reason: "discarded", source: "cacophony" });
  assert.equal(decisionOutcome({ status: "resolved", resolution: { selected_index: 7 } }, 3).status, "cancelled");
  assert.ok(Buffer.byteLength(decisionContext({ context: "x".repeat(10_000), choices: [], asyncId: "ac" })) <= 4096);
  assert.throws(() => asyncChoiceQuestions({}), /question\+choices/);
  assert.equal(asyncChoiceQuestions({ question: "Q", choices, key: "k" })[0].key, "k");
  assert.match(formatAsyncDelivery([{ id: "ac-1", question: "Q", result: { status: "timeout", timeoutMs: 5 } }], 0), /expired unanswered/);
});

test("composite layout collapses the sidebar into a strip on narrow terminals and stays within width", () => {
  const records = ["Alpha question that is long enough to need truncation", "Beta"].map((question, index) => ({
    id: `ac-${index}`, question, context: "", state: new ChoiceStateMachine({ choices }), freeformMode: null, freeformText: "",
  }));
  for (const width of [40, 63, 64, 80, 140]) {
    const out = renderAsyncChoicesView({ records, focusIndex: 1, view: new ChoiceView(), theme, width, height: 14 });
    assert.equal(out.layout.sidebar, width >= 64);
    assert.ok(out.lines.length <= 14);
    for (const line of out.lines) assert.ok(choiceTextWidth(line) <= width, `${width}: ${line}`);
    if (!out.layout.sidebar) assert.match(out.lines[0], /‹ 2\/2 › Beta/);
  }
});
