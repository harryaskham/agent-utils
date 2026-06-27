// Multi-participant group-chat foundation for /rt and /cascade (bd-7c6790).
//
// Pure participant-roster modelling: spec parsing, mode-aware default voice
// assignment, and turn-round planning. No I/O, no websockets, no audio — every
// function here is deterministic over its inputs (RNG is injectable) so the
// whole module is unit-tested without a live realtime session.
//
// Vocabulary
// ----------
//   participant   one AI voice in the room. Index 0 is always the "main" agent
//                 (the current Pi session); indices >= 1 are "peers".
//   roster        the ordered list of participants for a session.
//   round         one human turn fans out to one turn per participant, in some
//                 order. Each participant hears the human plus every participant
//                 that already spoke earlier in the same round (so agent B hears
//                 agent A's reply — the "agents hear each other" requirement).
//
// The two modes differ only in how a turn is realised downstream (a realtime
// websocket vs STT->text-LLM->TTS); the roster + round planning is shared.

export const MODE_RT = "rt";
export const MODE_CASCADE = "cascade";
export const MODES = new Set([MODE_RT, MODE_CASCADE]);

export const ROLE_MAIN = "main";
export const ROLE_PEER = "peer";

// Distinct realtime voices, assigned round-robin to participants in rt mode so
// each agent is audibly distinguishable (gpt-realtime requires a voice from this
// fixed set). Mirrors REALTIME_VOICES in realtime-models.js; kept as an ordered
// array here because assignment order matters.
export const RT_VOICE_POOL = [
  "marin", "cedar", "alloy", "ash", "ballad",
  "coral", "echo", "sage", "shimmer", "verse",
];

// Cascade defaults every agent to the caco azure/speech embedding voice (operator
// request 2026-06-27). It is intentionally the SAME for all participants unless
// overridden per-participant (voice=...); operators distinguish cascade agents by
// name/content or by passing explicit distinct voices. The sentinel is resolved
// to the real caco voice by the cascade orchestrator (Phase 2), not here.
export const CASCADE_DEFAULT_VOICE = "embedding:default";

// Turn-order policies for a round.
export const ORDER_FIXED = "fixed";              // roster order, every round
export const ORDER_RANDOM = "random";            // arbitrary permutation (default)
export const ORDER_ROUND_ROBIN = "round-robin";  // rotate the starting agent each round
export const ORDER_POLICIES = new Set([ORDER_FIXED, ORDER_RANDOM, ORDER_ROUND_ROBIN]);
export const DEFAULT_ORDER = ORDER_RANDOM;

// Recognised per-participant attribute keys and their normalised names. Accepts
// the same aliases the rest of the extension already tolerates (base_url, tts).
const ATTR_ALIASES = new Map([
  ["voice", "voice"],
  ["model", "model"],
  ["baseurl", "baseUrl"],
  ["base_url", "baseUrl"],
  ["openai_base_url", "baseUrl"],
  ["rt_base_url", "baseUrl"],
  ["tts", "ttsModel"],
  ["ttsmodel", "ttsModel"],
  ["tts_model", "ttsModel"],
  ["instructions", "instructions"],
  ["persona", "instructions"],
  ["prompt", "instructions"],
  ["role", "role"],
]);

/// Split `value` on any of the single-char separators in `seps`, but only at
/// bracket depth zero so `name[voice=a,model=b]` survives a comma split. Pure.
function splitTopLevel(value, seps) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of String(value)) {
    if (ch === "[") depth += 1;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && seps.includes(ch)) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/// Parse one `name` or `name[k=v,k=v,...]` spec into a normalised object.
/// Unknown attribute keys are ignored (forward-compatible). Pure.
export function parseOnePeerSpec(item) {
  const raw = String(item || "").trim();
  if (!raw) return null;
  const open = raw.indexOf("[");
  if (open === -1) return { name: raw };
  const name = raw.slice(0, open).trim();
  const close = raw.lastIndexOf("]");
  const inner = close > open ? raw.slice(open + 1, close) : raw.slice(open + 1);
  const spec = {};
  if (name) spec.name = name;
  for (const attr of splitTopLevel(inner, ",")) {
    const eq = attr.indexOf("=");
    if (eq === -1) continue;
    const key = attr.slice(0, eq).trim().toLowerCase();
    const val = attr.slice(eq + 1).trim();
    const norm = ATTR_ALIASES.get(key);
    if (norm && val) spec[norm] = val;
  }
  return spec;
}

/// Parse a `participants=` value into an array of peer specs. Items are
/// separated by `;` or `,` at bracket depth zero. Pure.
export function parsePeerSpecs(value) {
  if (value == null) return [];
  return splitTopLevel(value, ";,")
    .map(parseOnePeerSpec)
    .filter((s) => s && (s.name || Object.keys(s).length > 0));
}

/// rt main-voice default, mirroring resolveRealtimeVoice but over injected env.
function rtEnvVoice(env) {
  const raw = (env?.PI_RT_VOICE || env?.OPENAI_TTS_VOICE || env?.TTS_VOICE || "").trim().toLowerCase();
  return RT_VOICE_POOL.includes(raw) ? raw : RT_VOICE_POOL[0];
}

function cascadeEnvVoice(env) {
  const raw = (env?.PI_CASCADE_VOICE || env?.PI_RT_CASCADE_VOICE || "").trim();
  return raw || CASCADE_DEFAULT_VOICE;
}

/// Pick the next rt voice not already used; cycles the pool if exhausted.
function nextRtVoice(used) {
  for (const v of RT_VOICE_POOL) {
    if (!used.has(v)) return v;
  }
  // More participants than distinct voices: reuse deterministically.
  return RT_VOICE_POOL[used.size % RT_VOICE_POOL.length];
}

