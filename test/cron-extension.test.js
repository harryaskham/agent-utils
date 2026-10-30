// TUI /cron (extensions/cron.js): one timer per schedule, to its next occurrence; delivery as
// /after's (/compact compacts, another /command runs, else a prompt); restored with the session.
import test from "node:test";
import assert from "node:assert/strict";

import { CRON_ENTRY_TYPE, createCronExtension } from "../extensions/cron.js";

function harness(start) {
  let clock = start;
  const jobs = [];
  const commands = new Map();
  const handlers = new Map();
  const sent = [];
  const compacts = [];
  const notices = [];
  const appended = [];
  const pi = {
    registerCommand(name, def) { commands.set(name, def); },
    on(event, handler) { handlers.set(event, handler); },
    appendEntry(customType, data) { appended.push({ type: "custom", customType, data }); },
    sendUserMessage(text, options) { sent.push({ text, options }); },
  };
  const ctx = {
    ui: { notify: (text) => notices.push(text) },
    compact: (options) => compacts.push(options),
    sessionManager: { getEntries: () => appended },
  };
  createCronExtension({
    now: () => clock,
    setTimer(fn, ms) { const job = { fn, ms, at: clock + ms, cancelled: false, unref() {} }; jobs.push(job); return job; },
    clearTimer(job) { job.cancelled = true; },
    defaultTimeZone: "UTC",
  })(pi);
  handlers.get("session_start")({}, ctx);
  const live = () => jobs.filter((job) => !job.cancelled && !job.done);
  // Run the due timers, up to `until`.
  const advance = (until) => {
    for (;;) {
      const due = live().filter((job) => job.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      clock = due.at;
      due.done = true;
      due.fn();
    }
    clock = until;
  };
  return { commands, handlers, ctx, sent, compacts, notices, appended, jobs, live, advance, run: (args) => commands.get("cron").handler(args, ctx) };
}

test("/cron delivers on its schedule, one timer at a time; /compact compacts; stop ends it", async () => {
  const start = Date.parse("2026-10-30T10:02:00Z");
  const h = harness(start);
  await h.run("*/5 * * * * say hi");
  assert.match(h.notices.at(-1), /^\/cron #1: \*\/5 \* \* \* \* \(UTC\), next in 3m/);
  assert.equal(h.live().length, 1, "one timer");
  assert.equal(h.live()[0].at, Date.parse("2026-10-30T10:05:00Z"));

  h.advance(Date.parse("2026-10-30T10:11:00Z"));
  assert.deepEqual(h.sent.map((s) => [s.text, s.options.deliverAs, s.options.expandPromptTemplates]), [["say hi", "followUp", false], ["say hi", "followUp", false]]);
  assert.equal(h.live().length, 1, "still one timer, for 10:15");
  assert.equal(h.live()[0].at, Date.parse("2026-10-30T10:15:00Z"));

  await h.run("'0 12 * * *' tz=Europe/London /compact keep the plan");
  await h.run("@hourly /review");
  h.advance(Date.parse("2026-10-30T12:00:00Z"));
  assert.deepEqual(h.compacts.map((c) => c.customInstructions), ["keep the plan"], "/compact compacts");
  assert.ok(h.sent.some((s) => s.text === "/review" && s.options.expandPromptTemplates === true), "a command runs as one");

  await h.run("list");
  assert.match(h.notices.at(-1), /#1: \*\/5 \* \* \* \* \(UTC\), next in \d+m — say hi\n#2: 0 12 \* \* \* \(Europe\/London\)/);
  await h.run("stop 1");
  assert.equal(h.live().length, 2);
  const before = h.sent.filter((s) => s.text === "say hi").length;
  h.advance(Date.parse("2026-10-30T12:30:00Z"));
  assert.equal(h.sent.filter((s) => s.text === "say hi").length, before, "stopped");
  await h.run("bad x y z w say");
  assert.match(h.notices.at(-1), /cron minute: "bad" is not a number/);
});

test("/cron comes back with the session; an occurrence missed meanwhile runs once", async () => {
  const start = Date.parse("2026-10-30T10:00:00Z");
  const first = harness(start);
  await first.run("0 * * * * hourly check");
  first.handlers.get("session_shutdown")();
  assert.equal(first.live().length, 0, "no timers once closed");

  // Reopened at 13:30: the 11:00, 12:00 and 13:00 runs were missed; it runs once now, then 14:00.
  const later = harness(Date.parse("2026-10-30T13:30:00Z"));
  later.appended.push(...first.appended.filter((entry) => entry.customType === CRON_ENTRY_TYPE));
  later.handlers.get("session_start")({}, later.ctx);
  later.advance(Date.parse("2026-10-30T13:30:00Z"));
  assert.deepEqual(later.sent.map((s) => s.text), ["hourly check"]);
  assert.equal(later.live()[0].at, Date.parse("2026-10-30T14:00:00Z"));
});
