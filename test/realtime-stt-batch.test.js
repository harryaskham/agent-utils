import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  buildSttBatchArgs,
  transcribePcmBuffer,
  DEFAULT_STT_BATCH_MODEL,
} from "../extensions/lib/realtime-stt-batch.js";

test("buildSttBatchArgs builds stdin/model argv with optional language (bd-9399e7)", () => {
  assert.deepEqual(buildSttBatchArgs(), ["--stdin", "--transcription-model", DEFAULT_STT_BATCH_MODEL]);
  assert.deepEqual(buildSttBatchArgs({ model: "m2" }), ["--stdin", "--transcription-model", "m2"]);
  assert.deepEqual(buildSttBatchArgs({ model: "m2", language: "en" }), [
    "--stdin",
    "--transcription-model",
    "m2",
    "--language",
    "en",
  ]);
});

// A fake `stt` subprocess: wires up as an EventEmitter and emits stdout/stderr +
// close on the next microtask (after transcribePcmBuffer has attached listeners).
function fakeStt({ exitCode = 0, stdout = "", stderr = "", throwOnSpawn = false } = {}) {
  const calls = { command: null, args: null, stdinChunks: [] };
  const spawnImpl = (command, args) => {
    if (throwOnSpawn) throw new Error("spawn ENOENT");
    calls.command = command;
    calls.args = args;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: (buf) => calls.stdinChunks.push(buf) };
    queueMicrotask(() => {
      if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
      if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
      proc.emit("close", exitCode);
    });
    return proc;
  };
  return { spawnImpl, calls };
}

test("transcribePcmBuffer resolves with the trimmed transcript and pipes the buffer (bd-9399e7)", async () => {
  const { spawnImpl, calls } = fakeStt({ stdout: "  hello world \n" });
  const text = await transcribePcmBuffer(Buffer.from([1, 2, 3, 4]), { model: "m2", spawnImpl });
  assert.equal(text, "hello world");
  assert.equal(calls.command, "stt");
  assert.deepEqual(calls.args, ["--stdin", "--transcription-model", "m2"]);
  assert.equal(calls.stdinChunks.length, 1);
  assert.ok(Buffer.isBuffer(calls.stdinChunks[0]));
});

test("transcribePcmBuffer rejects on a non-zero exit, carrying stderr (bd-9399e7)", async () => {
  const { spawnImpl } = fakeStt({ exitCode: 2, stderr: "model not found" });
  await assert.rejects(
    transcribePcmBuffer(Buffer.alloc(0), { spawnImpl }),
    /stt exited 2: model not found/,
  );
});

test("transcribePcmBuffer rejects when spawn itself throws (bd-9399e7)", async () => {
  const { spawnImpl } = fakeStt({ throwOnSpawn: true });
  await assert.rejects(transcribePcmBuffer(Buffer.alloc(0), { spawnImpl }), /spawn ENOENT/);
});
