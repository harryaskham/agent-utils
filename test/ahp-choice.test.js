import test from "node:test";
import assert from "node:assert/strict";

import { createChoiceExtension } from "../extensions/choice.js";
import {
  AHP_AVAILABLE_EVENT,
  AHP_BRIDGE_SYMBOL,
  AHP_DISCOVERY_EVENT,
  DURABLE_QUESTION_DONE_EVENT,
  DURABLE_QUESTION_EVENT,
  durableAnswer,
  durableQuestion,
  ahpResolutionForResult,
  choiceAhpRequest,
  createAhpChoiceProvider,
  isAhpDisabled,
} from "../extensions/lib/ahp-choice.js";

function events() {
  const handlers = new Map();
  const emitted = [];
  return {
    emitted,
    on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
    off(name, fn) { handlers.set(name, (handlers.get(name) || []).filter((value) => value !== fn)); },
    emit(name, value) { emitted.push({ name, value }); for (const fn of handlers.get(name) || []) fn(value); },
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
        requested: request => calls.requested.push(request),
        updated: request => calls.updated.push(request),
        resolved: result => calls.resolved.push(result),
        dispose: () => { calls.disposed += 1; },
      };
    },
    get provider() { return provider; },
  };
}

const record = () => ({
  sessionId: "request-opaque",
  question: "Pick a region",
  deadline: Date.parse("2030-01-01T00:00:00Z"),
  finished: false,
  state: {
    index: 1,
    choices: [
      { id: "west-id", label: "West", headline: "West", summary: "Nearby" },
      { id: "east-id", label: "East", headline: "East", summary: "Recommended" },
    ],
  },
});

test("AHP request and settlement preserve opaque IDs and complete state", () => {
  const active = record();
  assert.deepEqual(choiceAhpRequest(active), {
    requestId: "request-opaque",
    message: "Pick a region",
    questions: [{
      id: "choice", kind: "single_select", prompt: "Pick a region", required: true, allowFreeform: true,
      options: [
        { id: "west-id", label: "West", description: "Nearby", recommended: false },
        { id: "east-id", label: "East", description: "Recommended", recommended: true },
      ],
    }],
    deadline: "2030-01-01T00:00:00.000Z",
  });
  assert.deepEqual(ahpResolutionForResult(active, { status: "selected", choice: active.state.choices[1], commandId: "command-opaque", source: "ahp" }), {
    requestId: "request-opaque", resolution: "accept", answers: { choice: { kind: "selected", value: "east-id" } }, commandId: "command-opaque", source: "ahp",
  });
});

