// AudioPlayer — buffered PCM16 playback. Extracted from realtime-agent.js
// (bd-e1914a). Self-contained over its (config, notify) constructor args plus
// the audio-module helpers; manages only instance playback state (no ctx).

import { defaultPlaybackCommand, pcmBytesForMs, runShellStream } from "./realtime-audio.js";

export class AudioPlayer {
  constructor(config, notify) {
    this.config = config;
    this.notify = notify;
    this.proc = null;
    this.buffer = [];
    this.bufferBytes = 0;
    this.flushed = false;
    this.flushTimer = null;
  }

  get enabled() { return !!this.config.audioEnabled; }

  clearFlushTimer() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  resetResponse() {
    this.clearFlushTimer();
    this.buffer = [];
    this.bufferBytes = 0;
    this.flushed = false;
  }

  ensureProcess() {
    if (!this.enabled) return null;
    if (this.proc && !this.proc.killed && this.proc.stdin?.writable) return this.proc;
    const cmd = this.config.playbackCommand || defaultPlaybackCommand();
    this.proc = runShellStream(cmd);
    this.proc.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s) {
        // Never notify from playback stderr. ffplay/pacat can emit repeated
        // diagnostics per chunk; surfacing them as Pi notifications can clutter
        // the UI and, in some modes, perturb the turn loop. Keep for /rt-status.
        this.config.lastPlaybackError = s;
      }
    });
    this.config.lastPlaybackCommand = cmd;
    this.config.lastPlaybackStartedAt = Date.now();
    this.proc.on("exit", (code, signal) => {
      this.config.lastPlaybackExit = `${code ?? "?"}${signal ? `/${signal}` : ""}`;
      this.proc = null;
    });
    return this.proc;
  }

  play(chunk) {
    if (!this.enabled || !chunk || chunk.length === 0) return;
    this.buffer.push(chunk);
    this.bufferBytes += chunk.length;

    // Initial prebuffer absorbs startup jitter before we begin writing to the
    // playback process. After that, keep batching continuously; realtime audio
    // deltas can be very small and writing each one separately to ffplay/pacat
    // is prone to choppy output.
    const bufferMs = Number(this.config.bufferMs || 0);
    if (!this.flushed && bufferMs > 0 && this.bufferBytes < pcmBytesForMs(bufferMs)) return;

    if (!this.flushed) {
      this.flushed = true;
      this.drainBuffer();
      this.ensureFlushTimer();
      return;
    }

    this.ensureFlushTimer();
    const maxBufferedMs = Math.max(bufferMs || 0, Number(this.config.playbackChunkMs || 80) * 3);
    if (maxBufferedMs > 0 && this.bufferBytes >= pcmBytesForMs(maxBufferedMs)) {
      this.drainBuffer();
    }
  }

  ensureFlushTimer() {
    if (this.flushTimer || !this.enabled) return;
    const interval = Math.max(20, Number(this.config.playbackChunkMs || 80));
    this.flushTimer = setInterval(() => this.drainBuffer(), interval);
    this.flushTimer.unref?.();
  }

  drainBuffer() {
    if (this.bufferBytes <= 0) return;
    const joined = Buffer.concat(this.buffer, this.bufferBytes);
    this.buffer = [];
    this.bufferBytes = 0;
    this.write(joined);
  }

  flush() {
    if (!this.enabled) return;
    this.drainBuffer();
    this.clearFlushTimer();
  }

  write(chunk) {
    const proc = this.ensureProcess();
    if (!proc?.stdin?.writable) return;
    try { proc.stdin.write(chunk); } catch {}
  }

  interrupt() {
    this.clearFlushTimer();
    this.buffer = [];
    this.bufferBytes = 0;
    this.flushed = false;
    if (this.proc) {
      try { this.proc.kill("SIGKILL"); } catch {}
      this.proc = null;
    }
  }

  close() {
    this.clearFlushTimer();
    if (this.proc) {
      try { this.proc.stdin?.end(); } catch {}
      try { this.proc.kill("SIGTERM"); } catch {}
      this.proc = null;
    }
  }
}
