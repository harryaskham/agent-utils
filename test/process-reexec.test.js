import test from "node:test";
import assert from "node:assert/strict";
import { resolveProcessExecve } from "../extensions/lib/process-reexec.js";

test("Node native execve is preferred and bound to its runtime", async () => {
  const calls = [];
  const runtime = { execve(...args) { assert.equal(this, runtime); calls.push(args); } };
  const execve = await resolveProcessExecve({ runtime, loadFfi: () => { throw new Error("unused"); } });
  execve("/bin/pi", ["pi", "two words"], { A: "value" });
  assert.deepEqual(calls, [["/bin/pi", ["pi", "two words"], { A: "value" }]]);
});

test("unsupported runtimes fail before any child can be spawned", async () => {
  await assert.rejects(resolveProcessExecve({ runtime: { versions: {}, platform: "linux" } }), /cannot safely restart/);
});

test("Bun execve builds null-terminated argv/env vectors without shell quoting", async () => {
  const memory = new Map();
  const ptr = value => { const id = memory.size + 1; memory.set(id, value); return id; };
  const text = address => memory.get(Number(address)).toString().replace(/\0$/, "");
  const vector = address => Array.from(memory.get(Number(address))).filter(Boolean).map(text);
  let closed = false;
  const execve = await resolveProcessExecve({
    runtime: { versions: { bun: "1.3.13" }, platform: "darwin" },
    loadFfi: async () => ({ ptr, dlopen: (path, definitions) => {
      assert.equal(path, "/usr/lib/libSystem.B.dylib");
      assert.deepEqual(definitions.execve.args, ["ptr", "ptr", "ptr"]);
      return { close() { closed = true; }, symbols: { execve(file, args, env) {
        assert.equal(text(file), "/path with spaces/pi");
        assert.deepEqual(vector(args), ["pi", "--name", 'agent "name"', "--session", "/some path/session.jsonl"]);
        assert.deepEqual(vector(env), ["X=$(literal) \"value\""]);
        return -1;
      } } };
    } }),
  });
  assert.throws(() => execve("/path with spaces/pi", ["pi", "--name", 'agent "name"', "--session", "/some path/session.jsonl"], { X: '$(literal) "value"', ABSENT: undefined }), /execve failed/);
  assert.equal(closed, true);
});
