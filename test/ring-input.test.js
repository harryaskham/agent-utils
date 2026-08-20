import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHOICE_INPUT_ACTIONS, CHOICE_INPUT_EVENT, CHOICE_SESSION_EVENT } from "../extensions/lib/choice.js";
import {
  buildRingInputArgs,
  parseRingInputLine,
  resolveRingInputEventMap,
  ringEventToInputAction,
} from "../extensions/lib/ring-input.js";
import { createRingInputExtension } from "../extensions/ring-input.js";
import { createChoiceExtension } from "../extensions/choice.js";
import { OMNI_INPUT_STATUS_EVENT } from "../extensions/lib/omni-input.js";

process.env.PI_CHOICE_CACO_ENABLED = "0";

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

test("ring input defaults and env overrides map semantic choice actions", () => {
  const defaults = resolveRingInputEventMap({}, {});
  assert.ok(defaults[CHOICE_INPUT_ACTIONS.PREVIOUS].includes("event-ring-ccw"));
  assert.ok(defaults[CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT].includes("event-ring-select"));
  assert.equal(ringEventToInputAction({ event: "EVENT_RING_CCW" }, defaults).action, CHOICE_INPUT_ACTIONS.PREVIOUS);
  assert.equal(ringEventToInputAction({ event: "yes" }, defaults).action, CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT);
  assert.equal(ringEventToInputAction({ event: "unknown" }, defaults), null);

  const custom = resolveRingInputEventMap({}, { PI_RING_CHOICE_NEXT_EVENTS: "flick,flick-fast" });
  assert.deepEqual(custom[CHOICE_INPUT_ACTIONS.NEXT], ["flick", "flick-fast"]);
});

test("ring input parses daemon event JSON and builds only a bounded ring get smart-client command", () => {
  assert.deepEqual(parseRingInputLine('{"ts":"now","event":"yes","source":"gesture","ring":"r02"}'), {
    event: "yes", ts: "now", source: "gesture", ring: "r02", payload: null,
    raw: { ts: "now", event: "yes", source: "gesture", ring: "r02" },
  });
  assert.equal(parseRingInputLine("not valid json with spaces"), null);
  const args = buildRingInputArgs({ timeoutMs: 1234, eventMap: resolveRingInputEventMap({}, {}) });
  assert.equal(args[0], "get", "adapter reads the daemon source; it never starts `ring daemon`");
  assert.ok(args.includes("--after"));
  assert.ok(args.includes("now"));
  assert.equal(args[args.indexOf("--timeout-ms") + 1], "1234");
  const indefinite = buildRingInputArgs({ timeoutMs: 0, eventMap: resolveRingInputEventMap({}, {}) });
  assert.equal(indefinite[indefinite.indexOf("--timeout-ms") + 1], "300000", "no-timeout choices use renewable bounded clients");
  assert.ok(!args.includes("daemon"));
  assert.ok(!args.includes("on"));
});

test("ring adapter starts for a choice session, emits generic actions, filters ring name, and stops on end", () => {
  const events = bus();
  const spawned = [];
  const proc = fakeProcess();
  const spawnImpl = (command, args, options) => { spawned.push({ command, args, options }); return proc; };
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    events,
    registerCommand(name, def) { commands.set(name, def); },
    on(name, fn) { handlers.set(name, fn); },
  };
  createRingInputExtension({ spawnImpl, env: {}, persistedSettings: { choice: { inputSource: "ring" }, ringInput: { enabled: true } } })(pi);
  const inputs = [];
  events.on(CHOICE_INPUT_EVENT, (input) => inputs.push(input));

  events.emit(CHOICE_SESSION_EVENT, { status: "started", sessionId: "choice-1", timeoutMs: 5000, ring: "r02" });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "ring");
  assert.equal(spawned[0].args[0], "get");

  proc.stdout.emit("data", '{"event":"EVENT_RING_CCW","ring":"other"}\n');
  assert.equal(inputs.length, 0, "other ring is filtered");
  proc.stdout.emit("data", '{"event":"EVENT_RING_CCW","ring":"r02"}\n{"event":"EVENT_RING_SELECT","ring":"r02"}\n');
  assert.deepEqual(inputs.map((input) => input.action), [CHOICE_INPUT_ACTIONS.PREVIOUS, CHOICE_INPUT_ACTIONS.CHOOSE_CURRENT]);
  assert.ok(inputs.every((input) => input.sessionId === "choice-1"));

  events.emit(CHOICE_SESSION_EVENT, { status: "ended", sessionId: "choice-1" });
  assert.equal(proc.killed, "SIGTERM", "choice end terminates only the ring get client");
});

