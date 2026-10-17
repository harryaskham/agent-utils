import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import compactNext, { parseCompactNextArgs, selectCompactNextPrefix, summarizeCompactNextBoundary } from "../extensions/lib/compact-next.js";

function harness(options = {}) {
  const commands = new Map(), handlers = new Map(), jobs = new Map();
  const notifications = [], sent = [], compactions = [], summaries = [], statuses = [];
  let id = 0;
  const state = { idle: false, queued: false, session: "s1", leaf: "leaf" };
  const controller = new AbortController();
  const ctx = {
    mode: "tui", signal: controller.signal,
    ui: { notify: (text, level) => notifications.push({ text, level }), setStatus: (...args) => statuses.push(args) },
    sessionManager: { getSessionId: () => state.session, getLeafId: () => state.leaf },
    isIdle: () => state.idle, hasPendingMessages: () => state.queued,
    compact: opts => compactions.push(opts),
    abort: () => assert.fail("must never abort the agent"),
  };
  compactNext({
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => handlers.set(name, handler),
    sendMessage: (message, delivery) => sent.push({ message, delivery }),
  }, {
    summarize: async (...args) => {
      summaries.push(args);
      return options.summarize ? options.summarize(...args) : { type: "compaction", summary: "Summary", firstKeptEntryId: "kept" };
    },
    defer: fn => { jobs.set(++id, fn); return id; }, cancelDeferred: id => jobs.delete(id),
  });
  return {
    ctx, state, controller, commands, handlers, notifications, sent, compactions, summaries, statuses, jobs,
    command: args => commands.get("compact-next").handler(args, ctx),
    emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
    run: () => { const job = jobs.entries().next().value; if (job) { jobs.delete(job[0]); return job[1](); } },
  };
}
const boundary = (overrides = {}) => ({ outcome: "completed", entries: [], continue: false, context: { contextEntries: [], canContinue: true }, ...overrides });

// CN-01: parse/discovery; one bounded, session-local request.
test("compact-next parsing defaults, modes, focus, status and invalid empty mode", () => {
  assert.deepEqual(parseCompactNextArgs(""), { action: "queue", resume: "auto", customInstructions: undefined });
  assert.deepEqual(parseCompactNextArgs('resume=continue "Keep the tests"'), { action: "queue", resume: "continue", customInstructions: "Keep the tests" });
  for (const resume of ["auto", "none", "continue", "off"]) assert.equal(parseCompactNextArgs(`resume=${resume}`).resume, resume);
  for (const action of ["cancel", "help", "status"]) assert.deepEqual(parseCompactNextArgs(action), { action });
  assert.deepEqual(parseCompactNextArgs("off"), { action: "cancel" });
  assert.throws(() => parseCompactNextArgs("resume=empty"), /empty prompts are not portable/);
  assert.throws(() => parseCompactNextArgs('"bad'), /Unclosed/);
});
test("package advertises compact-next", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.ok(pkg.pi.extensions.includes("./extensions/compact-next.js"));
});
test("command returns immediately while busy; no individual tool callback or agent_end starts compaction", async () => {
  const h = harness();
  await h.command("");
  assert.equal(h.jobs.size, 0);
  assert.equal(h.compactions.length, 0);
  assert.equal(h.summaries.length, 0);
  assert.equal(h.handlers.has("tool_execution_end"), false);
  assert.equal(h.handlers.has("agent_end"), false);
  await h.command("");
  await h.command("status");
  assert.match(h.notifications.at(-1).text, /queued/);
  await h.emit("turn_end", boundary());
  assert.equal(h.summaries.length, 1);
  assert.equal(h.compactions.length, 0);
  await h.emit("turn_end", boundary());
  assert.equal(h.summaries.length, 1);
});

