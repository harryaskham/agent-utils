import test from "node:test";
import assert from "node:assert/strict";

import { createChoiceExtension } from "../extensions/choice.js";
import {
  AHP_AVAILABLE_EVENT,
  AHP_BRIDGE_SYMBOL,
  AHP_DISCOVERY_EVENT,
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
  assert.deepEqual(completions, [{ response: "accept", answer: { kind: "selected", value: "west-id" }, commandId: "cmd", operationId: "op" }]);

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
  const tools = new Map();
  const handlers = new Map();
  const bus = events();
  const ctx = { ui: { onTerminalInput: () => () => {}, setWidget() {}, notify() {} } };
  const pi = {
    events: bus,
    registerTool(def) { tools.set(def.name, def); },
    registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
    on(name, fn) { handlers.set(name, fn); },
  };
  createChoiceExtension({ ahpBridge: bridge, cacophonyBridge: false, speaker: { speak: async () => {}, interrupt() {}, dispose() {} }, env: { PI_CHOICE_SPEECH_ENABLED: "0" }, persistedSettings: { choice: {}, tts: {} } })(pi);
  return { pi, tools, handlers, ctx };
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
