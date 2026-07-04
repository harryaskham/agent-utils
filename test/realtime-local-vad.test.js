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

test("onState fires the overlong hint for gapless continuous audio, not once a turn has had a pause (bd-71d4fb)", async () => {
  // Continuous speech with NO silence gap never inserts and never commits (the
  // over-sensitive-threshold / constant-noise "stuck on listening" signature) ->
  // exactly one "overlong" hint once turnSpeechMs crosses overlongHintMs.
  {
    const states = [];
    const c = new LocalVadController({ transcribe: async () => "x", onState: (s) => states.push(s), overlongHintMs: 1000 });
    for (let i = 0; i < 15; i++) await c.pushFrame(frame(100, { speech: true }));
    assert.equal(states.filter((s) => s === "overlong").length, 1, "overlong fires once for gapless continuous audio");
  }
  // A turn that HAS had a silence gap (it inserted) must NOT get the hint, even
  // after it accrues more speech past the threshold — that is normal long speech.
  {
    const states = [];
    const c = new LocalVadController({ transcribe: async () => "x", onState: (s) => states.push(s), insertPartial: () => {}, sendTurn: () => {}, overlongHintMs: 1000 });
    await c.pushFrame(frame(300, { speech: true }));
    for (let s = 0; s < 1100; s += 100) await c.pushFrame(frame(100, { speech: false })); // insert at 1000 ms silence
    await c.pushFrame(frame(800, { speech: true })); // turnSpeechMs ~1100 > 1000, but already inserted
    for (let s = 0; s < 3000; s += 100) await c.pushFrame(frame(100, { speech: false }));
    await c.flush();
    assert.equal(states.filter((s) => s === "overlong").length, 0, "no overlong hint once the turn has had a silence gap");
  }
});

test("isSuppressed drops mic frames while the assistant speaks, resumes after (half-duplex, bd-ddc391)", async () => {
  const sent = [];
  let speaking = true;
  const controller = new LocalVadController({
    transcribe: async () => "echo",
    sendTurn: (t) => sent.push(t),
    isSuppressed: () => speaking,
  });
  // While suppressed: a full speak+silence turn segments nothing (frames dropped).
  await controller.pushFrame(frame(500, { speech: true }));
  for (let s = 0; s < 3000; s += 100) await controller.pushFrame(frame(100, { speech: false }));
  await controller.flush();
  assert.equal(sent.length, 0, "no turn while the assistant is speaking (mic dropped)");

  // Once suppression lifts, a real turn is captured + committed normally.
  speaking = false;
  await controller.pushFrame(frame(500, { speech: true }));
  for (let s = 0; s < 3000; s += 100) await controller.pushFrame(frame(100, { speech: false }));
  await controller.flush();
  assert.equal(sent.length, 1, "turn captured once the release window passes");
  assert.equal(sent[0], "echo");
});

test("bd-7b43b2: suppression opening during the human's trailing silence still commits (not stranded)", async () => {
  const sent = [];
  const transcribed = [];
  let speaking = false;
  const controller = new LocalVadController({
    transcribe: async (buf) => { transcribed.push(buf.length); return "human turn"; },
    sendTurn: (t) => sent.push(t),
    isSuppressed: () => speaking,
  });
  // Human speaks while NOT suppressed -> a turn is open in the segmenter.
  await controller.pushFrame(frame(800, { speech: true }));
  assert.ok(controller.segmenter.turnSpeechMs > 0, "human turn is open before suppression");
  // The half-duplex window opens right as the human goes silent (cascade: a peer
  // TTS window or a stale assistant-speaking mark overlapping the trailing silence).
  // Pre-fix, every trailing-silence frame was dropped and the open turn was stranded
  // (never reached commitSilenceMs) -> "only /cascade say works".
  speaking = true;
  for (let s = 0; s < 4000; s += 100) await controller.pushFrame(frame(100, { speech: false }));
  await controller._drain(); // pump only; do NOT flush (flush would force-commit and mask the bug)
  assert.equal(sent.length, 1, "suppressed silence advances the clock so the open turn commits");
  assert.equal(sent[0], "human turn");
  // The committed audio is the pre-suppression speech; zeroed silence carries no
  // echo, so the assistant's own audio is still never transcribed.
  assert.ok(transcribed.length >= 1, "the human's captured speech was transcribed and sent");
});

test("bd-7b43b2: suppressed-with-no-open-turn stays silent (assistant echo never starts a turn)", async () => {
  const sent = [];
  let speaking = true; // suppressed from the very start (pure echo, no human turn open)
  const controller = new LocalVadController({
    transcribe: async () => "echo",
    sendTurn: (t) => sent.push(t),
    isSuppressed: () => speaking,
  });
  // A full speak+silence run while suppressed must segment nothing: with no open
  // turn (turnSpeechMs stays 0) the fix injects no synthetic silence either.
  await controller.pushFrame(frame(500, { speech: true }));
  for (let s = 0; s < 4000; s += 100) await controller.pushFrame(frame(100, { speech: false }));
  await controller._drain();
  assert.equal(sent.length, 0, "no turn is ever started or committed from suppressed audio alone");
  assert.equal(controller.segmenter.turnSpeechMs, 0, "no open turn accrued while suppressed");
});

// --- LocalVadController hold-commits / PTT mode (bd-9e06ae) ---

