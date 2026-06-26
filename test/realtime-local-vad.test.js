import test from "node:test";
import assert from "node:assert/strict";

import {
  LocalVadController,
  parseLocalVadConfig,
  describeLocalVadConfig,
  LOCAL_VAD_ENV_KEYS,
} from "../extensions/lib/realtime-local-vad.js";
import { DEFAULT_VAD_SEGMENTER_CONFIG } from "../extensions/lib/realtime-vad-segmenter.js";

const SAMPLE_RATE = 24000;
const SAMPLE_WIDTH = 2;

// PCM16-LE frame of `ms` duration: speech (constant high amplitude) or silence.
function frame(ms, { speech } = {}) {
  const samples = Math.round((ms / 1000) * SAMPLE_RATE);
  const buf = Buffer.alloc(samples * SAMPLE_WIDTH);
  if (speech) for (let i = 0; i < samples; i++) buf.writeInt16LE(8000, i * SAMPLE_WIDTH);
  return buf;
}

// --- parseLocalVadConfig ---

test("parseLocalVadConfig returns segmenter defaults for an empty env (bd-9399e7)", () => {
  assert.deepEqual(parseLocalVadConfig({}), {
    energyThreshold: DEFAULT_VAD_SEGMENTER_CONFIG.energyThreshold,
    insertSilenceMs: DEFAULT_VAD_SEGMENTER_CONFIG.insertSilenceMs,
    commitSilenceMs: DEFAULT_VAD_SEGMENTER_CONFIG.commitSilenceMs,
    minTurnSpeechMs: DEFAULT_VAD_SEGMENTER_CONFIG.minTurnSpeechMs,
  });
});

test("parseLocalVadConfig reads PI_RT_LOCAL_VAD_* knobs, clamps, and falls back (bd-9399e7)", () => {
  assert.deepEqual(
    parseLocalVadConfig({
      [LOCAL_VAD_ENV_KEYS.energyThreshold]: "0.05",
      [LOCAL_VAD_ENV_KEYS.insertSilenceMs]: "800",
      [LOCAL_VAD_ENV_KEYS.commitSilenceMs]: "2500",
      [LOCAL_VAD_ENV_KEYS.minTurnSpeechMs]: "150",
    }),
    { energyThreshold: 0.05, insertSilenceMs: 800, commitSilenceMs: 2500, minTurnSpeechMs: 150 },
  );

  // energyThreshold clamps to [0,1]; the ms knobs clamp to >= 0.
  assert.equal(parseLocalVadConfig({ [LOCAL_VAD_ENV_KEYS.energyThreshold]: "5" }).energyThreshold, 1);
  assert.equal(parseLocalVadConfig({ [LOCAL_VAD_ENV_KEYS.energyThreshold]: "-1" }).energyThreshold, 0);
  assert.equal(parseLocalVadConfig({ [LOCAL_VAD_ENV_KEYS.insertSilenceMs]: "-10" }).insertSilenceMs, 0);

  // invalid / blank -> fall back to the default.
  assert.equal(
    parseLocalVadConfig({ [LOCAL_VAD_ENV_KEYS.commitSilenceMs]: "abc" }).commitSilenceMs,
    DEFAULT_VAD_SEGMENTER_CONFIG.commitSilenceMs,
  );
  assert.equal(
    parseLocalVadConfig({ [LOCAL_VAD_ENV_KEYS.commitSilenceMs]: "" }).commitSilenceMs,
    DEFAULT_VAD_SEGMENTER_CONFIG.commitSilenceMs,
  );
});

test("describeLocalVadConfig summarizes the resolved thresholds (bd-9399e7)", () => {
  assert.match(
    describeLocalVadConfig(parseLocalVadConfig({})),
    /local-vad: energy=.* insert=1000ms commit=3000ms minTurn=200ms/,
  );
});

// --- LocalVadController ---

test("LocalVadController requires a transcribe function (bd-9399e7)", () => {
  assert.throws(() => new LocalVadController({}), /requires a transcribe/);
});

test("insert transcribes the delta; commit re-transcribes the whole turn (bd-9399e7)", async () => {
  const transcribedLengths = [];
  const inserted = [];
  const sent = [];
  const controller = new LocalVadController({
    transcribe: async (buf) => {
      transcribedLengths.push(buf.length);
      return `len:${buf.length}`;
    },
    insertPartial: (text, ev) => inserted.push({ text, type: ev.type }),
    sendTurn: (text, ev) => sent.push({ text, type: ev.type }),
  });

  // 500 ms speech then 3000 ms silence -> insert (at 1s) then commit (at 3s).
  await controller.pushFrame(frame(500, { speech: true }));
  for (let pushed = 0; pushed < 3000; pushed += 100) {
    await controller.pushFrame(frame(100, { speech: false }));
  }

  assert.equal(inserted.length, 1, "exactly one provisional partial inserted");
  assert.equal(sent.length, 1, "exactly one turn sent");
  assert.equal(inserted[0].type, "insert");
  assert.equal(sent[0].type, "commit");
  // transcribe ran twice: delta on insert, whole-turn audio on commit.
  assert.equal(transcribedLengths.length, 2);
  assert.ok(transcribedLengths[1] >= transcribedLengths[0], "commit transcribes >= the insert delta");
});

test("blank transcripts insert/send nothing; transcribe errors go to onError (bd-9399e7)", async () => {
  const out = [];
  const errors = [];

  const blank = new LocalVadController({
    transcribe: async () => "   ", // whitespace -> nothing to insert/send
    insertPartial: (t) => out.push(t),
    sendTurn: (t) => out.push(t),
    onError: (err, ev) => errors.push({ msg: err.message, type: ev.type }),
  });
  await blank.pushFrame(frame(500, { speech: true }));
  await blank.flush(); // a commit whose transcript is blank
  assert.deepEqual(out, [], "blank transcript inserts/sends nothing");
  assert.deepEqual(errors, [], "a blank (non-throwing) transcript is not an error");

  const throwing = new LocalVadController({
    transcribe: async () => {
      throw new Error("stt boom");
    },
    onError: (err, ev) => errors.push({ msg: err.message, type: ev.type }),
  });
  await throwing.pushFrame(frame(500, { speech: true }));
  await throwing.flush();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].msg, "stt boom");
  assert.equal(errors[0].type, "commit");
});

test("flush finalizes an in-progress turn as a commit send (bd-9399e7)", async () => {
  const sent = [];
  const controller = new LocalVadController({
    transcribe: async () => "hello world",
    sendTurn: (t) => sent.push(t),
  });
  await controller.pushFrame(frame(500, { speech: true }));
  await controller.flush();
  assert.deepEqual(sent, ["hello world"]);
});

test("a custom segmenter config (faster commit) is honored end-to-end (bd-9399e7)", async () => {
  const sent = [];
  const controller = new LocalVadController({
    config: { insertSilenceMs: 100000, commitSilenceMs: 500 }, // commit fast, never insert
    transcribe: async () => "quick",
    insertPartial: () => assert.fail("should not insert with a huge insertSilenceMs"),
    sendTurn: (t) => sent.push(t),
  });
  await controller.pushFrame(frame(300, { speech: true }));
  for (let pushed = 0; pushed < 600; pushed += 100) {
    await controller.pushFrame(frame(100, { speech: false }));
  }
  assert.deepEqual(sent, ["quick"], "commit fires at the custom 500 ms silence");
});