// CN-02: complete batch, no new user prompt, same run; preserve other extensions.
test("actionable turn compacts and resumes with no message, preserving prior drafts/continuation", async () => {
  const h = harness();
  await h.command("Preserve test failures");
  const earlier = { type: "custom", customType: "another-extension", data: 1 };
  const result = await h.emit("turn_end", boundary({ entries: [earlier] }));
  assert.equal(result.continue, true);
  assert.deepEqual(result.entries.map(x => x.type), ["custom", "compaction"]);
  assert.equal(result.entries[0], earlier);
  assert.equal(h.summaries[0][2].customInstructions, "Preserve test failures");
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.compactions, []);
  assert.equal(h.statuses.at(-1)[1], undefined);
});
test("final assistant auto uses hidden Continue, explicit continue is visible, none does not force a turn", async () => {
  for (const mode of ["auto", "continue", "none", "off"]) {
    const h = harness();
    await h.command(`resume=${mode}`);
    const result = await h.emit("turn_end", boundary({ context: { canContinue: false } }));
    const resume = mode === "auto" || mode === "continue";
    assert.equal(result.continue, resume);
    assert.equal(result.entries.length, resume ? 2 : 1);
    if (resume) assert.deepEqual(result.entries[1], {
      type: "custom_message", customType: "agent-utils.compact-next-continue", content: "Continue.", display: mode === "continue",
    });
  }
});
test("off preserves existing continuation and queued work avoids an automatic extra message", async () => {
  const h = harness();
  await h.command("resume=off");
  assert.equal((await h.emit("turn_end", boundary({ continue: true }))).continue, true);
  await h.command("");
  h.state.queued = true;
  const result = await h.emit("turn_end", boundary({ context: { canContinue: false } }));
  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 1);
});
test("request arriving after turn_end is handled at agent_before_settle", async () => {
  const h = harness();
  await h.command("");
  assert.equal((await h.emit("agent_before_settle", boundary())).continue, true);
});

// CN-03: cancellation/error/session generations must never restart stopped work.
test("cancel/status/duplicates during summarization remain nonblocking and late result is discarded", async () => {
  let finish;
  const h = harness({ summarize: () => new Promise(resolve => { finish = resolve; }) });
  await h.command("");
  const result = h.emit("turn_end", boundary());
  await h.command("");
  assert.match(h.notifications.at(-1).text, /already pending/);
  await h.command("status");
  assert.match(h.notifications.at(-1).text, /compacting/);
  await h.command("cancel");
  assert.equal(h.summaries[0][3].aborted, true);
  finish({ type: "compaction", summary: "late", firstKeptEntryId: "kept" });
  assert.equal(await result, undefined);
  assert.deepEqual(h.sent, []);
});
for (const outcome of ["aborted", "error"]) test(`${outcome} cancels without compact or resume`, async () => {
  const h = harness();
  await h.command("");
  assert.equal(await h.emit("turn_end", boundary({ outcome })), undefined);
  assert.equal(h.summaries.length, 0);
  await h.emit("agent_settled");
  assert.equal(h.jobs.size, 0);
});
test("legacy failed assistant cancels rather than resuming after settlement", async () => {
  const h = harness();
  await h.command("");
  await h.emit("turn_end", { message: { stopReason: "error" } });
  await h.emit("agent_settled");
  assert.equal(h.jobs.size, 0);
});
test("summary failure leaves the current work untouched and is reported as an error", async () => {
  const h = harness({ summarize: async () => { throw new Error("provider failed"); } });
  await h.command("");
  assert.equal(await h.emit("turn_end", boundary()), undefined);
  assert.match(h.notifications.at(-1).text, /provider failed/);
  assert.equal(h.notifications.at(-1).level, "error");
  assert.deepEqual(h.sent, []);
});
test("branch mutation during summary rejects stale compaction", async () => {
  const h = harness({ summarize: async () => { h.state.leaf = "new-leaf"; return {}; } });
  await h.command("");
  assert.equal(await h.emit("turn_end", boundary()), undefined);
  assert.match(h.notifications.at(-1).text, /branch changed/);
});
for (const event of ["session_start", "session_switch", "session_fork", "session_tree", "session_shutdown"]) test(`${event} invalidates callbacks`, async () => {
  const h = harness();
  h.state.idle = true;
  await h.command("");
  h.run();
  await h.emit(event);
  h.compactions[0].onComplete({});
  assert.deepEqual(h.sent, []);
});
test("Escape during boundary summary discards even a provider that ignores abort", async () => {
  const h = harness({ summarize: async () => { h.controller.abort(); return {}; } });
  await h.command("");
  assert.equal(await h.emit("turn_end", boundary()), undefined);
  assert.deepEqual(h.sent, []);
});
test("normal auto compaction satisfies a queued request without a duplicate", async () => {
  const h = harness();
  await h.command("");
  await h.emit("session_compact");
  assert.equal(await h.emit("turn_end", boundary()), undefined);
  assert.match(h.notifications.at(-1).text, /satisfied/);
});

