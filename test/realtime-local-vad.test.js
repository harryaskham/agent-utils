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

test("insert re-drafts the whole turn; commit re-transcribes and sends (bd-9399e7)", async () => {
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
  await controller.flush(); // drain the async (off-ingestion) transcription pump

  assert.equal(inserted.length, 1, "exactly one provisional partial inserted");
  assert.equal(sent.length, 1, "exactly one turn sent");
  assert.equal(inserted[0].type, "insert");
  assert.equal(sent[0].type, "commit");
  // transcribe ran twice, BOTH over the whole turn-so-far (re-draft, not delta);
  // the commit carries more trailing silence so its audio is >= the insert's.
  assert.equal(transcribedLengths.length, 2);
  assert.ok(transcribedLengths[1] >= transcribedLengths[0], "commit re-draft >= the insert re-draft");
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

test("pushFrame re-frames arbitrary-size capture chunks into fixed VAD frames (bd-343617)", async () => {
  const inserted = [];
  const sent = [];
  const controller = new LocalVadController({
    transcribe: async () => "ok",
    insertPartial: () => inserted.push(1),
    sendTurn: () => sent.push(1),
  });
  // A speech chunk that is NOT a 100 ms multiple (350 ms) then odd-sized silence
  // chunks totaling > 3000 ms -> still exactly one insert then one commit, proving
  // segmentation is driven by re-framed 100 ms windows, not the raw chunk sizes.
  await controller.pushFrame(frame(350, { speech: true }));
  for (const ms of [250, 137, 313, 200, 400, 100, 350, 250, 500, 600, 300]) {
    await controller.pushFrame(frame(ms, { speech: false }));
  }
  await controller.flush(); // drain the async transcription pump
  assert.equal(inserted.length, 1, "one insert despite unaligned chunk sizes");
  assert.equal(sent.length, 1, "one commit despite unaligned chunk sizes");
});

test("pushFrame buffers a sub-frame remainder until flush (bd-343617)", async () => {
  const sent = [];
  const controller = new LocalVadController({
    transcribe: async () => "x",
    sendTurn: () => sent.push(1),
  });
  // 250 ms of speech delivered as five 50 ms chunks (each below the 100 ms frame
  // size): nothing should commit until flush handles the buffered remainder.
  for (let i = 0; i < 5; i++) await controller.pushFrame(frame(50, { speech: true }));
  assert.equal(sent.length, 0, "no commit while only sub-frame chunks have arrived");
  await controller.flush();
  assert.equal(sent.length, 1, "flush finalizes the buffered audio as one commit");
});

test("pushFrame serializes concurrent un-awaited calls so a slow transcribe cannot race (bd-e72d23)", async () => {
  const inserted = [];
  const sent = [];
  let inTranscribe = 0;
  let maxConcurrent = 0;
  const controller = new LocalVadController({
    // Deliberately-slow transcribe: a naive (unserialized) controller would let a
    // later chunk's framing interleave while this awaits, corrupting shared state.
    transcribe: async (buf) => {
      inTranscribe += 1;
      maxConcurrent = Math.max(maxConcurrent, inTranscribe);
      await new Promise((r) => setTimeout(r, 5));
      inTranscribe -= 1;
      return `len:${buf.length}`;
    },
    insertPartial: () => inserted.push(1),
    sendTurn: () => sent.push(1),
  });
  // Fire chunks WITHOUT awaiting (exactly as the live capture's 'data' handler
  // does): 350 ms speech then odd-sized silence chunks summing > 3000 ms.
  const pending = [controller.pushFrame(frame(350, { speech: true }))];
  for (const ms of [250, 137, 313, 200, 400, 100, 350, 250, 500, 600, 300]) {
    pending.push(controller.pushFrame(frame(ms, { speech: false })));
  }
  await Promise.all(pending);
  await controller.flush();
  assert.equal(maxConcurrent, 1, "transcribe never runs concurrently with itself");
  assert.equal(inserted.length, 1, "exactly one insert despite overlapping un-awaited calls");
  assert.equal(sent.length, 1, "exactly one commit despite overlapping un-awaited calls");
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
  await controller.flush(); // drain the async transcription pump
  assert.deepEqual(sent, ["quick"], "commit fires at the custom 500 ms silence");
});

test("multi-segment turn with a slow transcribe still commits — re-draft pump never stalls segmentation (bd-9399e7)", async () => {
  // Regression for the bug live mic testing surfaced: provisional transcribes ran
  // INSIDE the frame-ingestion path, so a slow model stalled the silence clock and
  // a multi-segment turn grew forever without ever committing. Now segmentation is
  // synchronous and transcription is a single-flight pump off the ingestion path.
  const sent = [];
  let inFlight = 0, maxConcurrent = 0, calls = 0;
  const controller = new LocalVadController({
    transcribe: async (buf) => {
      calls += 1; inFlight += 1; maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return `t:${buf.length}`;
    },
    insertPartial: () => {},
    sendTurn: (t) => sent.push(t),
  });

  // 5 speech segments separated by 1.2s gaps (each > insert 1s, < commit 3s) then a
  // final 3s silence — fired un-awaited exactly like the live capture 'data' handler.
  const pending = [];
  for (let seg = 0; seg < 5; seg++) {
    pending.push(controller.pushFrame(frame(300, { speech: true })));
    for (let s = 0; s < 1200; s += 100) pending.push(controller.pushFrame(frame(100, { speech: false })));
  }
  for (let s = 0; s < 3000; s += 100) pending.push(controller.pushFrame(frame(100, { speech: false })));

  // CRUX: after the synchronous un-awaited feed, segmentation has ALREADY reached
  // the commit without waiting on the slow transcribe (the old design stalled here).
  assert.ok(
    controller._pendingCommit || sent.length > 0,
    "segmentation reaches commit synchronously, not blocked by the transcribe",
  );

  await Promise.all(pending);
  await controller.flush();

  assert.equal(sent.length, 1, "the multi-segment turn commits and sends exactly once");
  assert.equal(maxConcurrent, 1, "transcription stays single-flight");
  assert.ok(calls <= 3, `re-drafts coalesce instead of piling up one-per-gap (got ${calls} transcribes for 6 insert gaps + 1 commit)`);
});

test("onState surfaces listening immediately on speech, then transcribing, then idle (bd-71d4fb)", async () => {
  const states = [];
  const controller = new LocalVadController({
    transcribe: async () => "hi",
    onState: (s) => states.push(s),
    sendTurn: () => {},
  });
  // 300 ms speech (3 frames) then 3000 ms silence -> listening (once) -> draft
  // transcribe -> commit -> idle.
  await controller.pushFrame(frame(300, { speech: true }));
  for (let s = 0; s < 3000; s += 100) await controller.pushFrame(frame(100, { speech: false }));
  await controller.flush();

  assert.equal(states[0], "listening", "listening fires on the first speech frame, before any insert");
  assert.equal(states.filter((s) => s === "listening").length, 1, "listening fires once per turn, not per speech frame");
  assert.ok(states.includes("transcribing"), "transcribing fires when a draft starts");
  assert.equal(states.at(-1), "idle", "idle fires after the turn is sent");
});
