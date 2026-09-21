import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTtsCommand, playTtsCommand } from "../extensions/lib/tts-command.js";
import { MachineTtsQueue, TTS_QUEUE_SYMBOL } from "../extensions/lib/tts-queue.js";
import { resolveAgentTtsSettings, createAgentSpeechController } from "../extensions/lib/tts-narration.js";
import { applyReadConfigValues, defaultReadConfig } from "../extensions/read-aloud.js";
import { parseEnvStyleArgs } from "../extensions/lib/env-args.js";

const waitFor = async (fn) => {
  const end = Date.now() + 4000;
  while (!fn()) { assert.ok(Date.now() < end, "timed out"); await new Promise(r => setTimeout(r, 10)); }
};

test("command configuration preserves shell variables and selects local playback", () => {
  const command = 'tool --speed "${PI_TTS_SPEED}" "$@"';
  const parsed = parseEnvStyleArgs(`/tts command='${command}'`);
  assert.equal(applyReadConfigValues(defaultReadConfig({}), parsed.values, {}).command, command);
  assert.equal(resolveAgentTtsSettings({ env: { PI_TTS_COMMAND: command } }).config.provider, "command");
  assert.equal(resolveAgentTtsSettings({ env: {}, persisted: { command } }).config.provider, "command");
  assert.equal(applyReadConfigValues({}, { provider: "azure", command }).provider, "azure");
});

test("real shell receives literal speech and effective variables, not speech as shell code", async () => {
  const root = mkdtempSync(join(tmpdir(), "tts-command-"));
  try {
    const text = 'hello "quotes" $(exit 42); ${HOME}\nsecond line';
    await runTtsCommand(text, {
      command: 'printf "%s\\n%s\\n%s" "$PI_TTS_SPEED" "$PI_TTS_VOICE" "$@" > "$OUT"',
      speed: 1.7, voice: "local voice", env: { ...process.env, OUT: join(root, "out") },
    });
    assert.equal(readFileSync(join(root, "out"), "utf8"), `1.7\nlocal voice\n${text}`);
    await assert.rejects(runTtsCommand("hello", { command: "echo broken >&2; exit 7" }), /exited 7: broken/);
    await assert.rejects(runTtsCommand("hello", {}), /requires command/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("command speech bypasses Azure and PCM, and supports narration overrides", async () => {
  const speech = createAgentSpeechController({
    env: process.env,
    synthesize() { throw new Error("must not synthesize"); },
    player: { interrupt() {}, play() { throw new Error("must not play PCM"); } },
    initialConfig: { provider: "command", speed: 1, command: 'test "$PI_TTS_SPEED" = 2' },
  });
  assert.deepEqual(await speech.speak("hello", { speed: 2 }), { interrupted: false });
  speech.dispose();
});

test("opaque jobs share queue capacity, have unknown duration, and cancel without PCM", async () => {
  const root = mkdtempSync(join(tmpdir(), "tts-command-queue-"));
  const player = { play() { throw new Error("not PCM"); }, interrupt() {} };
  const first = new MachineTtsQueue({ root, player, pollMs: 10 });
  const second = new MachineTtsQueue({ root, player, pollMs: 10 });
  let started = 0;
  const previous = globalThis[TTS_QUEUE_SYMBOL];
  try {
    first.configure({ maxParallel: 1, overlapMs: 2000 });
    globalThis[TTS_QUEUE_SYMBOL] = first;
    const playing = playTtsCommand("hello", { command: "exec sleep 30" });
    await waitFor(() => first.current);
    assert.equal(first.status().playing[0].expectedEndAt, null);
    const next = second.enqueueTask(async () => { started++; return { interrupted: false }; });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(started, 0, "unknown duration must not enable timed overlap");
    first.skipCurrent();
    assert.equal((await playing).interrupted, true);
    await next;
    assert.equal(started, 1);
  } finally {
    globalThis[TTS_QUEUE_SYMBOL] = previous;
    first.stop(); second.stop();
    await waitFor(() => !first.current && !second.current && !first.maintenance && !second.maintenance);
    rmSync(root, { recursive: true, force: true });
  }
});
