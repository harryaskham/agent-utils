import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  AudioPlayback, buildDecoderSpec, buildSinkSpec, createPcm16VolumeTransform, normalizeOutputPatch, planPlayback, resolveAudioOutput,
} from "../extensions/audio-reel/playback.js";
import { pcmToWav } from "../extensions/lib/shared-audio.js";
import { drainingSink, fakeSpawner } from "./helpers/fake-audio-spawn.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("output resolution: explicit > PI_AUDIO_* > Pulse env > platform default", () => {
  assert.deepEqual(resolveAudioOutput({}, {}, "linux"), { backend: "pulse", requested: "auto", server: null, sink: null, serverExplicit: false, sinkExplicit: false });
  assert.equal(resolveAudioOutput({}, {}, "darwin").backend, "ffplay");
  assert.equal(resolveAudioOutput({}, { PULSE_SERVER: "tcp:h:4713" }, "darwin").backend, "pulse", "routed Pulse wins on macOS");
  const env = { PULSE_SERVER: "pulse-env", PULSE_SINK: "sink-env", PI_AUDIO_SERVER: "audio-env", PI_AUDIO_BACKEND: "sox" };
  assert.deepEqual(resolveAudioOutput({}, env, "linux"), { backend: "sox", requested: "sox", server: "audio-env", sink: "sink-env", serverExplicit: false, sinkExplicit: false });
  const explicit = resolveAudioOutput({ backend: "pacat", server: "", sink: "studio" }, env, "linux");
  assert.deepEqual(explicit, { backend: "pulse", requested: "pulse", server: null, sink: "studio", serverExplicit: true, sinkExplicit: true });
  assert.throws(() => resolveAudioOutput({ backend: "alsa-direct" }, {}), /Unsupported audio backend/);
  assert.throws(() => normalizeOutputPatch({ volume: 3 }), /Unsupported audio output setting/);
  assert.throws(() => normalizeOutputPatch({ sink: "a\nb" }), /control/);
  assert.throws(() => normalizeOutputPatch({ sink: "a", device: "b" }), /agree/);
});

test("sink specs route Pulse explicitly, strip secrets and support sox/ffplay", () => {
  const env = { PULSE_SERVER: "inherited", PULSE_SINK: "inherited-sink", OPENAI_API_KEY: "x", TTS_DAEMON_TOKEN: "y", PATH: "/bin" };
  const pulse = buildSinkSpec({ backend: "pulse", server: "tcp:h:4713", sink: "studio", rate: 24000, channels: 1, streamName: "my\nsong", env });
  assert.equal(pulse.command, "pacat");
  assert.ok(pulse.args.includes("--server=tcp:h:4713") && pulse.args.includes("--device=studio") && pulse.args.includes("--rate=24000") && pulse.args.includes("--channels=1"));
  assert.ok(pulse.args.includes("--stream-name=my song"));
  assert.equal(pulse.env.OPENAI_API_KEY, undefined); assert.equal(pulse.env.TTS_DAEMON_TOKEN, undefined); assert.equal(pulse.env.PATH, "/bin");
  const local = buildSinkSpec({ backend: "pulse", server: null, serverExplicit: true, sink: null, sinkExplicit: true, env });
  assert.equal(local.env.PULSE_SERVER, undefined, "explicit default server drops the inherited one");
  assert.equal(local.env.PULSE_SINK, undefined);
  assert.ok(!local.args.some((arg) => arg.startsWith("--server") || arg.startsWith("--device")));
  assert.equal(buildSinkSpec({ backend: "sox", sink: "hw:1", env }).env.AUDIODEV, "hw:1");
  assert.deepEqual(buildSinkSpec({ backend: "ffplay", channels: 1, env }).args.slice(-5), ["-ar", "48000", "-ch_layout", "mono", "-i", "-"].slice(-5));
});

test("decoder specs seek, apply gain and pin the file protocol", () => {
  const spec = buildDecoderSpec({ path: "/music/a:b.mp3", startMs: 1500, volume: 0.5 });
  assert.equal(spec.command, "ffmpeg");
  assert.deepEqual(spec.args.slice(spec.args.indexOf("-ss"), spec.args.indexOf("-ss") + 4), ["-ss", "1.500", "-i", "file:/music/a:b.mp3"]);
  assert.ok(spec.args.includes("volume=0.500"));
  assert.ok(!buildDecoderSpec({ path: "/a.mp3" }).args.includes("-ss"));
  assert.ok(!buildDecoderSpec({ path: "/a.mp3", volume: 1 }).args.includes("-af"));
  assert.throws(() => buildDecoderSpec({ path: "relative.mp3" }), /absolute/);
});

test("PCM16 gain stage handles odd chunk boundaries and clips", async () => {
  const transform = createPcm16VolumeTransform(2);
  const out = [];
  transform.on("data", (chunk) => out.push(chunk));
  const input = Buffer.alloc(6); input.writeInt16LE(1000, 0); input.writeInt16LE(30000, 2); input.writeInt16LE(-30000, 4);
  transform.write(input.subarray(0, 3)); transform.write(input.subarray(3)); transform.end();
  await new Promise((resolve) => transform.on("end", resolve));
  const result = Buffer.concat(out);
  assert.deepEqual([result.readInt16LE(0), result.readInt16LE(2), result.readInt16LE(4)], [2000, 32767, -32768]);
});

