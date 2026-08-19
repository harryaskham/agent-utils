import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import scrubExtension, {
  sanitizeMessage,
  sanitizeSessionEntry,
  scrubSessionFile,
  undoScrubFile,
  inspectSessionFile,
  undoPathFor,
  listArchivedUndos,
} from "../extensions/scrub.js";

function makeHarness() {
  const tools = new Map();
  const commands = new Map();
  const notifications = [];

  const pi = {
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  };

  const createCtx = (sessionFilePath, entries = []) => ({
    hasUI: false,
    ui: {
      notify(msg, level) {
        notifications.push({ msg, level });
      },
    },
    sessionManager: {
      getSessionFile() {
        return sessionFilePath;
      },
      getEntries() {
        return entries;
      },
    },
  });

  return { pi, tools, commands, notifications, createCtx };
}

test("sanitizeMessage strips thinkingSignature, textSignature, thoughtSignature, and pipes in tool IDs", () => {
  const assistantMsg = {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "Let me think...",
        thinkingSignature: '{"type":"reasoning","id":"rs_123"}',
      },
      {
        type: "text",
        text: "Here is the plan.",
        textSignature: "msg_456",
      },
      {
        type: "toolCall",
        id: "call_abc|fc_item_789",
        name: "bash",
        arguments: { command: "ls" },
        thoughtSignature: "thought_sig_000",
      },
    ],
  };

  const res = sanitizeMessage(assistantMsg);
  assert.equal(res.changed, true);
  assert.equal(res.stats.thinkingSignatures, 1);
  assert.equal(res.stats.textSignatures, 1);
  assert.equal(res.stats.thoughtSignatures, 1);
  assert.equal(res.stats.toolCallIds, 1);

  assert.equal(assistantMsg.content[0].thinkingSignature, undefined);
  assert.equal(assistantMsg.content[1].textSignature, undefined);
  assert.equal(assistantMsg.content[2].thoughtSignature, undefined);
  assert.equal(assistantMsg.content[2].id, "call_abc");
});

test("sanitizeMessage cleans toolResult toolCallId with pipe", () => {
  const toolResultMsg = {
    role: "toolResult",
    toolCallId: "call_abc|fc_item_789",
    content: [{ type: "text", text: "file.txt" }],
  };

  const res = sanitizeMessage(toolResultMsg);
  assert.equal(res.changed, true);
  assert.equal(res.stats.toolCallIds, 1);
  assert.equal(toolResultMsg.toolCallId, "call_abc");
});

test("sanitizeSessionEntry cleans compactions with retainedTail", () => {
  const compactionEntry = {
    type: "compaction",
    summary: "Earlier stuff",
    retainedTail: [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            textSignature: "sig_abc",
          },
        ],
      },
    ],
  };

  const res = sanitizeSessionEntry(compactionEntry);
  assert.equal(res.changed, true);
  assert.equal(res.stats.textSignatures, 1);
  assert.equal(compactionEntry.retainedTail[0].content[0].textSignature, undefined);
});

