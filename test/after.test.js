import test from "node:test";
import assert from "node:assert/strict";

import { createAfterExtension } from "../extensions/after.js";
import {
  AFTER_ENTRY_TYPE,
  parseAfterCommand,
  parseAfterDuration,
  restoreAfterRecords,
} from "../extensions/lib/after.js";

function harness({ entries = [], start = 1_000 } = {}) {
  let clock = start;
  let id = 0;
  const jobs = [];
  const appended = [];
  const sent = [];
  const notifications = [];
  const compactCalls = [];
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerCommand(name, def) { commands.set(name, def); },
    on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); },
    appendEntry(customType, data) { appended.push({ type: "custom", customType, data }); },
    sendUserMessage(text, options) { sent.push({ text, options }); },
  };
  const ctx = {
    sessionManager: { getBranch: () => [...entries, ...appended] },
    compact(options) { compactCalls.push(options); },
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  };
  const extension = createAfterExtension({
    now: () => clock,
    makeId: () => `after-test-${++id}`,
    setTimer(fn, ms) { const job = { fn, ms, cancelled: false, unref() {} }; jobs.push(job); return job; },
    clearTimer(job) { if (job) job.cancelled = true; },
  });
  extension(pi);
  const emit = async (name, event = {}) => {
    for (const fn of handlers.get(name) || []) await fn(event, ctx);
  };
  return {
    pi, ctx, commands, handlers, appended, sent, notifications, compactCalls, jobs, emit,
    setClock(value) { clock = value; },
    async run(job = jobs.find((item) => !item.cancelled)) { assert.ok(job); job.fn(); await Promise.resolve(); await Promise.resolve(); },
  };
}

test("/after parses bounded ms/s/m/h durations and command forms", () => {
  assert.equal(parseAfterDuration("120s"), 120_000);
  assert.equal(parseAfterDuration("10m"), 600_000);
  assert.equal(parseAfterDuration("1.5h"), 5_400_000);
  assert.deepEqual(parseAfterCommand("10m check later"), { action: "schedule", delayMs: 600_000, payload: "check later" });
  assert.deepEqual(parseAfterCommand("cancel all"), { action: "cancel", id: "all" });
  assert.throws(() => parseAfterDuration("10"), /followed by/);
  assert.throws(() => parseAfterDuration("31d"), /followed by/);
});

test("delayed prompts and extension slash commands deliver once as follow-ups", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.commands.get("after").handler("10s Check deployment", h.ctx);
  assert.equal(h.jobs[0].ms, 10_000);
  await h.run(h.jobs[0]);
  assert.deepEqual(h.sent[0], { text: "Check deployment", options: { deliverAs: "followUp", expandPromptTemplates: false } });
  assert.equal(h.appended.at(-1).data.status, "delivered");

  await h.commands.get("after").handler("120s /choice Continue? | Yes | Stop", h.ctx);
  await h.run(h.jobs.find((job) => !job.cancelled));
  assert.equal(h.sent.at(-1).text, "/choice Continue? | Yes | Stop");
  assert.equal(h.sent.at(-1).options.expandPromptTemplates, true);
});

test("delayed /compact uses Pi's direct compaction surface", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.commands.get("after").handler("10ms /compact Focus on tests", h.ctx);
  await h.run();
  assert.equal(h.compactCalls.length, 1);
  assert.equal(h.compactCalls[0].customInstructions, "Focus on tests");
  assert.equal(h.sent.length, 0);
});

test("scheduled entries restore after reload, overdue timers fire promptly, and delivering fences do not replay", async () => {
  const scheduled = {
    type: "custom", customType: AFTER_ENTRY_TYPE,
    data: { version: 1, id: "after-restored", status: "scheduled", createdAt: 1, dueAt: 500, payload: "restored" },
  };
  const h = harness({ entries: [scheduled], start: 1_000 });
  await h.emit("session_start");
  assert.equal(h.jobs[0].ms, 0);
  await h.run();
  assert.equal(h.sent[0].text, "restored");

  const fenced = harness({ entries: [{ ...scheduled, data: { ...scheduled.data, id: "after-fenced", status: "delivering" } }] });
  await fenced.emit("session_start");
  assert.equal(fenced.jobs.length, 0, "an indeterminate delivery is never duplicated after restart");
});

test("status and cancellation append terminal receipts and clear runtime timers", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.commands.get("after").handler("1m one", h.ctx);
  await h.commands.get("after").handler("2m two", h.ctx);
  await h.commands.get("after").handler("status", h.ctx);
  assert.match(h.notifications.at(-1).message, /after-test-1/);
  await h.commands.get("after").handler("cancel all", h.ctx);
  assert.equal(h.appended.filter((entry) => entry.data.status === "cancelled").length, 2);
  assert.ok(h.jobs.every((job) => job.cancelled));
});

test("restoreAfterRecords applies the latest durable state per timer id", () => {
  const records = restoreAfterRecords([
    { type: "custom", customType: AFTER_ENTRY_TYPE, data: { id: "a", status: "scheduled" } },
    { type: "custom", customType: "other", data: { id: "ignored", status: "scheduled" } },
    { type: "custom", customType: AFTER_ENTRY_TYPE, data: { id: "a", status: "cancelled" } },
  ]);
  assert.equal(records.get("a").status, "cancelled");
  assert.equal(records.has("ignored"), false);
});
