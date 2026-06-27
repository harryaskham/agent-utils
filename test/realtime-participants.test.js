import test from "node:test";
import assert from "node:assert/strict";

import {
  MODE_RT,
  MODE_CASCADE,
  ROLE_MAIN,
  ROLE_PEER,
  RT_VOICE_POOL,
  CASCADE_DEFAULT_VOICE,
  ORDER_FIXED,
  ORDER_RANDOM,
  ORDER_ROUND_ROBIN,
  DEFAULT_ORDER,
  parseOnePeerSpec,
  parsePeerSpecs,
  buildParticipantRoster,
  planTurnRound,
  describeRoster,
} from "../extensions/lib/realtime-participants.js";

// A deterministic RNG: replays a fixed sequence in [0,1), clamped/reused.
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

// ---------------------------------------------------------------------------
// parseOnePeerSpec / parsePeerSpecs
// ---------------------------------------------------------------------------

test("parseOnePeerSpec parses a bare name", () => {
  assert.deepEqual(parseOnePeerSpec("var"), { name: "var" });
  assert.deepEqual(parseOnePeerSpec("  cedar  "), { name: "cedar" });
  assert.equal(parseOnePeerSpec(""), null);
  assert.equal(parseOnePeerSpec("   "), null);
});

test("parseOnePeerSpec parses bracketed attributes with alias normalisation", () => {
  assert.deepEqual(
    parseOnePeerSpec("var[voice=marin,model=gpt-realtime-2,base_url=http://x,tts=azure-tts]"),
    { name: "var", voice: "marin", model: "gpt-realtime-2", baseUrl: "http://x", ttsModel: "azure-tts" },
  );
  // alias keys: baseurl, tts_model, persona
  assert.deepEqual(
    parseOnePeerSpec("p[baseurl=http://y,tts_model=m,persona=be terse]"),
    { name: "p", baseUrl: "http://y", ttsModel: "m", instructions: "be terse" },
  );
  // unknown keys ignored; empty values ignored
  assert.deepEqual(parseOnePeerSpec("p[bogus=1,voice=cedar,model=]"), { name: "p", voice: "cedar" });
});

test("parsePeerSpecs splits on ; or , at bracket depth zero", () => {
  assert.deepEqual(parsePeerSpecs("var,cedar"), [{ name: "var" }, { name: "cedar" }]);
  assert.deepEqual(parsePeerSpecs("var;cedar"), [{ name: "var" }, { name: "cedar" }]);
  // commas inside brackets are protected
  assert.deepEqual(
    parsePeerSpecs("var[voice=marin,model=x];cedar[voice=cedar]"),
    [
      { name: "var", voice: "marin", model: "x" },
      { name: "cedar", voice: "cedar" },
    ],
  );
  assert.deepEqual(parsePeerSpecs(""), []);
  assert.deepEqual(parsePeerSpecs(null), []);
  assert.deepEqual(parsePeerSpecs(undefined), []);
});

// ---------------------------------------------------------------------------
// buildParticipantRoster — counts
// ---------------------------------------------------------------------------

test("roster defaults to a single main participant when nothing is specified", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, env: {} });
  assert.equal(r.participants.length, 1);
  assert.equal(r.participants[0].role, ROLE_MAIN);
  assert.equal(r.participants[0].index, 0);
  assert.equal(r.mode, MODE_RT);
  assert.equal(r.order, DEFAULT_ORDER);
});

test("n counts the main agent: n=2 yields main + 1 peer", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 2, env: {} });
  assert.equal(r.participants.length, 2);
  assert.equal(r.participants[0].role, ROLE_MAIN);
  assert.equal(r.participants[1].role, ROLE_PEER);
});

test("participants= are peers beyond main; total = peers + 1", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, participants: "var,cedar", env: {} });
  assert.equal(r.participants.length, 3);
  assert.deepEqual(r.participants.map((p) => p.role), [ROLE_MAIN, ROLE_PEER, ROLE_PEER]);
  assert.deepEqual(r.participants.slice(1).map((p) => p.name), ["var", "cedar"]);
});