test("scrubSessionFile scrubs file on disk, creates undo, is idempotent, and preserves undo file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scrub-test-"));
  const sessionFile = path.join(tmpDir, "test-session.jsonl");

  const originalLines = [
    JSON.stringify({ type: "session", version: 3, id: "sess-1", cwd: "/home/user/repo" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "ponder", thinkingSignature: "rs_999" },
          { type: "toolCall", id: "call_1|fc_2", name: "read", arguments: {} },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      message: {
        role: "toolResult",
        toolCallId: "call_1|fc_2",
        content: [{ type: "text", text: "ok" }],
      },
    }),
  ];

  fs.writeFileSync(sessionFile, originalLines.join("\n") + "\n");

  // 1. Initial inspect
  const inspect1 = inspectSessionFile(sessionFile);
  assert.equal(inspect1.clean, false);
  assert.equal(inspect1.stats.entriesNeedingScrub, 2);
  assert.equal(inspect1.stats.thinkingSignatures, 1);
  assert.equal(inspect1.stats.toolCallIds, 2);

  // 2. First scrub
  const scrub1 = scrubSessionFile(sessionFile);
  assert.equal(scrub1.ok, true);
  assert.equal(scrub1.changed, true);
  assert.ok(fs.existsSync(undoPathFor(sessionFile)), "Undo file must exist after first scrub");
  const undoContent1 = fs.readFileSync(undoPathFor(sessionFile), "utf8");
  assert.match(undoContent1, /rs_999/);
  assert.match(undoContent1, /call_1\|fc_2/);

  // 3. Inspect after scrub
  const inspect2 = inspectSessionFile(sessionFile);
  assert.equal(inspect2.clean, true);
  assert.equal(inspect2.hasUndo, true);

  // 4. Idempotency test: scrub again when already clean
  const scrub2 = scrubSessionFile(sessionFile);
  assert.equal(scrub2.ok, true);
  assert.equal(scrub2.changed, false);
  // Must NOT overwrite the undo backup with the clean file!
  const undoContent2 = fs.readFileSync(undoPathFor(sessionFile), "utf8");
  assert.equal(undoContent2, undoContent1, "Undo file must not be overwritten when scrub is a no-op");

  // 5. Undo test
  const undoRes = undoScrubFile(sessionFile);
  assert.equal(undoRes.ok, true);
  assert.equal(fs.existsSync(undoPathFor(sessionFile)), false, "Undo file removed after restore");

  const restoredInspect = inspectSessionFile(sessionFile);
  assert.equal(restoredInspect.clean, false);
  assert.equal(restoredInspect.stats.entriesNeedingScrub, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("registers /scrub command and scrub_session tool with undo, status, and scrub handlers", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scrub-ext-test-"));
  const sessionFile = path.join(tmpDir, "ext-session.jsonl");

  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "message",
      id: "m1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello", textSignature: "sig_123" }],
      },
    }) + "\n"
  );

  const h = makeHarness();
  scrubExtension(h.pi);

  assert.ok(h.commands.has("scrub"));
  assert.ok(h.tools.has("scrub_session"));

  const ctx = h.createCtx(sessionFile);

  // Status via slash command
  await h.commands.get("scrub").handler("status", ctx);
  assert.ok(h.notifications.some((n) => n.msg.includes("Session has stale signatures: 1 entries")));

  // Scrub via tool
  const tool = h.tools.get("scrub_session");
  const toolResult = await tool.execute("call-1", { action: "scrub" }, null, null, ctx);
  assert.equal(toolResult.details.ok, true);
  assert.equal(toolResult.details.changed, true);

  // Status via tool
  const statusResult = await tool.execute("call-2", { action: "status" }, null, null, ctx);
  assert.equal(statusResult.details.clean, true);
  assert.equal(statusResult.details.hasUndo, true);

  // Undo via slash command
  await h.commands.get("scrub").handler("undo", ctx);
  assert.ok(h.notifications.some((n) => n.msg.includes("Restored session")));

  // Verify restored
  const inspectAfterUndo = inspectSessionFile(sessionFile);
  assert.equal(inspectAfterUndo.clean, false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function dirtyLine(id, sig) {
  return JSON.stringify({
    type: "message",
    id,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `turn ${id}`, textSignature: sig }],
    },
  });
}

