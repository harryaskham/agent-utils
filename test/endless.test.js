import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ENDLESS_DELAY_SECONDS,
  DEFAULT_ENDLESS_MESSAGE,
  createEndlessExtension,
  parseEndlessArgs,
  resolveEndlessSettings,
} from "../extensions/endless.js";

function harness({ persistedSettings, env = {} } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const sent = [];
  const notifications = [];
  const statuses = new Map();
  const jobs = [];
  const setTimer = (fn, ms) => { const job = { fn, ms, cancelled: false }; jobs.push(job); return job; };
  const clearTimer = (job) => { if (job) job.cancelled = true; };
  const pi = {
    registerCommand(name, def) { commands.set(name, def); },
    on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); },
    sendUserMessage(text) { sent.push(text); },
  };
  const compactions = [];
  const ctx = {
    ui: {
      notify(message, level = "info") { notifications.push({ message, level }); },
      setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
    },
    compact(options) { compactions.push(options); },
  };
  createEndlessExtension({ env, persistedSettings, setTimer, clearTimer })(pi);
  const emit = (name, event = {}) => { for (const fn of handlers.get(name) || []) fn(event, ctx); };
  const runNext = () => {
    const job = jobs.find((candidate) => !candidate.cancelled);
    assert.ok(job, "a live timer is scheduled");
    job.cancelled = true;
    job.fn();
    return job;
  };
  return { commands, handlers, sent, notifications, statuses, jobs, compactions, ctx, emit, runNext };
}

test("endless settings resolve documented defaults and env precedence", () => {
  assert.deepEqual(resolveEndlessSettings({ env: {}, persisted: {} }), {
    defaultMessage: DEFAULT_ENDLESS_MESSAGE,
    delay: DEFAULT_ENDLESS_DELAY_SECONDS,
  });
  assert.deepEqual(resolveEndlessSettings({
    env: { PI_ENDLESS_DEFAULT_MESSAGE: "env message", PI_ENDLESS_DELAY: "2.5" },
    persisted: { defaultMessage: "stored", delay: 20 },
  }), { defaultMessage: "env message", delay: 2.5 });
});

test("/endless args accept free text and flags in any order", () => {
  const defaults = { defaultMessage: DEFAULT_ENDLESS_MESSAGE, delay: 60 };
  assert.deepEqual(parseEndlessArgs("keep going", { env: {}, defaults }), { action: "on", message: "keep going", delay: 60, compact: false });
  assert.deepEqual(parseEndlessArgs("compact=true keep going delay=3", { env: {}, defaults }), { action: "on", message: "keep going", delay: 3, compact: true });
  assert.deepEqual(parseEndlessArgs("delay=1 task=x", { env: {}, defaults }), { action: "on", message: "task=x", delay: 1, compact: false });
  assert.deepEqual(parseEndlessArgs("", { env: {}, defaults }), { action: "on", message: DEFAULT_ENDLESS_MESSAGE, delay: 60, compact: false });
  assert.equal(parseEndlessArgs("off delay=2", { env: {}, defaults }).action, "off");
  assert.throws(() => parseEndlessArgs("compact=maybe", { env: {}, defaults }), /compact must be true or false/);
});

test("/endless schedules on enable and every true agent settlement, then stops cleanly", async () => {
  const h = harness({ persistedSettings: { defaultMessage: "stored default", delay: 9 } });
  assert.ok(h.commands.has("endless"));
  await h.commands.get("endless").handler("delay=2 keep going", h.ctx);
  assert.equal(h.jobs.filter((job) => !job.cancelled).length, 1);
  const first = h.runNext();
  assert.equal(first.ms, 2000);
  assert.deepEqual(h.sent, ["keep going"]);

  h.emit("agent_settled");
  h.emit("agent_settled");
  assert.equal(h.jobs.filter((job) => !job.cancelled).length, 1, "duplicate settled events cannot schedule duplicate resumes");
  h.runNext();
  assert.deepEqual(h.sent, ["keep going", "keep going"]);

  h.emit("agent_settled");
  const pending = h.jobs.find((job) => !job.cancelled);
  await h.commands.get("endless").handler("off", h.ctx);
  assert.equal(pending.cancelled, true);
  h.emit("agent_settled");
  assert.equal(h.jobs.filter((job) => !job.cancelled).length, 0);
  assert.equal(h.statuses.has("agent-utils-endless"), false);
});

test("compact=true delivers only from compaction completion", async () => {
  const h = harness();
  await h.commands.get("endless").handler("message after compact compact=true delay=0", h.ctx);
  const timer = h.runNext();
  assert.equal(timer.ms, 0);
  assert.equal(h.compactions.length, 1);
  assert.deepEqual(h.sent, [], "resume is queued behind compaction completion");
  h.compactions[0].onComplete({});
  assert.deepEqual(h.sent, ["message after compact"]);
});

test("session shutdown invalidates pending resume and compaction callbacks", async () => {
  const h = harness();
  await h.commands.get("endless").handler("compact=true delay=0 keep going", h.ctx);
  h.runNext();
  assert.equal(h.compactions.length, 1);
  h.emit("session_shutdown");
  h.compactions[0].onComplete({});
  assert.deepEqual(h.sent, []);
});