/// Build a participant roster.
///
/// @param mode          MODE_RT | MODE_CASCADE
/// @param n             total participant count INCLUDING main (>=1). Optional.
/// @param participants  `participants=` string (peers beyond main). Optional.
/// @param main          { name, voice, model, baseUrl, ttsModel, instructions } overrides for index 0.
/// @param env           env reader for defaults (injected for tests).
/// @returns { mode, order, participants: [{ index, id, name, role, voice, model, baseUrl, ttsModel, instructions }] }
export function buildParticipantRoster({
  mode = MODE_RT,
  n,
  participants = "",
  main = {},
  order = DEFAULT_ORDER,
  env = process.env,
} = {}) {
  const resolvedMode = MODES.has(mode) ? mode : MODE_RT;
  const resolvedOrder = ORDER_POLICIES.has(order) ? order : DEFAULT_ORDER;
  const peerSpecs = parsePeerSpecs(participants);

  const requested = Number.parseInt(n, 10);
  const total = Math.max(
    1,
    Number.isFinite(requested) && requested > 0 ? requested : 0,
    peerSpecs.length + 1,
  );
  const peerCount = total - 1;

  const usedVoices = new Set();
  const usedNames = new Set();
  const roster = [];

  const uniqueName = (preferred, fallback) => {
    let base = String(preferred || fallback || "").trim() || fallback;
    let name = base;
    let i = 2;
    while (usedNames.has(name.toLowerCase())) {
      name = `${base}-${i}`;
      i += 1;
    }
    usedNames.add(name.toLowerCase());
    return name;
  };

  const assignVoice = (explicit, isMain) => {
    if (explicit) {
      const v = resolvedMode === MODE_RT ? String(explicit).trim().toLowerCase() : String(explicit).trim();
      usedVoices.add(v);
      return v;
    }
    if (resolvedMode === MODE_RT) {
      const v = isMain ? rtEnvVoice(env) : nextRtVoice(usedVoices);
      usedVoices.add(v);
      return v;
    }
    // cascade: same embedding default for everyone unless overridden.
    return cascadeEnvVoice(env);
  };

  // index 0: main
  const mainName = uniqueName(main.name, "main");
  roster.push({
    index: 0,
    id: mainName.toLowerCase(),
    name: mainName,
    role: ROLE_MAIN,
    voice: assignVoice(main.voice, true),
    model: main.model ?? undefined,
    baseUrl: main.baseUrl ?? undefined,
    ttsModel: main.ttsModel ?? undefined,
    instructions: main.instructions ?? undefined,
  });

  // peers
  for (let p = 0; p < peerCount; p += 1) {
    const spec = peerSpecs[p] || {};
    const voice = assignVoice(spec.voice, false);
    const fallbackName = resolvedMode === MODE_RT ? voice : `peer-${p + 1}`;
    const name = uniqueName(spec.name, fallbackName);
    roster.push({
      index: p + 1,
      id: name.toLowerCase(),
      name,
      role: ROLE_PEER,
      voice,
      model: spec.model ?? undefined,
      baseUrl: spec.baseUrl ?? undefined,
      ttsModel: spec.ttsModel ?? undefined,
      instructions: spec.instructions ?? undefined,
    });
  }

  return { mode: resolvedMode, order: resolvedOrder, participants: roster };
}

/// Fisher-Yates shuffle of a fresh copy of `arr` using injectable `rng` (0..1). Pure.
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const k = Math.min(i, Math.max(0, j));
    [a[i], a[k]] = [a[k], a[i]];
  }
  return a;
}

/// Plan one turn round: the ordered sequence of participant indices and, for
/// each, who it hears (the human is always heard; plus every participant that
/// already spoke earlier this round). Pure given an injectable rng.
///
/// @param participants  roster array (or its .participants); length N >= 1
/// @param order         ORDER_FIXED | ORDER_RANDOM | ORDER_ROUND_ROBIN
/// @param rng           () => number in [0,1) for ORDER_RANDOM (default Math.random)
/// @param round         0-based round counter (drives ORDER_ROUND_ROBIN rotation)
/// @returns { order: number[], turns: [{ position, index, name, voice, hearsHuman, hearsFrom: number[] }] }
export function planTurnRound(participants, { order = DEFAULT_ORDER, rng = Math.random, round = 0 } = {}) {
  const roster = Array.isArray(participants) ? participants : (participants?.participants || []);
  const indices = roster.map((_, i) => i);
  const n = indices.length;

  let ordered;
  if (n <= 1) {
    ordered = indices;
  } else if (order === ORDER_FIXED) {
    ordered = indices;
  } else if (order === ORDER_ROUND_ROBIN) {
    const start = ((Number(round) || 0) % n + n) % n;
    ordered = indices.slice(start).concat(indices.slice(0, start));
  } else {
    ordered = shuffle(indices, rng);
  }

  const turns = ordered.map((index, position) => {
    const p = roster[index] || {};
    return {
      position,
      index,
      name: p.name,
      voice: p.voice,
      hearsHuman: true,
      hearsFrom: ordered.slice(0, position),
    };
  });

  return { order: ordered, turns };
}

/// Compact one-line description of a roster for status surfaces. Pure.
export function describeRoster(roster) {
  const list = Array.isArray(roster) ? roster : (roster?.participants || []);
  const mode = roster?.mode ? `${roster.mode} ` : "";
  return `${mode}${list.length}p: ${list.map((p) => `${p.name}(${p.voice})`).join(", ")}`;
}
