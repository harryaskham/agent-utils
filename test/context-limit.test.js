// Per-session context limits (/context 500k): parsing, the TUI Pi extension, the pi-daemon module.
import test from "node:test";
import assert from "node:assert/strict";

import { CONTEXT_LIMIT_ENTRY, RETRIGGER_MS, formatTokens, parseContextLimit, responseContext, transcriptContext } from "../extensions/lib/context-limit.js";
import contextLimitExtension, { branchLimit } from "../extensions/context-limit.js";

test("limits parse from 500k, 1.2m, 300000 and off; too small or malformed ones are refused", () => {
  assert.deepEqual(parseContextLimit("500k"), { limit: 500_000 });
  assert.deepEqual(parseContextLimit(" 1.2M "), { limit: 1_200_000 });
  assert.deepEqual(parseContextLimit("300000"), { limit: 300_000 });
  assert.deepEqual(parseContextLimit("250k tokens"), { limit: 250_000 });
  assert.deepEqual(parseContextLimit("off"), { limit: null });
  assert.deepEqual(parseContextLimit(""), { show: true });
  assert.match(parseContextLimit("5k").error, /at least 20k/);
  assert.match(parseContextLimit("lots").error, /Not a limit/);
  assert.equal(formatTokens(500_000), "500k");
  assert.equal(formatTokens(1_200_000), "1.2M");
  assert.equal(responseContext({ input: 2, cacheRead: 600_000, cacheWrite: 1_000, output: 500 }), 601_502);
  assert.equal(responseContext(undefined), 0);
});

function fakePi() {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  return {
    handlers, commands, entries,
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    emit(event, ctx) { for (const handler of handlers.get(event) ?? []) handler({ type: event }, ctx); },
  };
}

function fakeCtx({ tokens, idle = true, branch = [], mode } = {}) {
  const ctx = {
    mode, tokens, notices: [], statuses: new Map(), compactions: 0,
    getContextUsage: () => ({ tokens: ctx.tokens, contextWindow: 1_000_000, percent: ctx.tokens / 10_000 }),
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    compact(options) { ctx.compactions += 1; ctx.finish = options?.onComplete; },
    ui: { notify: (text) => ctx.notices.push(text), setStatus: (key, text) => ctx.statuses.set(key, text) },
  };
  return ctx;
}

