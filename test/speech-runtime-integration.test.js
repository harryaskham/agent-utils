import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSpeechController } from "../extensions/lib/tts-narration.js";
import { createReadModeController } from "../extensions/read-aloud.js";
import { createChoiceSpeaker } from "../extensions/lib/choice.js";
import { createInterruptiblePcmPlayer, buildPcmPlaybackSpec } from "../extensions/lib/tts.js";
import { runTtsCommand } from "../extensions/lib/tts-command.js";
import { MachineTtsQueue, TTS_QUEUE_SYMBOL } from "../extensions/lib/tts-queue.js";
import { speechControlObserverCounts } from "../extensions/lib/speech-control.js";

const exec = promisify(execFile);
const bounded = async (promise) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("speech did not settle")), 5000); })]); }
  finally { clearTimeout(timer); }
};
const waitFor = async (fn) => { const end = Date.now() + 5000; while (!fn()) { assert.ok(Date.now() < end, "timed out"); await new Promise(r => setTimeout(r, 5)); } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "speech-runtime-"));
  const path = join(root, "mute.json");
  return { root, path, env: { PI_TTS_MUTE_PATH: path }, async put(muted = {}, epochs = {}) {
    await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, muted, epochs }));
    await rename(`${path}.tmp`, path);
  }, async close() { await rm(root, { recursive: true, force: true }); } };
}
function fakeProcesses({ autoClose = false } = {}) {
  const processes = [];
  const spawnImpl = (command, args, options) => {
    const proc = new EventEmitter(); proc.command = command; proc.args = args; proc.options = options; proc.kills = [];
    proc.stdin = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.stdin.write = () => true;
    proc.stdin.end = () => { if (autoClose) setImmediate(() => proc.emit("close", 0)); };
    proc.stdin.destroy = () => {};
    proc.kill = (signal) => { proc.kills.push(signal); setImmediate(() => proc.emit("close", null, signal)); return true; };
    processes.push(proc); return proc;
  };
  return { processes, spawnImpl };
}

test("all speech surfaces retain separate pacat names and selective mute gates synthesis", async () => {
  const f = await fixture(); const plays = []; let synthesized = 0;
  const synthesize = async () => { synthesized++; return Buffer.alloc(4); };
  const player = { interrupt() {}, async play(_pcm, options) { plays.push(options); return { interrupted: false }; } };
  const agent = createAgentSpeechController({ env: f.env, synthesize, player });
  const read = createReadModeController({ env: f.env, synthesize, player });
  const choices = createChoiceSpeaker({ env: f.env, synthesize, player });
  try {
    await read.speak("read"); await agent.speak("tts");
    await agent.speak("narrate", { speechKind: "narrate", streamName: "/narrate" });
    await choices.speak("choices");
    assert.deepEqual(plays.map(p => p.streamName), ["/read", "/tts", "/narrate", "/choices"]);
    for (const options of plays) {
      const spec = buildPcmPlaybackSpec({ ...options, backend: "pulse" });
      assert.ok(spec.args.includes(`--client-name=${options.streamName}`));
      assert.ok(spec.args.includes(`--stream-name=${options.streamName}`));
      assert.equal(options.speechControl.kind, options.streamName.slice(1));
    }
    await f.put({ read: true, tts: true, narrate: true, choices: true }, { read: 1, tts: 1, narrate: 1, choices: 1 });
    assert.equal(await read.speak("muted"), false);
    assert.equal((await agent.speak("muted")).muted, true);
    assert.equal((await agent.speak("muted", { streamName: "/narrate" })).muted, true);
    assert.equal((await choices.speak("muted")).muted, true);
    assert.equal(synthesized, 4);
    await f.put({ read: true, tts: true, choices: true }, { read: 1, tts: 1, narrate: 1, choices: 1 });
    await agent.speak("new narration", { streamName: "/narrate" });
    assert.equal(synthesized, 5); assert.equal(plays.at(-1).streamName, "/narrate");
    assert.equal(agent.getConfig().streamName, "/tts", "per-call name never rewrites base settings");
  } finally { agent.dispose(); read.dispose(); choices.dispose(); await f.close(); }
});

test("runtime mute interrupts an active PCM child and releases watchers", async () => {
  const f = await fixture(), spawned = fakeProcesses();
  const player = createInterruptiblePcmPlayer({ spawnImpl: spawned.spawnImpl });
  try {
    const playing = player.play(Buffer.alloc(4), { streamName: "/tts", speechKind: "tts", env: f.env });
    await waitFor(() => spawned.processes.length === 1);
    await f.put({ tts: true }, { tts: 1 });
    assert.equal((await bounded(playing)).muted, true);
    assert.deepEqual(spawned.processes[0].kills, ["SIGTERM"]);
    assert.deepEqual(speechControlObserverCounts(), { files: 0, watchers: 0, listeners: 0 });
  } finally { player.dispose(); await f.close(); }
});

