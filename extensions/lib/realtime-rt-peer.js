// Audio-native /rt peer-turn adapter (bd-07bb7f, child of bd-7c6790).
//
// `runPeerTurn` is the concrete `injectAndRespond` the rt-multi orchestrator
// (runRtMultiRound) calls for each participant: it injects the to-hear audio into
// one realtime peer session, triggers its response, and collects the spoken output
// (PCM + transcript) until the response completes. It is built entirely from the
// already-tested primitives (buildHearAndRespondEvents + RtOutputCollector), and
// it is decoupled from any concrete websocket via two small injected callbacks:
//
//   send(event)            dispatch one realtime event to the session
//   onEvent(handler) -> fn register an incoming-event handler; returns unsubscribe
//
// so the whole inject/collect flow is unit-tested with a mock session. The only
// thing this module does NOT own is opening the actual N parallel websockets and
// wiring send/onEvent to a live realtime endpoint — that thin connect glue is the
// one piece that needs a live endpoint to validate.
//
// Audio model (the part to confirm live): the to-hear segments (human + each
// earlier speaker) are CONCATENATED into a single input_audio_buffer before the
// commit, so the peer hears them as one continuous clip. If live testing shows
// separate conversation items work better, that change is localized here.

import { buildHearAndRespondEvents, RtOutputCollector } from "./realtime-rt-multi.js";

function concatSegments(audioSegments) {
  const bufs = (Array.isArray(audioSegments) ? audioSegments : [])
    .map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b || [])))
    .filter((b) => b.length > 0);
  return bufs.length ? Buffer.concat(bufs) : Buffer.alloc(0);
}

/// Run one peer turn: inject `audioSegments` into a session and resolve with its
/// collected `{ pcm, text }` when the response completes. Rejects on timeout or a
/// send/subscribe error. `send`/`onEvent` are injected; everything else is pure.
export function runPeerTurn({
  send,
  onEvent,
  audioSegments = [],
  responseObj,
  chunkBytes,
  encode,
  timeoutMs = 60000,
} = {}) {
  return new Promise((resolve, reject) => {
    if (typeof send !== "function") { reject(new Error("runPeerTurn requires a send(event) dep")); return; }
    if (typeof onEvent !== "function") { reject(new Error("runPeerTurn requires an onEvent(handler) dep")); return; }
    const collector = new RtOutputCollector();
    let unsub = null;
    let timer = null;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (typeof unsub === "function") { try { unsub(); } catch {} }
      fn(arg);
    };
    try {
      unsub = onEvent((event) => {
        collector.accept(event);
        if (collector.done) finish(resolve, { pcm: collector.pcm(), text: collector.text() });
      });
    } catch (err) {
      reject(err);
      return;
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => finish(reject, new Error("peer turn timed out")), timeoutMs);
      timer.unref?.();
    }
    try {
      const pcm = concatSegments(audioSegments);
      for (const ev of buildHearAndRespondEvents(pcm, { chunkBytes, encode, responseObj })) {
        send(ev);
      }
    } catch (err) {
      finish(reject, err);
    }
  });
}

/// Adapt a set of peer sessions into the `injectAndRespond(index, segments, turn)`
/// dep that runRtMultiRound expects. `sessions[index]` must expose `send` and
/// `onEvent`. The live glue is just building those session objects.
export function makeInjectAndRespond(sessions, { responseObj, chunkBytes, encode, timeoutMs } = {}) {
  return (index, audioSegments) => {
    const session = sessions?.[index];
    if (!session || typeof session.send !== "function" || typeof session.onEvent !== "function") {
      return Promise.reject(new Error(`rt peer session ${index} missing send/onEvent`));
    }
    return runPeerTurn({
      send: session.send.bind(session),
      onEvent: session.onEvent.bind(session),
      audioSegments,
      responseObj,
      chunkBytes,
      encode,
      timeoutMs,
    });
  };
}
