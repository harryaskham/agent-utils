import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { parseOmniChoiceLine, resolveOmniInputConfig, OMNI_INPUT_STATUS_EVENT } from "../extensions/lib/omni-input.js";
import { createOmniInputExtension } from "../extensions/omni-input.js";
import { CHOICE_SESSION_EVENT } from "../extensions/lib/choice.js";
import { INPUT_ACTION_EVENT, INPUT_ACTIONS } from "../extensions/lib/input-actions.js";

function bus() {
  const handlers = new Map();
  return {
    on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); },
    off(name, fn) { handlers.set(name, (handlers.get(name) || []).filter((item) => item !== fn)); },
    emit(name, payload) { for (const fn of [...(handlers.get(name) || [])]) fn(payload); },
  };
}

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = (signal) => { proc.killed = signal; };
  return proc;
}

test("Omni parser accepts semantic envelopes and generic InjectionCommands", () => {
  assert.equal(parseOmniChoiceLine('{"v":1,"type":"event","event":"select_next","device":"ring"}').action, INPUT_ACTIONS.SELECT_NEXT);
  assert.equal(parseOmniChoiceLine('{"v":1,"type":"scroll","amount":-2}').action, INPUT_ACTIONS.SELECT_PREVIOUS);
  assert.equal(parseOmniChoiceLine('{"v":1,"type":"key","key":"enter"}').action, INPUT_ACTIONS.CHOOSE_CURRENT);
  assert.equal(parseOmniChoiceLine('{"v":1,"cmd":{"type":"key","key":"esc"}}').action, INPUT_ACTIONS.CANCEL);
  assert.equal(parseOmniChoiceLine('{"v":1,"type":"text","text":"next"}').action, INPUT_ACTIONS.SELECT_NEXT);
  assert.equal(parseOmniChoiceLine('{"v":1,"type":"text","text":"ordinary typing"}'), null);
  assert.equal(parseOmniChoiceLine('not-json'), null);
});

test("Omni input config defaults to a local-daemon subscriber and supports explicit ring fallback", () => {
  assert.deepEqual(resolveOmniInputConfig({}, {}, {}).args, ["listen", "--daemon", "127.0.0.1:8766"]);
  assert.equal(resolveOmniInputConfig({}, { inputSource: "ring" }, {}).enabled, false);
  assert.equal(resolveOmniInputConfig({ PI_CHOICE_INPUT_SOURCE: "omni" }, {}, {}).source, "omni");
  const managed = resolveOmniInputConfig({ CACO_AGENT_ID: "worker-1" }, {}, { daemon: "localhost:9999" });
  assert.deepEqual(managed.args, ["listen", "--daemon", "localhost:9999"]);
  assert.equal(managed.command, "omni");
});

test("Omni adapter subscribes only during a choice and emits generic actions", () => {
  const events = bus();
  const proc = fakeProcess();
  const statuses = [];
  const inputs = [];
  const commands = new Map();
  events.on(OMNI_INPUT_STATUS_EVENT, (status) => statuses.push(status));
  events.on(INPUT_ACTION_EVENT, (input) => inputs.push(input));
  const pi = { events, registerCommand(name, def) { commands.set(name, def); }, on() {} };
  createOmniInputExtension({ spawnImpl: (command, args, options) => { assert.equal(command, "omni"); assert.deepEqual(args, ["listen", "--daemon", "127.0.0.1:8766"]); assert.equal(options.env.OMNI_RELAY_TOKEN, "secret"); return proc; }, env: { OMNI_RELAY_TOKEN: "secret" }, persistedSettings: { choice: { inputSource: "auto" }, omniInput: {} } })(pi);
  events.emit(CHOICE_SESSION_EVENT, { status: "started", sessionId: "choice-1" });
  assert.equal(statuses.at(-1).state, "listening");
  proc.stdout.emit("data", '{"v":1,"type":"scroll","amount":1,"device":"ring-one"}\n');
  assert.equal(inputs[0].action, INPUT_ACTIONS.SELECT_NEXT);
  assert.equal(inputs[0].source, "omni");
  assert.equal(inputs[0].sessionId, "choice-1");
  events.emit(CHOICE_SESSION_EVENT, { status: "ended", sessionId: "choice-1" });
  assert.equal(proc.killed, "SIGTERM");
  assert.ok(commands.has("omni-input"));
});
