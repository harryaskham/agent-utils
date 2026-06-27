// Foundation primitives for the audio-native /rt multi-participant group chat
// (bd-07bb7f, child of bd-7c6790). In that mode each participant has its own
// realtime websocket, and on a turn we feed the PRIOR speaker's OUTPUT audio into
// the NEXT participant's INPUT so it literally hears them. The realtime protocol
// for "make session B hear this PCM and respond" is:
//
//   input_audio_buffer.append { audio: <base64 pcm16/24k mono> }   (one per chunk)
//   input_audio_buffer.commit
//   response.create { response: <responseObj> }
//
// These builders are PURE so the wire-event construction is unit-tested without a
// live websocket; the multi-session orchestration that consumes them needs live
// realtime validation (tracked on bd-07bb7f). The turn ORDER + who-hears-whom is
// already provided by planTurnRound in realtime-participants.js.

import { b64 } from "./realtime-helpers.js";

// ~0.33s of pcm16 / 24kHz / mono per append chunk (24000 * 2 bytes * 0.33).
export const DEFAULT_AUDIO_CHUNK_BYTES = 16000;

/// Split a PCM buffer into <= chunkBytes slices (zero-copy subarrays). Pure.
export function chunkBuffer(buffer, chunkBytes = DEFAULT_AUDIO_CHUNK_BYTES) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const size = Math.max(1, Math.floor(Number(chunkBytes) || DEFAULT_AUDIO_CHUNK_BYTES));
  const out = [];
  for (let i = 0; i < buf.length; i += size) {
    out.push(buf.subarray(i, Math.min(buf.length, i + size)));
  }
  return out;
}

/// Build the realtime events that make a session hear `pcmBuffer` and (by default)
/// commit it, ready to be triggered with a response.create. Returns [] for empty
/// audio (nothing to inject). `encode`/`chunkBytes`/`commit` are injectable. Pure.
export function buildAudioInjectionEvents(pcmBuffer, { chunkBytes = DEFAULT_AUDIO_CHUNK_BYTES, encode = b64, commit = true } = {}) {
  const chunks = chunkBuffer(pcmBuffer, chunkBytes).filter((c) => c.length > 0);
  const events = chunks.map((c) => ({ type: "input_audio_buffer.append", audio: encode(c) }));
  if (commit && events.length) events.push({ type: "input_audio_buffer.commit" });
  return events;
}

/// Build a response.create event (optionally with a response object). Pure.
export function buildResponseCreateEvent(responseObj) {
  return responseObj && typeof responseObj === "object"
    ? { type: "response.create", response: responseObj }
    : { type: "response.create" };
}

/// Build the full event sequence to inject one speaker's audio into a listener
/// session and trigger its turn: append(s) + commit + response.create. Pure.
export function buildHearAndRespondEvents(pcmBuffer, { chunkBytes = DEFAULT_AUDIO_CHUNK_BYTES, encode = b64, responseObj } = {}) {
  const events = buildAudioInjectionEvents(pcmBuffer, { chunkBytes, encode, commit: true });
  events.push(buildResponseCreateEvent(responseObj));
  return events;
}
