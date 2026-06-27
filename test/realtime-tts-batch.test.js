import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  AZURE_SPEECH_PROVIDER,
  CASCADE_DEFAULT_VOICE_SENTINEL,
  resolveCascadeTtsVoice,
  buildTtsBatchArgs,
  synthesizeToPcm,
} from "../extensions/lib/realtime-tts-batch.js";

// ---------------------------------------------------------------------------
// resolveCascadeTtsVoice
// ---------------------------------------------------------------------------

test("resolveCascadeTtsVoice maps the sentinel/empty to undefined and passes explicit voices", () => {
  assert.equal(resolveCascadeTtsVoice(CASCADE_DEFAULT_VOICE_SENTINEL), undefined);
  assert.equal(resolveCascadeTtsVoice(""), undefined);
  assert.equal(resolveCascadeTtsVoice("   "), undefined);
  assert.equal(resolveCascadeTtsVoice(null), undefined);
  assert.equal(resolveCascadeTtsVoice("en-us-phoebe:MAI-Voice-1"), "en-us-phoebe:MAI-Voice-1");
  assert.equal(resolveCascadeTtsVoice("  cedar  "), "cedar");
});

// ---------------------------------------------------------------------------
// buildTtsBatchArgs
// ---------------------------------------------------------------------------

test("buildTtsBatchArgs defaults to stdout + pcm and forces no provider (inherits caco env defaults)", () => {
  assert.deepEqual(buildTtsBatchArgs(), ["--stdout", "--response-format", "pcm"]);
  // sentinel voice is omitted (provider default voice)
  assert.deepEqual(buildTtsBatchArgs({ voice: CASCADE_DEFAULT_VOICE_SENTINEL }), [
    "--stdout", "--response-format", "pcm",
  ]);
});

test("buildTtsBatchArgs passes text as a positional after -- (leading-dash safe)", () => {
  assert.deepEqual(buildTtsBatchArgs({ text: "hello there" }), [
    "--stdout", "--response-format", "pcm", "--", "hello there",
  ]);
  assert.deepEqual(buildTtsBatchArgs({ text: "-dashy" }), [
    "--stdout", "--response-format", "pcm", "--", "-dashy",
  ]);
});

test("buildTtsBatchArgs threads voice/model/baseUrl/instructions, a non-unity speed, and an explicit provider", () => {
  assert.deepEqual(
    buildTtsBatchArgs({
      text: "be warm",
      voice: "cedar",
      model: "azure/speech/azure-tts",
      provider: AZURE_SPEECH_PROVIDER,
      baseUrl: "http://x",
      speed: 1.2,
      instructions: "warm tone",
    }),
    [
      "--stdout", "--response-format", "pcm",
      "--voice", "cedar",
      "--model", "azure/speech/azure-tts",
      "--provider", "azure-speech",
      "--base-url", "http://x",
      "--speed", "1.2",
      "--instructions", "warm tone",
      "--", "be warm",
    ],
  );
});

test("buildTtsBatchArgs omits a unity / invalid speed and honours an explicit response format", () => {
  assert.ok(!buildTtsBatchArgs({ speed: 1 }).includes("--speed"));
  assert.ok(!buildTtsBatchArgs({ speed: 0 }).includes("--speed"));
  assert.ok(!buildTtsBatchArgs({ speed: "nope" }).includes("--speed"));
  assert.deepEqual(buildTtsBatchArgs({ responseFormat: "wav" }), ["--stdout", "--response-format", "wav"]);
});

// ---------------------------------------------------------------------------
// synthesizeToPcm (injected spawn)
// ---------------------------------------------------------------------------

// A fake `tts` subprocess that emits stdout/stderr + close after listeners attach.
function fakeTts({ exitCode = 0, stdout = null, stderr = "", throwOnSpawn = false } = {}) {
  const calls = { command: null, args: null, opts: null };
  const spawnImpl = (command, args, opts) => {
    if (throwOnSpawn) throw new Error("spawn ENOENT");
    calls.command = command;
    calls.args = args;
    calls.opts = opts;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    // no stdin: synthesizeToPcm uses positional text, stdin is "ignore"
    queueMicrotask(() => {
      if (stdout) proc.stdout.emit("data", stdout);
      if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
      proc.emit("close", exitCode);
    });
    return proc;
  };
  return { spawnImpl, calls };
}

test("synthesizeToPcm resolves with concatenated PCM and passes text as a positional arg", async () => {
  const pcm = Buffer.from([0, 1, 2, 3, 4, 5]);
  const { spawnImpl, calls } = fakeTts({ stdout: pcm });
  const buf = await synthesizeToPcm("hello there", { voice: "cedar", spawnImpl });
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual(buf, pcm);
  assert.equal(calls.command, "tts");
  assert.deepEqual(calls.args, [
    "--stdout", "--response-format", "pcm", "--voice", "cedar", "--", "hello there",
  ]);
  // stdin is not used (ignored) — text rides in argv
  assert.equal(calls.opts.stdio[0], "ignore");
});

test("synthesizeToPcm concatenates multiple stdout chunks", async () => {
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      proc.stdout.emit("data", Buffer.from([1, 2]));
      proc.stdout.emit("data", Buffer.from([3, 4]));
      proc.emit("close", 0);
    });
    return proc;
  };
  const buf = await synthesizeToPcm("hi", { spawnImpl });
  assert.deepEqual(buf, Buffer.from([1, 2, 3, 4]));
});

test("synthesizeToPcm rejects empty text without spawning", async () => {
  let spawned = false;
  const spawnImpl = () => { spawned = true; return new EventEmitter(); };
  await assert.rejects(synthesizeToPcm("   ", { spawnImpl }), /empty text/);
  assert.equal(spawned, false);
});

test("synthesizeToPcm rejects on a non-zero exit, carrying stderr", async () => {
  const { spawnImpl } = fakeTts({ exitCode: 3, stderr: "azure auth failed" });
  await assert.rejects(synthesizeToPcm("hi", { spawnImpl }), /tts exited 3: azure auth failed/);
});

test("synthesizeToPcm rejects when spawn itself throws", async () => {
  const { spawnImpl } = fakeTts({ throwOnSpawn: true });
  await assert.rejects(synthesizeToPcm("hi", { spawnImpl }), /spawn ENOENT/);
});