test("provider feature-detects late bridge, snapshots completely, and admits before settlement", async () => {
  const piEvents = events();
  const bridge = fakeBridge();
  let active = record();
  const completions = [];
  const adapter = createAhpChoiceProvider({ pi: { events: piEvents }, env: {}, getActive: () => active, complete: value => completions.push(value), providerId: "provider-opaque" });
  assert.equal(adapter.enabled, false);
  assert.ok(piEvents.emitted.some(event => event.name === AHP_DISCOVERY_EVENT));
  piEvents.emit(AHP_AVAILABLE_EVENT, bridge);
  assert.equal(adapter.enabled, true);
  assert.equal(bridge.provider.providerId, "provider-opaque");
  assert.deepEqual(await bridge.provider.snapshot(), [choiceAhpRequest(active)]);

  const admission = await bridge.provider.complete({ operationId: "op", commandId: "cmd", requestId: active.sessionId, response: "accept", answers: { choice: { kind: "selected", value: "west-id" } } });
  assert.deepEqual(admission, { accepted: true });
  assert.equal(completions.length, 0, "admission returns before local arbitration settles");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(completions, [{ response: "accept", answer: { kind: "selected", value: "west-id" }, requestId: active.sessionId, commandId: "cmd", operationId: "op" }]);

  const freeformAdmission = await bridge.provider.complete({
    operationId: "op-freeform",
    commandId: "cmd-freeform",
    requestId: active.sessionId,
    response: "accept",
    answers: { choice: { kind: "selected", value: "freeform", freeformValues: ["custom region"] } },
  });
  assert.deepEqual(freeformAdmission, { accepted: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(completions.at(-1), {
    response: "accept",
    answer: { kind: "text", value: "custom region" },
    requestId: active.sessionId,
    commandId: "cmd-freeform",
    operationId: "op-freeform",
  });

  active = null;
  assert.deepEqual(await bridge.provider.snapshot(), [], "snapshot is a complete authoritative cut");
  adapter.dispose();
  assert.equal(bridge.calls.disposed, 1);
});

test("provider rejects stale and invalid completions without mutating local state", async () => {
  const bridge = fakeBridge();
  const active = record();
  let completions = 0;
  createAhpChoiceProvider({ pi: { events: events() }, env: {}, bridge, getActive: () => active, complete: () => { completions += 1; } });
  assert.equal((await bridge.provider.complete({ requestId: "wrong", response: "cancel", commandId: "c", operationId: "o" })).accepted, false);
  assert.equal((await bridge.provider.complete({ requestId: active.sessionId, response: "accept", answers: { choice: { kind: "selected", value: "label-not-id" } }, commandId: "c", operationId: "o" })).accepted, false);
  await Promise.resolve();
  assert.equal(completions, 0);
});

test("disable flags and absent bridge preserve standalone behavior", () => {
  assert.equal(isAhpDisabled({ PI_DISABLE_AHP: "1" }), true);
  assert.equal(isAhpDisabled({ PI_DISABLE_ACP: "true" }), true);
  const bridge = fakeBridge();
  const adapter = createAhpChoiceProvider({ pi: { events: events() }, env: { PI_DISABLE_AHP: "1" }, bridge, getActive: () => record() });
  assert.equal(adapter.enabled, false);
  assert.equal(bridge.calls.registrations.length, 0);
});

function choiceHarness(bridge) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const bus = events();
  const ctx = { ui: { onTerminalInput: () => () => {}, setWidget() {}, notify() {} } };
  const pi = {
    events: bus,
    registerTool(def) { tools.set(def.name, def); },
    registerCommand(name, def) { commands.set(name, def); }, registerMessageRenderer() {}, sendMessage() {},
    on(name, fn) { handlers.set(name, fn); },
  };
  createChoiceExtension({ ahpBridge: bridge, cacophonyBridge: false, speaker: { speak: async () => {}, interrupt() {}, dispose() {} }, env: { PI_CHOICE_SPEECH_ENABLED: "0" }, persistedSettings: { choice: {}, tts: {} } })(pi);
  return { pi, tools, handlers, commands, ctx };
}

test("AHP completion uses the existing choice arbitration and publishes final resolution", async () => {
  const bridge = fakeBridge();
  const h = choiceHarness(bridge);
  const pending = h.tools.get("interactive_choice").execute("tool", { question: "Pick", choices: [{ id: "alpha-id", label: "Alpha" }, { id: "beta-id", label: "Beta" }] }, null, null, h.ctx);
  assert.equal(bridge.calls.requested.length, 1);
  const request = bridge.calls.requested[0];
  assert.equal(request.questions[0].options[1].id, "beta-id");
  assert.deepEqual(await bridge.provider.complete({ operationId: "operation-id", commandId: "command-id", requestId: request.requestId, response: "accept", answers: { choice: { kind: "selected", value: "beta-id" } } }), { accepted: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = await pending;
  assert.equal(result.details.choice.id, "beta-id");
  assert.equal(result.details.source, "ahp");
  assert.equal(result.details.commandId, "command-id");
  assert.deepEqual(bridge.calls.resolved[0], {
    requestId: request.requestId, resolution: "accept", answers: { choice: { kind: "selected", value: "beta-id" } }, commandId: "command-id", source: "ahp",
  });
  h.handlers.get("session_shutdown")?.();
  assert.equal(bridge.calls.disposed, 1);
});

test("runtime off/on keeps AHP registration stable and rejects a previously admitted stale completion", async () => {
  const bridge = fakeBridge(); const h = choiceHarness(bridge);
  const params = { question: "Pick", choices: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] };
  const first = h.tools.get("interactive_choice").execute("old", params, null, null, h.ctx);
  const requestId = bridge.calls.requested.at(-1).requestId;
  assert.equal((await bridge.provider.complete({ requestId, response: "accept", answers: { choice: { kind: "selected", value: "b" } }, operationId: "op", commandId: "late" })).accepted, true);
  await h.commands.get("choice").handler("off", h.ctx);
  assert.equal((await first).details.reason, "disabled");
  assert.deepEqual(await bridge.provider.snapshot(), []);
  await h.commands.get("choice").handler("on", h.ctx);
  let settled = false;
  const next = h.tools.get("interactive_choice").execute("new", params, null, null, h.ctx).then(value => { settled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false, "old AHP admission cannot select the new choice");
  assert.equal(bridge.calls.registrations.length, 1); assert.equal(bridge.calls.disposed, 0);
  await h.commands.get("choice").handler("off", h.ctx); await next;
  await h.handlers.get("session_shutdown")(); assert.equal(bridge.calls.disposed, 1);
});

test("global bridge symbol is optional and is never owned by Agent Utils", () => {
  const previous = globalThis[AHP_BRIDGE_SYMBOL];
  try {
    delete globalThis[AHP_BRIDGE_SYMBOL];
    const adapter = createAhpChoiceProvider({ pi: { events: events() }, env: {}, getActive: () => null });
    assert.equal(adapter.enabled, false);
    assert.equal(globalThis[AHP_BRIDGE_SYMBOL], undefined);
    adapter.dispose();
  } finally {
    if (previous !== undefined) globalThis[AHP_BRIDGE_SYMBOL] = previous;
  }
});

test("pending questions are published on pi-durable-adaptor's bus and its answer settles them", async () => {
  const piEvents = events();
  const paratenic = fakeBridge();
  const completions = [];
  const records = [record()];
  const adapter = createAhpChoiceProvider({ pi: { events: piEvents }, env: {}, bridge: paratenic, listActive: () => records, complete: (value) => completions.push(value) });
  // Already pending at start: published once, with the AHP request id.
  const posted = piEvents.emitted.filter((event) => event.name === DURABLE_QUESTION_EVENT);
  assert.equal(posted.length, 1);
  const question = posted[0].value;
  assert.equal(question.id, "request-opaque");
  assert.equal(question.id, paratenic.calls.requested[0].requestId, "the same id on every surface, so clients deduplicate");
  assert.equal(question.question, "Pick a region");
  assert.deepEqual(question.choices, ["West", "East"]);
  // A highlight move does not republish.
  adapter.updated(records[0]);
  adapter.requested(records[0]);
  assert.equal(piEvents.emitted.filter((event) => event.name === DURABLE_QUESTION_EVENT).length, 1);

  // Answered through pi-daemon's bridge by text: once, as the matching option.
  question.answer("east");
  question.answer("West");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(completions, [{ response: "accept", answer: { kind: "selected", value: "east-id" }, requestId: "request-opaque", source: "pi-durable" }]);
  adapter.resolved(records[0], { status: "selected", choice: { id: "east-id" } });
  assert.deepEqual(piEvents.emitted.filter((event) => event.name === DURABLE_QUESTION_DONE_EVENT).map((event) => event.value), [{ id: "request-opaque" }]);
  assert.equal(paratenic.calls.resolved[0].resolution, "accept", "Paratenic is settled too");

  // A cancel from a client declines; a question settled locally is withdrawn.
  const second = { ...record(), sessionId: "request-two" };
  records.push(second);
  adapter.requested(second);
  piEvents.emitted.filter((event) => event.name === DURABLE_QUESTION_EVENT).at(-1).value.cancel();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(completions.at(-1), { response: "decline", requestId: "request-two", source: "pi-durable" });
  const third = { ...record(), sessionId: "request-three" };
  records.push(third);
  adapter.requested(third);
  adapter.dispose();
  const done = piEvents.emitted.filter((event) => event.name === DURABLE_QUESTION_DONE_EVENT).map((event) => event.value.id);
  assert.ok(done.includes("request-two") && done.includes("request-three"), "dispose withdraws what is still published");
});

test("bus questions: free text when choices cannot be told apart by text; answers map by label", () => {
  const free = durableQuestion({ ...record(), state: { index: 0, choices: [{ id: "a", label: "Same" }, { id: "b", label: "Same" }] } });
  assert.equal(free.choices, undefined);
  assert.deepEqual(durableAnswer(record(), "Somewhere else"), { kind: "text", value: "Somewhere else" });
  assert.deepEqual(durableAnswer(record(), " west "), { kind: "selected", value: "west-id" });
  assert.equal(durableQuestion({ ...record(), finished: true }), null);
});

test("incognito and PI_DISABLE_AHP publish nothing on the bus", () => {
  for (const env of [{ PI_INCOGNITO: "1" }, { PI_DISABLE_AHP: "1" }]) {
    const piEvents = events();
    createAhpChoiceProvider({ pi: { events: piEvents }, env, listActive: () => [record()] });
    assert.equal(piEvents.emitted.filter((event) => event.name === DURABLE_QUESTION_EVENT).length, 0);
  }
});

test("interactive_choice publishes to pi-durable-adaptor's bus with a fleet-unique id and is answered from it", async () => {
  const bridge = fakeBridge();
  const h = choiceHarness(bridge);
  const pending = h.tools.get("interactive_choice").execute("tool", { question: "Deploy now?", choices: [{ id: "yes-id", label: "Yes" }, { id: "no-id", label: "No" }] }, null, null, h.ctx);
  const posted = h.pi.events.emitted.filter((event) => event.name === DURABLE_QUESTION_EVENT).map((event) => event.value);
  assert.equal(posted.length, 1);
  assert.match(posted[0].id, /^choice-\d+-[0-9a-f-]{13}$/, "unique across processes, not choice-1");
  assert.equal(posted[0].id, bridge.calls.requested[0].requestId);
  assert.deepEqual(posted[0].choices, ["Yes", "No"]);
  posted[0].answer("No");
  const result = await pending;
  assert.equal(result.details.choice.id, "no-id");
  assert.deepEqual(h.pi.events.emitted.filter((event) => event.name === DURABLE_QUESTION_DONE_EVENT).map((event) => event.value), [{ id: posted[0].id }]);
  h.handlers.get("session_shutdown")?.();
});