test("separate choice and ring extensions compose only through pi.events", async () => {
  const events = bus();
  const proc = fakeProcess();
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const terminal = [];
  const ctx = { ui: {
    setWidget() {}, notify() {},
    onTerminalInput(fn) { terminal.push(fn); return () => {}; },
  } };
  const pi = {
    events,
    registerTool(def) { tools.set(def.name, def); },
    registerCommand(name, def) { commands.set(name, def); },
    on(name, fn) { handlers.set(name, fn); },
  };
  createChoiceExtension({ speaker: { speak: async () => {}, interrupt() {}, dispose() {} } })(pi);
  createRingInputExtension({ spawnImpl: () => proc, env: {}, persistedSettings: { choice: { inputSource: "ring" }, ringInput: { enabled: true } } })(pi);

  const pending = tools.get("interactive_choice").execute("id", {
    question: "Pick", choices: [{ label: "one" }, { label: "two" }], timeoutMs: 1000,
  }, null, null, ctx);
  await Promise.resolve();
  proc.stdout.emit("data", '{"event":"EVENT_RING_CW"}\n{"event":"EVENT_RING_SELECT"}\n');
  const result = await pending;
  assert.equal(result.details.status, "selected");
  assert.equal(result.details.choice.label, "two");
  assert.equal(result.details.source, "ring");
  assert.equal(proc.killed, "SIGTERM", "generic choice end tells the independent ring adapter to stop its smart client");
});

test("auto source keeps direct ring idle while Omni listens and falls back on Omni failure", () => {
  const events = bus();
  const processes = [];
  const pi = { events, registerCommand() {}, on() {} };
  createRingInputExtension({ spawnImpl: () => { const proc = fakeProcess(); processes.push(proc); return proc; }, env: {}, persistedSettings: { choice: { inputSource: "auto" }, ringInput: { enabled: true } } })(pi);
  events.emit(OMNI_INPUT_STATUS_EVENT, { state: "listening" });
  events.emit(CHOICE_SESSION_EVENT, { status: "started", sessionId: "choice-omni", timeoutMs: 0 });
  assert.equal(processes.length, 0, "Omni is primary; no CPU-heavy direct ring client is spawned");
  events.emit(OMNI_INPUT_STATUS_EVENT, { state: "error", error: "tail unavailable" });
  assert.equal(processes.length, 1, "direct ring client starts only as automatic fallback");
  events.emit(CHOICE_SESSION_EVENT, { status: "ended", sessionId: "choice-omni" });
  assert.equal(processes[0].killed, "SIGTERM");
});

test("timeout=0 keeps ring listening indefinitely by renewing bounded smart clients", async () => {
  const events = bus();
  const processes = [];
  const pi = { events, registerCommand() {}, on() {} };
  createRingInputExtension({ spawnImpl: () => { const proc = fakeProcess(); processes.push(proc); return proc; }, env: {}, persistedSettings: { choice: { inputSource: "ring" }, ringInput: { enabled: true } } })(pi);
  events.emit(CHOICE_SESSION_EVENT, { status: "started", sessionId: "choice-infinite", timeoutMs: 0 });
  assert.equal(processes.length, 1);
  processes[0].stderr.emit("data", "timed out waiting for matching ring events");
  processes[0].emit("exit", 1, null);
  await Promise.resolve();
  assert.equal(processes.length, 2, "adapter renews after its defensive five-minute client bound");
  events.emit(CHOICE_SESSION_EVENT, { status: "ended", sessionId: "choice-infinite" });
  assert.equal(processes[1].killed, "SIGTERM");
});

test("ring-input commands are runtime-only and preserve startup settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ring-runtime-settings-"));
  const settingsPath = join(dir, "settings.json");
  const startup = JSON.stringify({ agentUtils: { ringInput: { enabled: true, command: "ring" } }, unrelated: 9 }, null, 2) + "\n";
  writeFileSync(settingsPath, startup);
  try {
    const events = bus();
    const commands = new Map();
    const pi = { events, registerCommand(name, def) { commands.set(name, def); }, on() {} };
    createRingInputExtension({ env: {}, settingsPath, persistedSettings: { ringInput: { enabled: true, command: "ring" } } })(pi);
    const ctx = { ui: { notify() {} } };
    await commands.get("ring-input").handler("off", ctx);
    await commands.get("ring-input").handler("settings command=other enabled=true", ctx);
    assert.equal(readFileSync(settingsPath, "utf8"), startup);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ring adapter disabled mode never spawns and timeout exits stay non-fatal", () => {
  {
    const events = bus();
    let spawnCount = 0;
    const pi = { events, registerCommand() {}, on() {} };
    createRingInputExtension({ spawnImpl: () => { spawnCount += 1; return fakeProcess(); }, env: {}, persistedSettings: { ringInput: { enabled: false } } })(pi);
    events.emit(CHOICE_SESSION_EVENT, { status: "started", sessionId: "choice-x", timeoutMs: 10 });
    assert.equal(spawnCount, 0);
  }
  {
    const events = bus();
    const proc = fakeProcess();
    const commands = new Map();
    const pi = { events, registerCommand(name, def) { commands.set(name, def); }, on() {} };
    createRingInputExtension({ spawnImpl: () => proc, env: {}, persistedSettings: { choice: { inputSource: "ring" }, ringInput: { enabled: true } } })(pi);
    events.emit(CHOICE_SESSION_EVENT, { status: "started", sessionId: "choice-y", timeoutMs: 10 });
    proc.stderr.emit("data", "Error: execution error: timed out waiting for matching ring events");
    proc.emit("exit", 1, null);
    const notifications = [];
    commands.get("ring-input").handler("status", { ui: { notify: (message, level) => notifications.push({ message, level }) } });
    assert.match(notifications[0].message, /ring input: idle/);
    assert.doesNotMatch(notifications[0].message, /error=/);
  }
});