test("n extends the roster with auto peers beyond the explicit participants", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 4, participants: "var", env: {} });
  assert.equal(r.participants.length, 4); // main + var + 2 auto
  assert.equal(r.participants[1].name, "var");
  assert.equal(r.participants[2].role, ROLE_PEER);
  assert.equal(r.participants[3].role, ROLE_PEER);
});

test("n smaller than the participants list does not truncate explicit peers", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 1, participants: "var,cedar", env: {} });
  assert.equal(r.participants.length, 3);
});

// ---------------------------------------------------------------------------
// buildParticipantRoster — voice assignment
// ---------------------------------------------------------------------------

test("rt assigns distinct pool voices; main defaults to marin", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 3, env: {} });
  const voices = r.participants.map((p) => p.voice);
  assert.equal(voices[0], "marin");
  assert.equal(new Set(voices).size, 3, "voices should be distinct");
  for (const v of voices) assert.ok(RT_VOICE_POOL.includes(v), `${v} in pool`);
});

test("rt main voice honours env PI_RT_VOICE / OPENAI_TTS_VOICE when valid", () => {
  assert.equal(buildParticipantRoster({ mode: MODE_RT, env: { PI_RT_VOICE: "cedar" } }).participants[0].voice, "cedar");
  assert.equal(buildParticipantRoster({ mode: MODE_RT, env: { OPENAI_TTS_VOICE: "verse" } }).participants[0].voice, "verse");
  // invalid env voice falls back to marin
  assert.equal(buildParticipantRoster({ mode: MODE_RT, env: { PI_RT_VOICE: "nope" } }).participants[0].voice, "marin");
});

test("rt peers do not collide with an env/explicit main voice", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 2, env: { PI_RT_VOICE: "marin" } });
  assert.equal(r.participants[0].voice, "marin");
  assert.notEqual(r.participants[1].voice, "marin");
});

test("explicit per-peer voice overrides the pool and is lowercased in rt", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, participants: "var[voice=Cedar]", env: {} });
  assert.equal(r.participants[1].voice, "cedar");
});

test("cascade defaults every participant to the embedding voice unless overridden", () => {
  const r = buildParticipantRoster({ mode: MODE_CASCADE, n: 3, env: {} });
  assert.deepEqual(r.participants.map((p) => p.voice), [
    CASCADE_DEFAULT_VOICE, CASCADE_DEFAULT_VOICE, CASCADE_DEFAULT_VOICE,
  ]);
  // env override of the cascade default
  const r2 = buildParticipantRoster({ mode: MODE_CASCADE, n: 2, env: { PI_CASCADE_VOICE: "embedding:harry" } });
  assert.deepEqual(r2.participants.map((p) => p.voice), ["embedding:harry", "embedding:harry"]);
  // per-participant override wins, not lowercased in cascade (voices can be opaque ids)
  const r3 = buildParticipantRoster({ mode: MODE_CASCADE, participants: "var[voice=embedding:Var]", env: {} });
  assert.equal(r3.participants[1].voice, "embedding:Var");
});

// ---------------------------------------------------------------------------
// buildParticipantRoster — naming + passthrough
// ---------------------------------------------------------------------------

test("rt auto peers are named by their assigned voice; cascade auto peers are peer-N", () => {
  const rt = buildParticipantRoster({ mode: MODE_RT, n: 3, env: {} });
  assert.deepEqual(rt.participants.slice(1).map((p) => p.name), [rt.participants[1].voice, rt.participants[2].voice]);
  const casc = buildParticipantRoster({ mode: MODE_CASCADE, n: 3, env: {} });
  assert.deepEqual(casc.participants.slice(1).map((p) => p.name), ["peer-1", "peer-2"]);
});

test("duplicate names are de-duplicated", () => {
  const r = buildParticipantRoster({ mode: MODE_CASCADE, participants: "var,var", env: {} });
  assert.deepEqual(r.participants.slice(1).map((p) => p.name), ["var", "var-2"]);
});