// CN-04: old hosts wait for final settlement, leave dispatcher, and recheck idle.
test("legacy turn_end cannot compact, idle completion gates exactly one resume", async () => {
  const h = harness();
  await h.command("");
  assert.equal(await h.emit("turn_end", {}), undefined);
  await h.emit("agent_settled");
  assert.equal(h.compactions.length, 0);
  h.state.idle = true;
  h.run();
  assert.equal(h.compactions.length, 1);
  assert.deepEqual(h.sent, []);
  h.compactions[0].onComplete({});
  h.compactions[0].onComplete({});
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.display, false);
  assert.equal(h.sent[0].delivery.triggerTurn, true);
});
test("new busy work or queued input wins deferred idle race", async () => {
  for (const state of [{ idle: false, queued: false }, { idle: true, queued: true }]) {
    const h = harness();
    h.state.idle = true;
    await h.command("");
    Object.assign(h.state, state);
    h.run();
    assert.equal(h.compactions.length, 0);
    h.state.idle = false;
    assert.equal((await h.emit("turn_end", boundary())).continue, true);
  }
});
test("idle compaction failures, cancellation, and newer input never resume", async () => {
  for (const action of ["failure", "cancel", "busy", "queued", "session"]) {
    const h = harness();
    h.state.idle = true;
    await h.command("");
    h.run();
    if (action === "failure") h.compactions[0].onError(new Error("failed"));
    if (action === "cancel") await h.command("cancel");
    if (action === "busy") h.state.idle = false;
    if (action === "queued") h.state.queued = true;
    if (action === "session") h.state.session = "new";
    h.compactions[0].onComplete({});
    assert.deepEqual(h.sent, [], action);
  }
});
test("RPC supports same-run boundaries, not detached idle manual compaction", async () => {
  const h = harness();
  h.ctx.mode = "rpc";
  await h.command("");
  assert.equal((await h.emit("turn_end", boundary())).continue, true);
  h.state.idle = true;
  await h.command("");
  h.run();
  assert.deepEqual(h.compactions, []);
  assert.match(h.notifications.at(-1).text, /controller/);
});
test("AHP uses same-run boundaries; detached idle fallback honors PI_DISABLE_AHP", async () => {
  const key = Symbol.for("paratenic.pi.ahp-bridge.v1");
  const previousBridge = globalThis[key], previousDisabled = process.env.PI_DISABLE_AHP;
  try {
    globalThis[key] = { enabled: true };
    delete process.env.PI_DISABLE_AHP;
    const h = harness();
    await h.command("");
    assert.equal((await h.emit("turn_end", boundary())).continue, true);
    h.state.idle = true;
    await h.command("");
    h.run();
    assert.equal(h.compactions.length, 0);
    process.env.PI_DISABLE_AHP = "1";
    await h.command("");
    h.run();
    assert.equal(h.compactions.length, 1);
  } finally {
    if (previousBridge === undefined) delete globalThis[key]; else globalThis[key] = previousBridge;
    if (previousDisabled === undefined) delete process.env.PI_DISABLE_AHP; else process.env.PI_DISABLE_AHP = previousDisabled;
  }
});
test("idle none/off never inject a message", async () => {
  for (const mode of ["none", "off"]) {
    const h = harness();
    h.state.idle = true;
    await h.command(`resume=${mode}`);
    h.run();
    h.compactions[0].onComplete({});
    assert.deepEqual(h.sent, []);
  }
});

