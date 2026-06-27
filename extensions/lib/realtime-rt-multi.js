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

// Realtime event types that carry a participant's OUTPUT (the GA and beta names).
export const AUDIO_DELTA_TYPES = new Set(["response.audio.delta", "response.output_audio.delta"]);
export const TRANSCRIPT_DELTA_TYPES = new Set(["response.audio_transcript.delta", "response.output_audio_transcript.delta"]);
export const RESPONSE_DONE_TYPES = new Set(["response.done", "response.completed"]);

/// Accumulates one realtime response's OUTPUT audio (PCM) and transcript from the
/// session event stream — the complement to buildAudioInjectionEvents. In the
/// audio-native /rt round we collect speaker A's output with this, then feed its
/// `.pcm()` into the next session via buildHearAndRespondEvents and add `.text()`
/// to context. Mirrors the single-session collection in realtime-agent.js
/// (Buffer.from(delta, "base64") chunks + Buffer.concat). Pure over its inputs;
/// `decode` is injectable for tests.
export class RtOutputCollector {
  constructor({ decode } = {}) {
    this.decode = typeof decode === "function" ? decode : (d) => Buffer.from(String(d ?? ""), "base64");
    this.reset();
  }

  /// Offer one realtime event. Returns true if it was an audio/transcript/done
  /// event this collector consumed, false otherwise.
  accept(event) {
    const type = event?.type;
    if (!type) return false;
    if (AUDIO_DELTA_TYPES.has(type)) {
      if (event.delta) {
        const buf = this.decode(event.delta);
        if (buf && buf.length) { this.chunks.push(buf); this.bytes += buf.length; }
      }
      return true;
    }
    if (TRANSCRIPT_DELTA_TYPES.has(type)) {
      this.transcript += String(event.delta ?? event.transcript ?? "");
      return true;
    }
    if (RESPONSE_DONE_TYPES.has(type)) {
      this.done = true;
      return true;
    }
    return false;
  }

  /// The concatenated PCM output so far (empty buffer if none).
  pcm() {
    return this.bytes ? Buffer.concat(this.chunks, this.bytes) : Buffer.alloc(0);
  }

  /// The trimmed transcript text so far.
  text() {
    return this.transcript.trim();
  }

  reset() {
    this.chunks = [];
    this.bytes = 0;
    this.transcript = "";
    this.done = false;
  }
}
