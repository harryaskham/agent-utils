// /cd DIR for TUI Pi (bd-aa5717).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCdCommand, directoryNote, resolveDirectory } from "../extensions/lib/cd.js";

/** Pi's SessionManager as far as /cd uses it: records what is written. */
function fakePi() {
  const created = [];
  class SessionManager {
    static create(cwd, sessionDir, options) {
      const manager = { cwd, options, entries: [], file: join(cwd, ".session.jsonl") };
      manager.appendModelChange = (provider, modelId) => manager.entries.push({ type: "model_change", provider, modelId });
      manager.appendThinkingLevelChange = (level) => manager.entries.push({ type: "thinking", level });
      manager.appendSessionInfo = (name) => manager.entries.push({ type: "name", name });
      manager.appendMessage = (message) => manager.entries.push({ type: "message", message });
      manager.getSessionFile = () => manager.file;
      created.push(manager);
      return manager;
    }
  }
  const convertToLlm = (messages) => messages.map((message) => ({ role: "user", content: [{ type: "text", text: `converted ${message.role}` }] }));
  return { created, SessionManager, convertToLlm };
}

// extensions/cd.js registers this with Pi's own SessionManager and convertToLlm.
const command = (pi) => createCdCommand(pi);

test("/cd writes the conversation into a new session in the directory and switches to it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sub = join(root, "sub");
  mkdirSync(sub);
  const pi = fakePi();
  const notices = [];
  let switched;
  const cd = command(pi);
  await cd.handler("sub", {
    cwd: root,
    waitForIdle: async () => {},
    ui: { notify: (text, level) => notices.push([level, text]) },
    sessionManager: {
      getSessionFile: () => join(root, "old.jsonl"),
      getSessionName: () => "Parser work",
      buildSessionContext: () => ({
        model: { provider: "p", modelId: "m" },
        thinkingLevel: "high",
        messages: [
          { role: "compactionSummary", summary: "earlier" },
          { role: "user", content: "first" },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "bashExecution", command: "ls", output: "a" },
        ],
      }),
    },
    switchSession: async (file, options) => {
      switched = file;
      await options.withSession({ ui: { notify: (text, level) => notices.push([level, text]) } });
      return { cancelled: false };
    },
  });
  const [next] = pi.created;
  assert.equal(next.cwd, sub);
  assert.deepEqual(next.options, { parentSession: join(root, "old.jsonl") });
  assert.deepEqual(next.entries.slice(0, 3), [
    { type: "model_change", provider: "p", modelId: "m" },
    { type: "thinking", level: "high" },
    { type: "name", name: "Parser work" },
  ]);
  const messages = next.entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
  assert.deepEqual(messages.map((message) => message.role), ["user", "user", "assistant", "bashExecution", "user"]);
  assert.equal(messages[0].content[0].text, "converted compactionSummary");
  assert.equal(messages.at(-1).content[0].text, directoryNote(root, sub));
  assert.equal(switched, next.file);
  assert.deepEqual(notices, [["info", `Now in ${sub} (4 messages carried over)`]]);
});

test("/cd refuses a missing directory and the current one, and explains itself without one", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pi = fakePi();
  const notices = [];
  let switched = false;
  const ctx = {
    cwd: root,
    waitForIdle: async () => {},
    ui: { notify: (text, level) => notices.push([level, text]) },
    sessionManager: { buildSessionContext: () => ({ messages: [] }) },
    switchSession: async () => {
      switched = true;
      return { cancelled: false };
    },
  };
  const cd = command(pi);
  await cd.handler("missing", ctx);
  await cd.handler(".", ctx);
  await cd.handler("", ctx);
  assert.equal(switched, false);
  assert.match(notices[0][1], /missing is not a directory/);
  assert.match(notices[1][1], /already in/);
  assert.match(notices[2][1], /^\/cd DIR/);
  assert.equal(resolveDirectory("/a", "~/x", "/home/u"), "/home/u/x");
});
