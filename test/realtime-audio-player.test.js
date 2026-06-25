// Direct unit tests for the realtime AudioPlayer buffering logic
// (bd-d751ee). The prebuffer/drain DECISION logic is isolated from real audio
// output by overriding the instance write() (capture drained chunks) and
// ensureFlushTimer() (no-op), so no playback process spawns and no interval
// leaks. Byte thresholds are derived from the pure pcmBytesForMs for robustness.

import test from "node:test";
import assert from "node:assert/strict";

import { AudioPlayer } from "../extensions/lib/realtime-audio-player.js";
import { pcmBytesForMs } from "../extensions/lib/realtime-audio.js";

function makePlayer(config) {
  const writes = [];
  const player = new AudioPlayer({ audioEnabled: true, bufferMs: 10, playbackChunkMs: 80, ...config }, () => {});
  player.write = (chunk) => writes.push(chunk); // intercept before ensureProcess()
  player.ensureFlushTimer = () => {}; // avoid real setInterval
  return { player, writes };
}

test("disabled player buffers nothing and reports not enabled", () => {
  const player = new AudioPlayer({ audioEnabled: false }, () => {});
  assert.equal(player.enabled, false);
  player.play(Buffer.from([1, 2, 3, 4]));
  assert.equal(player.bufferBytes, 0);
});

test("prebuffer holds chunks below bufferMs, then flushes once when crossed", () => {
  const { player, writes } = makePlayer({ bufferMs: 10 });
  const threshold = pcmBytesForMs(10);
  const small = Buffer.alloc(threshold - 2);
  player.play(small);
  assert.equal(player.flushed, false);
  assert.equal(writes.length, 0);
  assert.equal(player.bufferBytes, small.length);

  const more = Buffer.alloc(4);
  player.play(more);
  assert.equal(player.flushed, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, small.length + more.length);
  assert.equal(player.bufferBytes, 0);
});

test("after the initial flush, batching drains only at maxBufferedMs", () => {
  const { player, writes } = makePlayer({ bufferMs: 10, playbackChunkMs: 80 });
  // Cross the prebuffer threshold to enter the flushed state.
  player.play(Buffer.alloc(pcmBytesForMs(10) + 2));
  assert.equal(player.flushed, true);
  writes.length = 0;

  // maxBufferedMs = max(bufferMs=10, playbackChunkMs*3=240) = 240.
  const sub = Buffer.alloc(4);
  player.play(sub); // below 240ms worth -> batched, no drain
  assert.equal(writes.length, 0);
  assert.equal(player.bufferBytes, 4);

  player.play(Buffer.alloc(pcmBytesForMs(240))); // now over threshold -> drain
  assert.equal(writes.length, 1);
  assert.equal(player.bufferBytes, 0);
});

test("flush() drains the remaining buffer", () => {
  const { player, writes } = makePlayer({ bufferMs: 10 });
  player.play(Buffer.alloc(pcmBytesForMs(10) + 2)); // flush -> flushed
  writes.length = 0;
  player.play(Buffer.alloc(8)); // batched below maxBufferedMs
  assert.equal(writes.length, 0);
  player.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 8);
  assert.equal(player.bufferBytes, 0);
});

test("interrupt() and resetResponse() clear buffer and flushed state", () => {
  const { player } = makePlayer({ bufferMs: 10 });
  player.play(Buffer.alloc(pcmBytesForMs(10) + 2));
  player.play(Buffer.alloc(4));
  assert.equal(player.flushed, true);

  player.interrupt();
  assert.equal(player.bufferBytes, 0);
  assert.equal(player.flushed, false);
  assert.deepEqual(player.buffer, []);

  player.flushed = true;
  player.buffer = [Buffer.alloc(2)];
  player.bufferBytes = 2;
  player.resetResponse();
  assert.equal(player.bufferBytes, 0);
  assert.equal(player.flushed, false);
  assert.deepEqual(player.buffer, []);
});

test("play() ignores empty and nullish chunks", () => {
  const { player, writes } = makePlayer({ bufferMs: 10 });
  player.play(null);
  player.play(undefined);
  player.play(Buffer.alloc(0));
  assert.equal(player.bufferBytes, 0);
  assert.equal(writes.length, 0);
});

test("bufferMs <= 0 flushes immediately on the first chunk", () => {
  const { player, writes } = makePlayer({ bufferMs: 0 });
  player.play(Buffer.alloc(4));
  assert.equal(player.flushed, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 4);
  assert.equal(player.bufferBytes, 0);
});
