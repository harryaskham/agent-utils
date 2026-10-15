import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveSharedAudio, decodeInlineAudio, materializeAudio, normalizePcmOptions, parseWavHeader, pcmToWav, sniffAudio,
} from "../extensions/lib/shared-audio.js";
import { sharedAudioRoot } from "../extensions/lib/artifact-state.js";
import { sharedAudioEnabled } from "../extensions/lib/privacy.js";

const sine = (samples, rate = 24000, hz = 440) => {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * hz) * 8000), i * 2);
  return pcm;
};

test("sniffs every supported container from content before declared type or extension", () => {
  const cases = [
    [Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVE")]), "audio/wav", "wav"],
    [Buffer.from("fLaC\0\0\0\x22"), "audio/flac", "flac"],
    [Buffer.from("OggS\0\x02...vorbis"), "audio/ogg", "ogg"],
    [Buffer.concat([Buffer.from("OggS\0\x02"), Buffer.alloc(20), Buffer.from("OpusHead")]), "audio/ogg", "opus"],
    [Buffer.from("FORM\0\0\0\0AIFF"), "audio/aiff", "aiff"],
    [Buffer.from("MThd\0\0\0\x06"), "audio/midi", "mid"],
    [Buffer.from("\0\0\0\x20ftypM4A "), "audio/mp4", "m4a"],
    [Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("....webm")]), "audio/webm", "webm"],
    [Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]), "audio/x-matroska", "mka"],
    [Buffer.from("ID3\x04\0\0"), "audio/mpeg", "mp3"],
    [Buffer.from([0xff, 0xfb, 0x90, 0x64]), "audio/mpeg", "mp3"],
    [Buffer.from([0xff, 0xf1, 0x50, 0x80]), "audio/aac", "aac"],
  ];
  for (const [bytes, mimeType, extension] of cases) assert.deepEqual(sniffAudio(bytes, "audio/mpeg"), { mimeType, extension }, mimeType);
  assert.deepEqual(sniffAudio(Buffer.from("????"), "audio/x-wav"), { mimeType: "audio/wav", extension: "wav" });
  assert.deepEqual(sniffAudio(Buffer.from("????"), undefined, "/a/b/song.FLAC"), { mimeType: "audio/flac", extension: "flac" });
  assert.throws(() => sniffAudio(Buffer.from("<html>"), "text/html", "x.txt"), /Unsupported shared audio/);
});

test("raw PCM becomes a canonical WAV with exact header fields and duration", () => {
  const pcm = sine(12000);
  const wav = pcmToWav(pcm, { sampleRate: 24000, channels: 1 });
  assert.equal(wav.length, 44 + pcm.length);
  const header = parseWavHeader(wav);
  assert.deepEqual({ ...header }, { format: 1, channels: 1, sampleRate: 24000, blockAlign: 2, bitsPerSample: 16, dataOffset: 44, dataBytes: 24000, durationMs: 500 });
  const float = parseWavHeader(pcmToWav(Buffer.alloc(48000 * 8), { sampleRate: 48000, channels: 2, encoding: "f32le" }));
  assert.equal(float.format, 3); assert.equal(float.bitsPerSample, 32); assert.equal(float.durationMs, 1000);
  assert.throws(() => pcmToWav(Buffer.alloc(3), { channels: 1 }), /whole number/);
  assert.throws(() => normalizePcmOptions({ encoding: "s12" }), /encoding/);
  assert.throws(() => normalizePcmOptions({ sampleRate: 10 }), /sampleRate/);
  // Streamed WAV (0xffffffff data size) is bounded by the real file length.
  const streamed = Buffer.from(wav); streamed.writeUInt32LE(0xffffffff, 40);
  assert.equal(parseWavHeader(streamed, streamed.length).dataBytes, 24000);
  assert.equal(parseWavHeader(Buffer.from("RIFF\0\0\0\0WAVEjunk")), null);
});

test("inline audio decodes base64, data URLs and implicit L16 PCM; rejects junk", () => {
  const pcm = sine(2400);
  const raw = decodeInlineAudio({ data: pcm.toString("base64"), pcm: { sampleRate: 24000 } });
  assert.equal(raw.mimeType, "audio/wav"); assert.equal(raw.extension, "wav"); assert.equal(raw.bytes.length, 44 + pcm.length);
  const l16 = decodeInlineAudio({ data: pcm.toString("base64"), mimeType: "audio/L16;rate=24000" });
  assert.equal(l16.mimeType, "audio/wav");
  const url = decodeInlineAudio({ data: `data:audio/mpeg;base64,${Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2]).toString("base64")}` });
  assert.equal(url.mimeType, "audio/mpeg");
  assert.throws(() => decodeInlineAudio({ data: "not base64!!" }), /base64/);
  assert.throws(() => decodeInlineAudio({ data: "" }), /nonempty/);
});

