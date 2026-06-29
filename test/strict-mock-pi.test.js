import test from "node:test";
import assert from "node:assert/strict";

import { createStrictMockPi } from "./helpers/strict-mock-pi.js";

test("registerCommand accepts the real two-arg (name, def) form and stores it", () => {
  const { pi, commands } = createStrictMockPi();
  const def = { handler: () => {} };
  pi.registerCommand("rt", def);
  assert.equal(commands.get("rt"), def);
  assert.equal(pi.getCommand("rt"), def);
});

test("registerCommand rejects the bd-53da92 object-as-name shape", () => {
  const { pi } = createStrictMockPi();
  // The exact crash shape: pi.registerCommand({ name: "x", ... }) — object passed as name.
  assert.throws(() => pi.registerCommand({ name: "x", handler: () => {} }), /name must be a non-empty string/);
  assert.throws(() => pi.registerCommand("", {}), /non-empty string/);
  assert.throws(() => pi.registerCommand("ok", null), /def must be an object or function/);
});

test("registerTool requires a string name; rejects nameless/garbage defs", () => {
  const { pi, tools } = createStrictMockPi();
  pi.registerTool({ name: "search", run: () => {} });
  assert.ok(tools.has("search"));
  assert.deepEqual(pi.getAllTools().map((t) => t.name), ["search"]);
  assert.throws(() => pi.registerTool({}), /def\.name must be a non-empty string/);
  assert.throws(() => pi.registerTool(null), /def must be an object/);
});

test("on requires (string event, function fn) and dispatches via emit; unsubscribe works", () => {
  const { pi, emit } = createStrictMockPi();
  let n = 0;
  const off = pi.on("agent_end", () => { n += 1; });
  assert.throws(() => pi.on("agent_end", "notfn"), /handler must be a function/);
  assert.throws(() => pi.on(123, () => {}), /event must be a non-empty string/);
  emit("agent_end");
  emit("agent_end");
  assert.equal(n, 2);
  off();
  emit("agent_end");
  assert.equal(n, 2, "unsubscribed handler no longer fires");
});

test("unknown pi.* methods are permissive no-ops so heavy extensions run", () => {
  const { pi } = createStrictMockPi();
  assert.equal(typeof pi.sendUserMessage, "function");
  assert.equal(pi.sendUserMessage("hi", { deliverAs: "followUp" }), undefined);
  assert.equal(pi.setModel("x"), undefined);
  assert.equal(pi.exec("noop"), undefined);
});

test("overrides replace methods (e.g. a sendUserMessage spy)", () => {
  const sent = [];
  const { pi } = createStrictMockPi({ sendUserMessage: (t) => sent.push(t) });
  pi.sendUserMessage("hello");
  assert.deepEqual(sent, ["hello"]);
});