test("TUI Pi: /context sets the session's limit, kept as a session entry; past it, a settled session compacts once", async () => {
  const pi = fakePi();
  const deferred = [];
  contextLimitExtension(pi, { defer: (fn) => deferred.push(fn) });
  const run = () => { while (deferred.length) deferred.shift()(); };

  // A session that had a limit gets it back.
  const restored = fakeCtx({ tokens: 100_000, branch: [{ type: "custom", customType: CONTEXT_LIMIT_ENTRY, data: { limit: 300_000 } }] });
  pi.emit("session_start", restored);
  assert.equal(restored.statuses.get("context-limit"), "ctx≤300k");
  assert.equal(branchLimit([{ type: "custom", customType: CONTEXT_LIMIT_ENTRY, data: { limit: null } }]), null);

  const ctx = fakeCtx({ tokens: 450_000 });
  await pi.commands.get("context").handler("500k", ctx);
  assert.deepEqual(pi.entries.at(-1), { type: "custom", customType: CONTEXT_LIMIT_ENTRY, data: { limit: 500_000 } });
  assert.match(ctx.notices.at(-1), /compacts when its context passes 500k tokens \(now 450k\)/);

  // Under the limit: nothing. Over it, settled: one compaction, not two.
  pi.emit("agent_settled", ctx); run();
  assert.equal(ctx.compactions, 0);
  ctx.tokens = 620_000;
  pi.emit("agent_settled", ctx); run();
  pi.emit("agent_settled", ctx); run();
  assert.equal(ctx.compactions, 1);
  assert.match(ctx.notices.at(-1), /Context 620k is past this session's limit of 500k: compacting/);
  ctx.finish();
  ctx.tokens = 120_000;
  pi.emit("agent_settled", ctx); run();
  assert.equal(ctx.compactions, 1);

  // Busy, or over RPC: never compacts (Pi's compact() would stop the agent or the request).
  const busy = fakeCtx({ tokens: 900_000, idle: false });
  pi.emit("agent_settled", busy); run();
  assert.equal(busy.compactions, 0);
  const rpc = fakeCtx({ tokens: 900_000, mode: "rpc" });
  pi.emit("agent_settled", rpc); run();
  assert.equal(rpc.compactions, 0);

  // Off: recorded, and nothing compacts.
  await pi.commands.get("context").handler("off", ctx);
  assert.deepEqual(pi.entries.at(-1).data, { limit: null });
  ctx.tokens = 990_000;
  pi.emit("agent_settled", ctx); run();
  assert.equal(ctx.compactions, 1);
  assert.equal(ctx.statuses.get("context-limit"), undefined);
});

test("TUI Pi: without a limit the extension does nothing", () => {
  const pi = fakePi();
  const deferred = [];
  contextLimitExtension(pi, { defer: (fn) => deferred.push(fn) });
  const ctx = fakeCtx({ tokens: 990_000 });
  pi.emit("session_start", ctx);
  pi.emit("agent_settled", ctx);
  assert.equal(deferred.length, 0);
  assert.equal(ctx.compactions, 0);
});

function moduleState() {
  const values = new Map();
  return { async get(key) { return values.get(key); }, async set(key, value) { if (value === undefined) values.delete(key); else values.set(key, value); } };
}

test("pi-daemon: /context sets the limit in module state; a response past it asks for one background compaction", async (t) => {
  const { commands, observe } = await import("../extensions/durable/context-limit.mjs");
  const state = moduleState();
  const notices = [];
  const ctx = { sessionId: "s1", conversationId: 1, state, notify: (text) => notices.push(text) };
  await commands.context.run("500k", ctx);
  assert.equal(await state.get("limit"), 500_000);
  assert.match(notices.at(-1), /passes 500k tokens/);

  let compactions = 0;
  const info = { sessionId: "s1", conversationId: 1, state, compact: async () => { compactions += 1; return true; } };
  const response = (cacheRead) => ({ type: "message_end", message: { role: "assistant", usage: { input: 2, cacheRead, cacheWrite: 0, output: 100 } } });
  await observe(response(400_000), info);
  assert.equal(compactions, 0);
  await observe(response(510_000), info);
  await observe(response(530_000), info);
  assert.equal(compactions, 1, "asked once while over");
  await observe(response(200_000), info);
  await observe(response(520_000), info);
  assert.equal(compactions, 2, "asked again once it had come under");

  // Still over long after asking: asks again.
  const later = Date.now() + RETRIGGER_MS * 2;
  t.mock.method(Date, "now", () => later);
  await observe(response(540_000), info);
  assert.equal(compactions, 3);
  t.mock.restoreAll();

  await commands.context.run("", ctx);
  assert.match(notices.at(-1), /now 540k/);
  await commands.context.run("off", ctx);
  assert.equal(await state.get("limit"), undefined);
  await observe(response(900_000), info);
  assert.equal(compactions, 3);

  // Durable's message_end carries the committed entry rather than the message.
  await commands.context.run("500k", ctx);
  await observe({ type: "message_end", entry: { id: 9, kind: "pi.assistant", model: [{ role: "assistant", usage: { input: 1, cacheRead: 700_000, output: 10 } }] } }, { ...info, conversationId: 7 });
  assert.equal(compactions, 4);

  // An older pi-daemon without info.compact: nothing breaks.
  await commands.context.run("300k", ctx);
  await observe(response(900_000), { sessionId: "s2", conversationId: 1, state });
  await assert.doesNotReject(observe({ type: "message_end", message: { role: "user" } }, info));
});

/** A transcript entry: a response with this usage (and stop reason). */
function answer(usage, stopReason = "stop") {
  return { kind: "pi.assistant", model: [{ role: "assistant", stopReason, usage }] };
}

test("a transcript measures like pi-daemon's footer: the newest good response, back to a compaction", () => {
  assert.equal(transcriptContext([answer({ input: 2, cacheRead: 500_000, output: 98 })]), 500_100);
  assert.equal(transcriptContext([answer({ totalTokens: 584_000, input: 1 })]), 584_000, "totalTokens when present");
  assert.equal(
    transcriptContext([answer({ input: 1, cacheRead: 300_000 }), { kind: "pi.user" }, answer({ input: 9, cacheRead: 900_000 }, "aborted"), answer({ input: 1 }, "error")]),
    300_001,
    "aborted and failed responses measure nothing",
  );
  assert.equal(transcriptContext([answer({ input: 1, cacheRead: 900_000 }), { kind: "pi.compaction" }]), undefined, "a compaction starts over");
  assert.equal(transcriptContext([answer({ input: 1, cacheRead: 900_000 }), { kind: "pi.reset" }, { kind: "pi.user" }]), undefined);
  assert.equal(transcriptContext([]), undefined);
  assert.equal(transcriptContext(undefined), undefined);
});

test("pi-daemon (bd-da24a9): /context measures an idle session from its transcript, and a limit below it compacts at once", async () => {
  const { commands, observe } = await import("../extensions/durable/context-limit.mjs");
  const state = moduleState();
  const notices = [];
  const compactions = [];
  let entries = [answer({ input: 4, cacheRead: 584_000, output: 0 })];
  const conversation = {
    async context() { return { entries }; },
    async compact(instructions, context) { compactions.push({ instructions, context }); return 77; },
  };
  const opened = [];
  const ctx = {
    sessionId: "idle-session",
    conversationId: 3,
    context: { marker: true },
    state,
    notify: (text) => notices.push(text),
    harness: { async conversation(id, context) { opened.push([id, context]); return conversation; } },
  };

  // No response since the worker started: the size comes from the transcript.
  await commands.context.run("", ctx);
  assert.match(notices.at(-1), /^No context limit for this session \(now 584k\)/);
  assert.deepEqual(opened[0], [3, { marker: true }]);

  // A limit below the current size compacts now, once.
  await commands.context.run("512k", ctx);
  assert.equal(await state.get("limit"), 512_000);
  assert.deepEqual(compactions, [{ instructions: undefined, context: { marker: true } }]);
  assert.match(notices.at(-1), /passes 512k tokens \(now 584k\)\. It is over that now, so it is compacting in the background\./);
  // Setting it again (or a response over it) within RETRIGGER_MS does not ask twice.
  await commands.context.run("512k", ctx);
  await observe({ type: "message_end", message: { role: "assistant", usage: { input: 1, cacheRead: 590_000 } } }, { ...ctx, compact: async () => compactions.push("observer") });
  assert.equal(compactions.length, 1);

  // A limit above the current size: nothing to do.
  const other = { ...ctx, sessionId: "under", notify: (text) => notices.push(text) };
  entries = [answer({ input: 1, cacheRead: 200_000 })];
  await commands.context.run("500k", other);
  assert.equal(compactions.length, 1);
  assert.match(notices.at(-1), /passes 500k tokens \(now 200k\)\. \/context off/);

  // The transcript wins over the last response seen: after the compaction, nothing measures it.
  entries = [answer({ input: 4, cacheRead: 584_000 }), { kind: "pi.compaction" }];
  await commands.context.run("", ctx);
  assert.match(notices.at(-1), /passes 500k tokens\. \/context off/, "no stale (now 584k) after the compaction");

  // Just compacted (or a host without the harness): no size, no compaction, no error.
  entries = [answer({ input: 1, cacheRead: 900_000 }), { kind: "pi.compaction" }];
  await commands.context.run("100k", { ...ctx, sessionId: "compacted" });
  assert.equal(compactions.length, 1);
  assert.match(notices.at(-1), /passes 100k tokens\. \/context off/);
  await commands.context.run("100k", { sessionId: "old-host", conversationId: 1, state, notify: (text) => notices.push(text) });
  assert.match(notices.at(-1), /passes 100k tokens\. \/context off/);
  // A failing compaction leaves the limit set and says nothing false.
  entries = [answer({ input: 1, cacheRead: 900_000 })];
  conversation.compact = async () => { throw new Error("busy"); };
  await commands.context.run("100k", { ...ctx, sessionId: "failing" });
  assert.match(notices.at(-1), /passes 100k tokens \(now 900k\)\. \/context off/);
});