// CN-05: summary input is the edited projection; retain complete tool batches.
function projected(roles) {
  return roles.map((role, i) => ({ sourceEntry: { id: `e${i}`, type: "message" }, messages: [{ role, content: `content-${i}` }] }));
}
test("retention never splits assistant/tool pairs and includes prior compacted context in summary", () => {
  const entries = projected(["user", "assistant", "user", "assistant", "toolResult", "toolResult"]);
  entries[0].sourceEntry.type = "compaction";
  for (const keep of [0, 1, 2, 3]) {
    const prefix = selectCompactNextPrefix(entries, keep, () => 1, "e3");
    assert.equal(prefix.firstKeptEntryId, "e3");
    assert.deepEqual(prefix.messages, entries.slice(0, 3).flatMap(e => e.messages));
  }
  assert.equal(selectCompactNextPrefix(entries, 4, () => 1, "e3").firstKeptEntryId, "e2");
  assert.throws(() => selectCompactNextPrefix(projected(["user", "assistant"]), 100, () => 1, "e1"), /Nothing to compact/);
});
test("summary adapter uses host settings/model registry, edited prefix, usage and session routing", async () => {
  const entries = projected(["user", "assistant", "toolResult"]);
  const calls = [];
  const model = { provider: "fixture", id: "model" };
  const signal = new AbortController().signal;
  const ctx = {
    model, cwd: "/fixture", isProjectTrusted: () => false, thinkingLevel: "low",
    sessionManager: { getBranch: () => entries.map(e => e.sourceEntry), getSessionId: () => "session" },
    modelRegistry: { streamSimple: (...args) => { calls.push(args); return "stream"; } },
  };
  const host = {
    getAgentDir: () => "/agent", estimateTokens: () => 1,
    SettingsManager: { create(cwd, dir, options) {
      assert.equal(cwd, "/fixture"); assert.equal(dir, "/agent"); assert.deepEqual(options, { projectTrusted: false });
      return { getCompactionSettings(m) { assert.equal(m, model); return { keepRecentTokens: 0, reserveTokens: 4096 }; } };
    } },
    async generateSummaryWithUsage(...args) {
      assert.deepEqual(args[0], entries[0].messages);
      assert.equal(args[2], 4096); assert.equal(args[5], signal);
      assert.equal(args[6], "Keep tests"); assert.equal(args[8], "low");
      assert.equal(args[13], "session");
      assert.equal(args[9](model, "context", { signal }), "stream");
      return { text: "Summary", usage: { totalTokens: 12 } };
    },
  };
  const result = await summarizeCompactNextBoundary({ context: { contextEntries: entries }, messageEntryId: "e1" }, ctx, { customInstructions: "Keep tests" }, signal, host);
  assert.deepEqual(result, { type: "compaction", summary: "Summary", firstKeptEntryId: "e1", usage: { totalTokens: 12 }, details: { source: "compact-next" } });
  assert.equal(calls.length, 1);
});
test("system-only and context-invisible metadata are not summarized", () => {
  const entries = projected(["system", "user", "assistant", "toolResult"]);
  entries.splice(2, 0, { sourceEntry: { id: "omitted", type: "context_edit" }, messages: [] });
  const prefix = selectCompactNextPrefix(entries, 1, () => 1, "e2");
  assert.deepEqual(prefix.messages.map(x => x.role), ["user"]);
  assert.equal(prefix.firstKeptEntryId, "e2");
});