test("archive publishes private audio + sidecar commit marker idempotently in the ag layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "shared-audio-"));
  const env = { HOME: root, PI_AGENT_UTILS_STATE_DIR: join(root, "state") };
  try {
    assert.equal(sharedAudioRoot(env), join(root, "state", "audio"));
    const source = join(root, "beep.wav");
    await writeFile(source, pcmToWav(sine(24000), { sampleRate: 24000 }));
    const provenance = { agent: "chirp agent/π", session: "s1", host: "node", cwd: root, kind: "tool", tool: "audio_share", eventId: "call-1", index: 0 };
    const first = await archiveSharedAudio({ path: "beep.wav", label: "beep", title: "Beep", description: "a test tone" }, provenance, { env, now: () => Date.parse("2026-10-14T00:00:00Z") });
    const again = await archiveSharedAudio({ path: source, label: "beep" }, provenance, { env });
    assert.equal(again.id, first.id, "same share event is idempotent");
    assert.match(first.id, /^chirp-agent-+[0-9a-f]{12}\/aud-[0-9a-f]{64}\.wav$/);
    const meta = JSON.parse(await readFile(`${first.path}.json`, "utf8"));
    assert.equal(meta.version, 1); assert.equal(meta.id, first.id); assert.equal(meta.mimeType, "audio/wav");
    assert.equal(meta.bytes, (await stat(first.path)).size); assert.equal(meta.durationMs, 1000);
    assert.equal(meta.sampleRate, 24000); assert.equal(meta.channels, 1);
    assert.equal(meta.title, "Beep"); assert.equal(meta.description, "a test tone"); assert.equal(meta.source.label, "beep");
    assert.equal(meta.agent, "chirp agent/π"); assert.equal(meta.timestamp, "2026-10-14T00:00:00.000Z");
    assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    assert.equal((await stat(`${first.path}.json`)).mode & 0o777, 0o600);
    const files = await readdir(join(root, "state", "audio", first.id.split("/")[0]));
    assert.deepEqual(files.sort(), [first.id.split("/")[1], `${first.id.split("/")[1]}.json`].sort(), "no temporaries remain");
    const bytes = await archiveSharedAudio({ bytes: Buffer.from("ID3\x04\0\0rest"), mimeType: "audio/mpeg" }, { ...provenance, eventId: "call-2" }, { env });
    assert.match(bytes.id, /\.mp3$/);
    const scratch = await materializeAudio(Buffer.from("fLaC...."), "flac", join(root, "scratch"));
    assert.match(scratch, /clip-[0-9a-f]{24}\.flac$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archive honours PI_SHARED_AUDIO_ENABLED=0, incognito and PI_SHARED_AUDIO_DIR", async () => {
  const root = await mkdtemp(join(tmpdir(), "shared-audio-off-"));
  try {
    assert.equal(sharedAudioEnabled({ PI_SHARED_AUDIO_ENABLED: "0" }), false);
    assert.equal(sharedAudioEnabled({ PI_INCOGNITO: "1", PI_SHARED_AUDIO_ENABLED: "1" }), false);
    assert.equal(sharedAudioEnabled({}), true);
    for (const env of [{ PI_SHARED_AUDIO_ENABLED: "off" }, { PI_INCOGNITO: "true" }]) {
      assert.equal(await archiveSharedAudio({ path: "/must-not-read" }, {}, { env: { ...env, PI_AGENT_UTILS_STATE_DIR: join(root, "state") } }), null);
    }
    assert.deepEqual(await readdir(root), []);
    const custom = join(root, "custom");
    const receipt = await archiveSharedAudio({ bytes: Buffer.from("fLaC\0\0\0\x22") }, { agent: "a", session: "s", eventId: "e", index: 0 }, { env: { PI_SHARED_AUDIO_DIR: custom } });
    assert.ok(receipt.path.startsWith(custom));
  } finally { await rm(root, { recursive: true, force: true }); }
});