test("planPlayback picks the native path for PCM16 WAV and ffmpeg otherwise", async () => {
  const root = await mkdtemp(join(tmpdir(), "reel-plan-"));
  try {
    const wav = join(root, "a.wav");
    await writeFile(wav, pcmToWav(Buffer.alloc(48000 * 4), { sampleRate: 48000, channels: 2 }));
    assert.deepEqual(await planPlayback(wav, { startMs: 500 }), { kind: "wav", start: 44 + 24000 * 4, end: 44 + 48000 * 4, rate: 48000, channels: 2, durationMs: 1000 });
    const float = join(root, "f.wav");
    await writeFile(float, pcmToWav(Buffer.alloc(4800 * 4), { sampleRate: 48000, encoding: "f32le" }));
    assert.equal((await planPlayback(float)).kind, "ffmpeg");
    assert.equal((await planPlayback(float)).durationMs, 100);
    const mp3 = join(root, "a.mp3");
    await writeFile(mp3, Buffer.from("ID3\x04\0\0\0\0\0\0"));
    assert.deepEqual(await planPlayback(mp3), { kind: "ffmpeg", rate: 48000, channels: 2, durationMs: undefined });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("player tracks position across pause/resume/cue and reports a natural end", async () => {
  const root = await mkdtemp(join(tmpdir(), "reel-player-"));
  try {
    const path = join(root, "a.wav");
    await writeFile(path, pcmToWav(Buffer.alloc(24000 * 2 * 4), { sampleRate: 24000 }));
    let clock = 1000;
    const events = [];
    const { spawn, children } = fakeSpawner({ pacat() {} });
    const player = new AudioPlayback({ spawnImpl: spawn, now: () => clock, env: {}, onEvent: (event) => events.push(event), killDelayMs: 0 });
    const item = { key: "k1", path, label: "a" };
    let snap = await player.play(item, { positionMs: 1000, volume: 1 });
    assert.equal(snap.status, "playing"); assert.equal(snap.durationMs, 4000); assert.equal(snap.pipeline, "wav");
    clock += 1500;
    assert.equal(player.snapshot().positionMs, 2500);
    snap = player.pause();
    assert.equal(snap.status, "paused"); assert.equal(snap.positionMs, 2500);
    assert.deepEqual(children[0].signals, ["SIGTERM"]);
    clock += 10000;
    assert.equal(player.snapshot().positionMs, 2500, "paused clock does not advance");
    await settle();
    assert.deepEqual(events, [], "a deliberate kill is not an error or an end");
    player.cue(item, 9999);
    assert.equal(player.snapshot().positionMs, 4000, "cue clamps to duration");
    // Natural end: the sink drains the remaining PCM and exits 0.
    const second = await player.play(item, { positionMs: 3000 });
    assert.equal(second.positionMs, 3000);
    const sink = children.at(-1);
    await new Promise((resolve) => sink.stdin.on("finish", resolve));
    assert.equal(sink.received, 24000 * 2, "native path streams exactly the remaining second");
    sink.finish(0);
    await settle();
    assert.deepEqual(events, [{ type: "ended", key: "k1" }]);
    assert.equal(player.snapshot().status, "ended");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("decoder failures win over a clean sink exit; sink failures stop the decoder", async () => {
  const root = await mkdtemp(join(tmpdir(), "reel-fail-"));
  try {
    const path = join(root, "a.mp3");
    await writeFile(path, Buffer.from("ID3\x04\0\0garbage"));
    const events = [];
    const { spawn, children } = fakeSpawner({
      ffmpeg(child) { setImmediate(() => { child.stderr.write("Invalid data found when processing input\n"); child.stdout.end(); setTimeout(() => child.finish(1), 5); }); },
      pacat: drainingSink,
    });
    const player = new AudioPlayback({ spawnImpl: spawn, env: {}, onEvent: (event) => events.push(event), killDelayMs: 0 });
    await player.play({ key: "bad", path, label: "bad" });
    await settle(); await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.match(events[0].error, /ffmpeg exited 1: Invalid data/);
    assert.equal(children[0].command, "pacat"); assert.equal(children[1].command, "ffmpeg");
    assert.ok(children[1].args.includes(`file:${path}`));

    events.length = 0;
    const second = fakeSpawner({
      pacat(child) { setImmediate(() => { child.stderr.write("Connection refused\n"); child.finish(1); }); },
      ffmpeg() {},
    });
    const routed = new AudioPlayback({ spawnImpl: second.spawn, env: {}, onEvent: (event) => events.push(event), killDelayMs: 0 });
    await routed.play({ key: "k", path, label: "k" }, { output: { server: "tcp:nowhere:4713" } });
    await settle();
    assert.match(events[0].error, /audio output exited 1: Connection refused/);
    assert.deepEqual(second.children[1].signals, ["SIGTERM"], "decoder reaped after sink failure");
    assert.ok(second.children[0].args.includes("--server=tcp:nowhere:4713"));

    const missing = new AudioPlayback({ spawnImpl: () => { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}; setImmediate(() => child.emit("error", Object.assign(new Error("spawn pacat ENOENT"), { code: "ENOENT" }))); return child; }, env: {}, onEvent: (event) => events.push(event) });
    events.length = 0;
    await missing.play({ key: "m", path: join(root, "a.mp3"), label: "m" }).catch(() => {});
    await settle();
    assert.match(events[0]?.error || "", /pacat not found|ffmpeg is required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
