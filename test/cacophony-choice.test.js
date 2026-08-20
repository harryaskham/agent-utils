import test from "node:test";
import assert from "node:assert/strict";

import { createCacophonyChoiceBridge, resolveCacophonyChoiceConfig } from "../extensions/lib/cacophony-choice.js";

function fakeExec(responses, calls) {
  return (_command, args, _options, callback) => {
    calls.push(args);
    const response = responses.shift();
    queueMicrotask(() => response instanceof Error
      ? callback(response, "", response.message)
      : callback(null, JSON.stringify(response), ""));
  };
}

function timers() {
  const jobs = [];
  return {
    jobs,
    setTimer(fn, ms) { const job = { fn, ms, cleared: false, unref() {} }; jobs.push(job); return job; },
    clearTimer(job) { if (job) job.cleared = true; },
    async runNext() { const job = jobs.find((item) => !item.cleared); assert.ok(job); job.cleared = true; await job.fn(); await new Promise((resolve) => setImmediate(resolve)); return job; },
  };
}

test("Cacophony bridge auto-discovers managed agent identity and can be disabled", () => {
  assert.deepEqual(resolveCacophonyChoiceConfig({ CACO_AGENT_ID: "a", CACO_PROJECT: "p" }, {}).enabled, true);
  assert.equal(resolveCacophonyChoiceConfig({ CACOPHONY_AGENT: "a", CACOPHONY_PROJECT: "p", PI_CHOICE_CACO_ENABLED: "0" }, {}).enabled, false);
  assert.equal(resolveCacophonyChoiceConfig({}, {}).enabled, false);
});

test("Cacophony resolution selects the matching Pi choice", async () => {
  const calls = [];
  const clock = timers();
  const resolutions = [];
  const bridge = createCacophonyChoiceBridge({
    env: { CACO_AGENT_ID: "agent-1", CACO_PROJECT: "project-1", CACO_BIN: "caco-test" },
    execFileImpl: fakeExec([
      { data: { choice_id: "choice-1" } },
      { data: { found: true, status: "resolved", resolution: { selected_index: 1, selected_label: "Beta" } } },
    ], calls),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  bridge.start({ question: "Pick", choices: [{ label: "a", headline: "Alpha" }, { label: "b", headline: "Beta", summary: "second" }], onResolution: (r) => resolutions.push(r) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[0].slice(0, 2), ["choices", "present"]);
  assert.ok(calls[0].includes("--notify-mode=direct-message"), "Pi owns speech; Cacophony uses a silent notification mode");
  assert.equal(JSON.parse(calls[0][calls[0].indexOf("--choices") + 1])[1].label, "Beta");
  assert.equal(clock.jobs[0].ms, 2000);
  await clock.runNext();
  assert.deepEqual(resolutions, [{ status: "selected", index: 1, label: "Beta", source: "cacophony" }]);
});

test("local Pi selection resolves the durable Cacophony choice", async () => {
  const calls = [];
  const clock = timers();
  const bridge = createCacophonyChoiceBridge({
    env: { CACO_AGENT_ID: "agent-1", CACO_PROJECT: "project-1" },
    execFileImpl: fakeExec([
      { data: { choice_id: "choice-2" } },
      { data: { resolved: true, selected_label: "Alpha" } },
    ], calls),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const handle = bridge.start({ question: "Pick", choices: [{ label: "a", headline: "Alpha" }, { label: "b", headline: "Beta" }] });
  await new Promise((resolve) => setImmediate(resolve));
  await handle.settleLocal({ status: "selected", index: 0, source: "keyboard" });
  assert.deepEqual(calls[1].slice(0, 4), ["choices", "resolve", "--choice-id", "choice-2"]);
  assert.ok(calls[1].includes("--selected-index"));
  assert.equal(calls[1][calls[1].indexOf("--selected-index") + 1], "0");
});

test("local cancellation discards the mirrored choice and presentation races settle", async () => {
  const calls = [];
  let presentCallback;
  const execFileImpl = (_command, args, _options, callback) => {
    calls.push(args);
    if (args[1] === "present") presentCallback = callback;
    else queueMicrotask(() => callback(null, JSON.stringify({ data: { discarded: true } }), ""));
  };
  const bridge = createCacophonyChoiceBridge({ env: { CACO_AGENT_ID: "a", CACO_PROJECT: "p" }, execFileImpl });
  const handle = bridge.start({ question: "Pick", choices: [{ label: "a" }, { label: "b" }] });
  void handle.settleLocal({ status: "cancelled", reason: "escape" });
  presentCallback(null, JSON.stringify({ data: { choice_id: "choice-late" } }), "");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[1].slice(0, 4), ["choices", "discard", "--choice-id", "choice-late"]);
});