test("a real second scrub rotates the old undo instead of overwriting it", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scrub-rotate-"));
  const sessionFile = path.join(tmpDir, "s.jsonl");

  fs.writeFileSync(sessionFile, dirtyLine("m1", "sig_first") + "\n");
  const first = scrubSessionFile(sessionFile, { now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(first.changed, true);
  assert.equal(first.archivedUndoPath, null, "nothing to archive on the first scrub");

  const firstUndo = fs.readFileSync(undoPathFor(sessionFile), "utf8");
  assert.match(firstUndo, /sig_first/);

  // New dirty turns arrive after the first scrub, then we scrub again.
  fs.appendFileSync(sessionFile, dirtyLine("m2", "sig_second") + "\n");
  const second = scrubSessionFile(sessionFile, { now: new Date("2026-01-02T00:00:00Z") });
  assert.equal(second.changed, true);
  assert.ok(second.archivedUndoPath, "second real scrub must archive the prior undo");

  // The original undo content survives, untouched, under the archive path.
  const archived = fs.readFileSync(second.archivedUndoPath, "utf8");
  assert.equal(archived, firstUndo, "prior undo content must be preserved verbatim");

  // The current undo is the state immediately before the second scrub.
  const currentUndo = fs.readFileSync(undoPathFor(sessionFile), "utf8");
  assert.match(currentUndo, /sig_second/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("repeated no-op scrubs never touch the session file or the undo backup", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scrub-idem-"));
  const sessionFile = path.join(tmpDir, "s.jsonl");

  fs.writeFileSync(sessionFile, dirtyLine("m1", "sig_only") + "\n");
  scrubSessionFile(sessionFile);

  const undoBefore = fs.readFileSync(undoPathFor(sessionFile), "utf8");
  const sessionBefore = fs.readFileSync(sessionFile, "utf8");

  for (let i = 0; i < 3; i++) {
    const res = scrubSessionFile(sessionFile);
    assert.equal(res.changed, false, "no-op scrub reports no change");
  }

  assert.equal(fs.readFileSync(undoPathFor(sessionFile), "utf8"), undoBefore, "undo untouched");
  assert.equal(fs.readFileSync(sessionFile, "utf8"), sessionBefore, "session untouched");
  assert.equal(listArchivedUndos(sessionFile).length, 0, "no-op scrubs create no archives");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("undo pops the scrub stack, promoting the next archived backup", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scrub-stack-"));
  const sessionFile = path.join(tmpDir, "s.jsonl");

  fs.writeFileSync(sessionFile, dirtyLine("m1", "sig_first") + "\n");
  scrubSessionFile(sessionFile, { now: new Date("2026-01-01T00:00:00Z") });

  fs.appendFileSync(sessionFile, dirtyLine("m2", "sig_second") + "\n");
  scrubSessionFile(sessionFile, { now: new Date("2026-01-02T00:00:00Z") });

  assert.equal(listArchivedUndos(sessionFile).length, 1);

  // First undo restores the pre-second-scrub state and promotes the archive.
  const undo1 = undoScrubFile(sessionFile);
  assert.equal(undo1.ok, true);
  assert.ok(undo1.promotedFrom, "next archive promoted to the active undo slot");
  assert.match(fs.readFileSync(sessionFile, "utf8"), /sig_second/);
  assert.equal(listArchivedUndos(sessionFile).length, 0);
  assert.ok(fs.existsSync(undoPathFor(sessionFile)), "an undo step remains available");

  // Second undo walks back to the original pre-first-scrub state.
  const undo2 = undoScrubFile(sessionFile);
  assert.equal(undo2.ok, true);
  assert.equal(undo2.promotedFrom, null);
  assert.match(fs.readFileSync(sessionFile, "utf8"), /sig_first/);
  assert.equal(fs.existsSync(undoPathFor(sessionFile)), false, "stack is now empty");

  // Third undo has nothing left to restore.
  const undo3 = undoScrubFile(sessionFile);
  assert.equal(undo3.ok, false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("scrubbing a clean session is a pure no-op that still reports an available undo", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scrub-clean-"));
  const sessionFile = path.join(tmpDir, "s.jsonl");

  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "assistant", content: [{ type: "text", text: "already clean" }] },
    }) + "\n"
  );

  const res = scrubSessionFile(sessionFile);
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
  assert.equal(res.undoPath, null, "no undo is invented for a session that never needed scrubbing");
  assert.equal(fs.existsSync(undoPathFor(sessionFile)), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
