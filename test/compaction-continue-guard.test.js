import assert from "node:assert/strict";
import test from "node:test";

import compactionContinueGuardExtension, { buildCompactionContinueBoundary } from "../extensions/compaction-continue-guard.js";

function withEnv(name, value, fn) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  }
}

test("compaction continue boundary is a hidden custom checkpoint", () => {
  const boundary = buildCompactionContinueBoundary({
    compactionEntry: { id: "cmp-1", firstKeptEntryId: "entry-7" },
    fromExtension: true,
  });

  assert.equal(boundary.customType, "agent-utils.compaction-continue-boundary");
  assert.equal(boundary.display, false);
  assert.match(boundary.content, /Post-compaction continuation checkpoint/);
  assert.match(boundary.content, /continue the interrupted or most recent user request/);
  assert.deepEqual(boundary.details, {
    compactionEntryId: "cmp-1",
    firstKeptEntryId: "entry-7",
    fromExtension: true,
    purpose: "avoid-assistant-role-continuation-boundary",
  });
});

test("extension appends a custom user-role checkpoint after compaction", async () => {
  const handlers = new Map();
  const sent = [];
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    sendMessage(message, options) { sent.push({ message, options }); },
  };

  withEnv("PI_COMPACTION_CONTINUE_GUARD", undefined, () => compactionContinueGuardExtension(pi));
  assert.equal(typeof handlers.get("session_compact"), "function");

  await handlers.get("session_compact")({ compactionEntry: { id: "cmp-2", firstKeptEntryId: "keep-1" }, fromExtension: false });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].options, undefined, "no triggerTurn: checkpoint is appended without starting a new turn");
  assert.equal(sent[0].message.display, false);
  assert.equal(sent[0].message.details.compactionEntryId, "cmp-2");
});

test("extension can be disabled with PI_COMPACTION_CONTINUE_GUARD=0", () => {
  const handlers = new Map();
  const pi = { on(event, handler) { handlers.set(event, handler); } };

  withEnv("PI_COMPACTION_CONTINUE_GUARD", "0", () => compactionContinueGuardExtension(pi));

  assert.equal(handlers.has("session_compact"), false);
});

test("package advertises compaction continue guard extension", async () => {
  const pkg = await import("../package.json", { with: { type: "json" } });
  assert.ok(pkg.default.pi.extensions.includes("./extensions/compaction-continue-guard.js"));
});