test("local command providers receive the source name and live mute terminates their process group", async () => {
  const f = await fixture(); let child;
  try {
    const out = join(f.root, "env.txt");
    await runTtsCommand("speech", { command: 'printf "%s\\n%s" "$PI_TTS_KIND" "$PI_TTS_STREAM_NAME" > "$OUT"', speechKind: "choices", env: { ...process.env, ...f.env, OUT: out } });
    assert.equal(await readFile(out, "utf8"), "choices\n/choices");
    await runTtsCommand("speech", { command: 'printf "%s" "$PULSE_PROP" > "$OUT"', speechKind: "narrate", env: { ...process.env, ...f.env, OUT: out, PULSE_PROP: 'media.role="notification"' } });
    assert.equal(await readFile(out, "utf8"), 'media.role="notification" application.name="/narrate" media.name="/narrate"');
    const playing = runTtsCommand("speech", { command: "exec sleep 30", speechKind: "narrate", streamName: "/narrate", env: { ...process.env, ...f.env }, spawnImpl(...args) { child = spawn(...args); return child; } });
    await waitFor(() => child);
    await f.put({ narrate: true }, { narrate: 1 });
    assert.equal((await bounded(playing)).muted, true);
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
    assert.equal(speechControlObserverCounts().files, 0);
  } finally { if (child?.exitCode == null && child?.signalCode == null) child?.kill("SIGKILL"); await f.close(); }
});

test("queued speech is cancelled and recovered stale PCM is fenced after unmute", async () => {
  const f = await fixture(), spawned = fakeProcesses({ autoClose: true });
  const raw = createInterruptiblePcmPlayer({ spawnImpl: spawned.spawnImpl });
  const queue = new MachineTtsQueue({ root: join(f.root, "queue"), player: raw, pollMs: 5 });
  const previous = globalThis[TTS_QUEUE_SYMBOL]; let release;
  const agent = createAgentSpeechController({ env: f.env, synthesize: async () => Buffer.alloc(4), player: createInterruptiblePcmPlayer({ queue: true }) });
  try {
    globalThis[TTS_QUEUE_SYMBOL] = queue;
    queue.configure({ maxParallel: 1, overlapMs: 0 });
    const blocker = queue.enqueueTask(() => new Promise(resolve => { release = resolve; }));
    await waitFor(() => release);
    const speech = agent.speak("queued", { streamName: "/narrate" });
    await waitFor(() => queue.waiters.size === 2 && queue.admitting.size === 0);
    const files = (await readdir(join(queue.root, "jobs"))).filter(n => n.endsWith(".json"));
    const job = JSON.parse(await readFile(join(queue.root, "jobs", files[0]), "utf8"));
    assert.equal(job.options.speechControl.kind, "narrate");
    assert.equal(job.options.signal, undefined);
    await f.put({ narrate: true }, { narrate: 1 });
    assert.equal((await bounded(speech)).muted, true);
    await f.put({}, { narrate: 1 });
    release({ interrupted: false }); await blocker;
    await waitFor(() => !queue.current);
    const recovered = queue.enqueue(Buffer.alloc(4), job.options);
    let recoveredResult; recovered.then(result => { recoveredResult = result; });
    await waitFor(() => recoveredResult);
    assert.equal(recoveredResult.muted, true);
    assert.equal(spawned.processes.length, 0, "no paused backlog replayed after unmute");
    await bounded(agent.speak("new", { streamName: "/narrate" }));
    assert.equal(spawned.processes.length, 1);
  } finally {
    release?.({ interrupted: true }); agent.dispose(); queue.stop(); raw.dispose();
    globalThis[TTS_QUEUE_SYMBOL] = previous;
    await waitFor(() => !queue.current && !queue.maintenance);
    await f.close();
  }
});

test("real ag mutation controls a running JS speaker without audio/network or settings edits", { skip: !process.env.AG_TEST_BIN }, async () => {
  const f = await fixture(); let started = false, holding = true, count = 0;
  const agent = createAgentSpeechController({ env: f.env, synthesize: async () => { count++; return Buffer.alloc(4); }, player: {
    interrupt() {},
    play(_pcm, options) { started = true; return holding ? new Promise(resolve => options.signal.addEventListener("abort", () => resolve({ interrupted: true }), { once: true })) : Promise.resolve({ interrupted: false }); },
  } });
  const change = (command) => exec(process.env.AG_TEST_BIN, ["--config", join(f.root, "absent.yaml"), "--local", "--mute-state", f.path, "--json", "tts", command, "--narrate"], { timeout: 15000 });
  try {
    const inFlight = agent.speak("in flight", { streamName: "/narrate" });
    await waitFor(() => started);
    const ack = JSON.parse((await change("mute")).stdout);
    assert.equal(ack.data.hosts[0].data.state.muted.narrate, true);
    assert.equal((await bounded(inFlight)).muted, true);
    assert.equal((await agent.speak("suppressed", { streamName: "/narrate" })).muted, true);
    assert.equal(count, 1);
    holding = false;
    await change("unmute");
    await agent.speak("future", { streamName: "/narrate" });
    assert.equal(count, 2);
    assert.equal(speechControlObserverCounts().files, 0);
  } finally { agent.dispose(); await f.close(); }
});
