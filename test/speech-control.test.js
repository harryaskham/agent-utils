import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { normalizeSpeechMuteState, readSpeechMuteState, speechControlObserverCounts, speechMutePath, withSpeechControl } from "../extensions/lib/speech-control.js";

const waitFor = async (fn) => { const end = Date.now() + 4000; while (!fn()) { assert.ok(Date.now() < end, "timed out"); await new Promise(r => setTimeout(r, 5)); } };
async function put(path, muted = {}, epochs = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, muted, epochs }));
  await rename(`${path}.tmp`, path);
}

test("mute state defaults, bounds, malformed input and path policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "speech-control-"));
  const path = join(root, "mute.json");
  try {
    assert.equal(speechMutePath({ HOME: root }), join(root, ".local/state/agent-utils/tts/mute.json"));
    assert.equal((await readSpeechMuteState(path)).muted.narrate, false);
    await put(path, { tts: true });
    assert.equal((await readSpeechMuteState(path)).muted.tts, true);
    for (const invalid of [{}, { version: 2 }, { version: 1, muted: null }, { version: 1, muted: { tts: null } }, { version: 1, epochs: { tts: -1 } }, { version: 1, unexpected: true }]) {
      assert.throws(() => normalizeSpeechMuteState(invalid), /Invalid/);
    }
    await writeFile(path, "not-json");
    await assert.rejects(withSpeechControl({ speechKind: "tts", env: { PI_TTS_MUTE_PATH: path } }, () => assert.fail("must not speak")), /Invalid speech mute JSON/);
    assert.deepEqual(speechControlObserverCounts(), { files: 0, watchers: 0, listeners: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("state publication cancels live speech, ignores other kinds, and releases event watchers", async () => {
  const root = await mkdtemp(join(tmpdir(), "speech-control-"));
  const path = join(root, "not-yet-created/tts/mute.json");
  let started = false, signal, speech;
  const parent = new AbortController();
  try {
    speech = withSpeechControl({ speechKind: "narrate", signal: parent.signal, env: { PI_TTS_MUTE_PATH: path } }, (options) => {
      started = true; signal = options.signal;
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({ interrupted: true }), { once: true }));
    });
    await waitFor(() => started);
    await put(path, { read: true }, { read: 1 });
    await new Promise(r => setTimeout(r, 40));
    assert.equal(signal.aborted, false);
    await put(path, { narrate: true }, { narrate: 1 });
    await waitFor(() => signal.aborted);
    assert.equal((await speech).muted, true);
    assert.deepEqual(speechControlObserverCounts(), { files: 0, watchers: 0, listeners: 0 });
    await put(path, {}, { narrate: 1 });
    assert.equal(await withSpeechControl({ speechKind: "narrate", env: { PI_TTS_MUTE_PATH: path } }, () => "new speech"), "new speech");
  } finally { parent.abort(); await speech?.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test("queued epochs fence mute-unmute even without a surviving origin watcher; symlink state works", async () => {
  const root = await mkdtemp(join(tmpdir(), "speech-control-"));
  const target = join(root, "target/mute.json"), path = join(root, "policy.json");
  try {
    await mkdir(dirname(target)); await symlink(target, path);
    const options = { speechKind: "choices", env: { PI_TTS_MUTE_PATH: path } };
    const token = await withSpeechControl(options, (effective) => effective.speechControl);
    await put(target, { choices: true }, { choices: 1 });
    await put(target, { choices: false }, { choices: 1 });
    assert.equal((await withSpeechControl({ ...options, speechControl: token }, () => assert.fail("stale backlog must not play"))).muted, true);
    assert.equal(await withSpeechControl(options, () => "allowed"), "allowed");
    await put(target, { choices: true }, { choices: 2 });
    assert.equal((await withSpeechControl(options, () => assert.fail("muted"))).muted, true);
    assert.deepEqual(speechControlObserverCounts(), { files: 0, watchers: 0, listeners: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("active readers observe atomic writes through managed symlink targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "speech-control-link-"));
  const target = join(root, "target/mute.json"), path = join(root, "policy.json");
  let signal, pending;
  const parent = new AbortController();
  try {
    await mkdir(dirname(target)); await symlink(target, path);
    pending = withSpeechControl({ speechKind: "read", signal: parent.signal, env: { PI_TTS_MUTE_PATH: path } }, (options) => {
      signal = options.signal;
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({ interrupted: true }), { once: true }));
    });
    await waitFor(() => signal);
    await put(target, { read: true }, { read: 1 });
    await waitFor(() => signal.aborted);
    assert.equal((await pending).muted, true);
    assert.equal(speechControlObserverCounts().files, 0);
  } finally { parent.abort(); await pending?.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test("external abort and unrelated audio do not leave observers", async () => {
  const root = await mkdtemp(join(tmpdir(), "speech-control-"));
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await withSpeechControl({ speechKind: "read", signal: controller.signal, env: { PI_TTS_MUTE_PATH: join(root, "mute") } }, () => assert.fail()), { interrupted: true });
  assert.equal(await withSpeechControl({ streamName: "realtime" }, () => "untouched"), "untouched");
  assert.equal(speechControlObserverCounts().files, 0);
  await rm(root, { recursive: true, force: true });
});