test("holdCommits accumulates per-segment VAD commits and sends once on commitHeld (bd-9e06ae)", async () => {
  const sent = [];
  let seg = 0;
  const controller = new LocalVadController({
    holdCommits: true,
    config: { insertSilenceMs: 100000, commitSilenceMs: 500 }, // commit-only, no drafts
    transcribe: async () => `seg${++seg}`,
    insertPartial: () => {},
    sendTurn: (t) => sent.push(t),
  });

  // Two speech-then-silence segments, each reaching the (fast) commit silence.
  for (let n = 0; n < 2; n++) {
    await controller.pushFrame(frame(300, { speech: true }));
    for (let s = 0; s < 600; s += 100) await controller.pushFrame(frame(100, { speech: false }));
    await controller._drain();
  }
  // The VAD silence 'commit' of each segment must NOT send in PTT-hold mode.
  assert.deepEqual(sent, [], "per-segment VAD silence does not send in PTT-hold mode");

  // PTT release: send the whole accumulated turn as a single message.
  const finalText = await controller.commitHeld();
  assert.equal(sent.length, 1, "commitHeld sends exactly one combined turn");
  assert.equal(sent[0], finalText);
  assert.equal(sent[0], "seg1 seg2", "the combined turn joins the accumulated segments in order");
});

test("finalizeHeldToEditor writes the accrued turn to the editor without sending (bd-4daaf5)", async () => {
  const sent = [];
  const inserted = [];
  let seg = 0;
  const controller = new LocalVadController({
    holdCommits: true,
    config: { insertSilenceMs: 100000, commitSilenceMs: 500 },
    transcribe: async () => `seg${++seg}`,
    insertPartial: (t) => inserted.push(t),
    sendTurn: (t) => sent.push(t),
  });
  // Two committed segments accrue in PTT-hold mode.
  for (let n = 0; n < 2; n++) {
    await controller.pushFrame(frame(300, { speech: true }));
    for (let s = 0; s < 600; s += 100) await controller.pushFrame(frame(100, { speech: false }));
    await controller._drain();
  }
  // Early exit (Esc): finalize the accrual INTO the editor, do NOT send.
  const text = await controller.finalizeHeldToEditor();
  assert.equal(text, "seg1 seg2");
  assert.deepEqual(sent, [], "early-exit does NOT dispatch a message");
  assert.equal(inserted.at(-1), "seg1 seg2", "the accrued turn is written to the editor via insertPartial");
  // The accrual is cleared, so a later commitHeld sends nothing.
  const after = await controller.commitHeld();
  assert.equal(after, "", "held accrual cleared after finalizeHeldToEditor");
  assert.deepEqual(sent, [], "still nothing sent after early exit");
});

test("holdCommits renders incremental partials but defers the send to commitHeld (bd-9e06ae)", async () => {
  const partials = [];
  const sent = [];
  const controller = new LocalVadController({
    holdCommits: true,
    transcribe: async () => "hello",
    insertPartial: (t) => partials.push(t),
    sendTurn: (t) => sent.push(t),
  });
  // 500 ms speech then 3 s silence -> insert (draft partial) at 1 s, commit at 3 s.
  await controller.pushFrame(frame(500, { speech: true }));
  for (let s = 0; s < 3000; s += 100) await controller.pushFrame(frame(100, { speech: false }));
  await controller._drain();
  assert.ok(partials.length >= 1, "incremental partials still render in hold mode (just as normal VAD)");
  assert.deepEqual(sent, [], "the segment's VAD commit accumulates instead of sending");
  const text = await controller.commitHeld();
  assert.equal(text, "hello");
  assert.deepEqual(sent, ["hello"], "commitHeld sends the accumulated turn on release");
});

test("commitHeld finalizes an in-progress segment released mid-speech (no VAD-silence yet, bd-9e06ae)", async () => {
  const sent = [];
  const controller = new LocalVadController({
    holdCommits: true,
    transcribe: async () => "mid",
    sendTurn: (t) => sent.push(t),
  });
  // Speech with NO trailing commit-silence: PTT released while still speaking/held.
  await controller.pushFrame(frame(800, { speech: true }));
  assert.deepEqual(sent, [], "nothing sent before release");
  const text = await controller.commitHeld();
  assert.equal(text, "mid", "flush finalizes the in-progress segment on release");
  assert.deepEqual(sent, ["mid"]);
});

test("discardHeld drops the accumulated turn without sending (PTT cancel, bd-9e06ae)", async () => {
  const sent = [];
  const controller = new LocalVadController({
    holdCommits: true,
    config: { insertSilenceMs: 100000, commitSilenceMs: 500 },
    transcribe: async () => "x",
    sendTurn: (t) => sent.push(t),
  });
  await controller.pushFrame(frame(300, { speech: true }));
  for (let s = 0; s < 600; s += 100) await controller.pushFrame(frame(100, { speech: false }));
  await controller._drain();
  controller.discardHeld();
  const text = await controller.commitHeld();
  assert.equal(text, "", "nothing remains to send after discard");
  assert.deepEqual(sent, [], "discardHeld sends nothing (PTT cancel)");
});

test("commitHeld in non-hold mode degrades to a plain flush with no duplicate send (bd-9e06ae)", async () => {
  const sent = [];
  const controller = new LocalVadController({
    transcribe: async () => "normal",
    sendTurn: (t) => sent.push(t),
  });
  // Normal VAD already sends on the silence commit.
  await controller.pushFrame(frame(500, { speech: true }));
  for (let s = 0; s < 3000; s += 100) await controller.pushFrame(frame(100, { speech: false }));
  await controller._drain();
  assert.deepEqual(sent, ["normal"], "non-hold VAD sends on silence as usual");
  const extra = await controller.commitHeld();
  assert.equal(extra, "", "commitHeld contributes nothing extra in non-hold mode");
  assert.deepEqual(sent, ["normal"], "no duplicate send from commitHeld");
});