test("per-participant model/baseUrl/ttsModel/instructions pass through; main overrides apply", () => {
  const r = buildParticipantRoster({
    mode: MODE_CASCADE,
    main: { name: "harry-bot", model: "main-model", baseUrl: "http://main", ttsModel: "azure-tts", instructions: "lead" },
    participants: "var[model=m2,base_url=http://v,tts=t2,persona=witty]",
    env: {},
  });
  assert.equal(r.participants[0].name, "harry-bot");
  assert.equal(r.participants[0].model, "main-model");
  assert.equal(r.participants[0].baseUrl, "http://main");
  assert.equal(r.participants[0].ttsModel, "azure-tts");
  assert.equal(r.participants[0].instructions, "lead");
  assert.equal(r.participants[1].model, "m2");
  assert.equal(r.participants[1].baseUrl, "http://v");
  assert.equal(r.participants[1].ttsModel, "t2");
  assert.equal(r.participants[1].instructions, "witty");
});

test("every participant has a stable index matching its position", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 5, env: {} });
  r.participants.forEach((p, i) => assert.equal(p.index, i));
});

// ---------------------------------------------------------------------------
// planTurnRound
// ---------------------------------------------------------------------------

test("single-participant round has one turn that hears nobody else", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, env: {} });
  const plan = planTurnRound(r.participants, { order: ORDER_RANDOM });
  assert.deepEqual(plan.order, [0]);
  assert.equal(plan.turns.length, 1);
  assert.deepEqual(plan.turns[0].hearsFrom, []);
  assert.equal(plan.turns[0].hearsHuman, true);
});

test("fixed order preserves roster order and chains hearsFrom", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 3, env: {} });
  const plan = planTurnRound(r.participants, { order: ORDER_FIXED });
  assert.deepEqual(plan.order, [0, 1, 2]);
  assert.deepEqual(plan.turns.map((t) => t.hearsFrom), [[], [0], [0, 1]]);
  // each turn hears the human + everyone earlier this round
  for (const t of plan.turns) assert.equal(t.hearsHuman, true);
});

test("round-robin rotates the starting agent by round", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 3, env: {} });
  assert.deepEqual(planTurnRound(r.participants, { order: ORDER_ROUND_ROBIN, round: 0 }).order, [0, 1, 2]);
  assert.deepEqual(planTurnRound(r.participants, { order: ORDER_ROUND_ROBIN, round: 1 }).order, [1, 2, 0]);
  assert.deepEqual(planTurnRound(r.participants, { order: ORDER_ROUND_ROBIN, round: 2 }).order, [2, 0, 1]);
  assert.deepEqual(planTurnRound(r.participants, { order: ORDER_ROUND_ROBIN, round: 3 }).order, [0, 1, 2]);
});

test("random order is a permutation driven by the injected rng", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 4, env: {} });
  // rng that always returns 0 -> Fisher-Yates swaps each i with index 0
  const plan = planTurnRound(r.participants, { order: ORDER_RANDOM, rng: seqRng([0]) });
  assert.equal(plan.order.length, 4);
  assert.deepEqual([...plan.order].sort((a, b) => a - b), [0, 1, 2, 3], "is a permutation");
  // hearsFrom is always the prefix of the chosen order
  plan.turns.forEach((t, p) => assert.deepEqual(t.hearsFrom, plan.order.slice(0, p)));
});

test("turn entries carry the participant name and voice for downstream routing", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 2, env: {} });
  const plan = planTurnRound(r.participants, { order: ORDER_FIXED });
  assert.equal(plan.turns[0].name, r.participants[0].name);
  assert.equal(plan.turns[0].voice, r.participants[0].voice);
  assert.equal(plan.turns[1].voice, r.participants[1].voice);
});

test("planTurnRound accepts a full roster object or a bare participants array", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 2, env: {} });
  const a = planTurnRound(r, { order: ORDER_FIXED });
  const b = planTurnRound(r.participants, { order: ORDER_FIXED });
  assert.deepEqual(a.order, b.order);
});

// ---------------------------------------------------------------------------
// describeRoster
// ---------------------------------------------------------------------------

test("describeRoster renders a compact one-liner", () => {
  const r = buildParticipantRoster({ mode: MODE_RT, n: 2, env: {} });
  const line = describeRoster(r);
  assert.match(line, /^rt 2p: /);
  assert.match(line, new RegExp(`${r.participants[0].name}\\(${r.participants[0].voice}\\)`));
});
