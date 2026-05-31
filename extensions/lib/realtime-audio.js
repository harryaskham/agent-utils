// PCM/audio + duration helpers and format constants extracted from
// realtime-agent.js (bd-e1914a). These are pure functions over their inputs
// plus the fixed realtime PCM format (24 kHz, mono, 16-bit). Behavior is
// unchanged from the original inline definitions.

import { spawn } from "node:child_process";

export const SAMPLE_RATE = 24000;
export const CHANNELS = 1;
export const SAMPLE_WIDTH = 2;

export function pcmBytesForMs(ms) {
  return Math.floor(SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH * ms / 1000);
}

export function synthTone({ frequency = 660, durationMs = 90, gain = 0.16 } = {}) {
  const samples = Math.max(1, Math.floor(SAMPLE_RATE * durationMs / 1000));
  const pcm = Buffer.alloc(samples * SAMPLE_WIDTH);
  const fadeSamples = Math.max(1, Math.floor(samples * 0.12));
  for (let i = 0; i < samples; i++) {
    const fadeIn = Math.min(1, i / fadeSamples);
    const fadeOut = Math.min(1, (samples - i - 1) / fadeSamples);
    const envelope = Math.max(0, Math.min(fadeIn, fadeOut));
    const value = Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE) * gain * envelope;
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(value * 32767))), i * SAMPLE_WIDTH);
  }
  return pcm;
}

export function concatPcm(...buffers) { return Buffer.concat(buffers.filter(Boolean)); }

export function chimePcm(kind) {
  if (kind === "listen") return concatPcm(synthTone({ frequency: 660, durationMs: 70 }), synthTone({ frequency: 880, durationMs: 70 }));
  if (kind === "speech-start") return synthTone({ frequency: 880, durationMs: 85, gain: 0.14 });
  if (kind === "speech-end") return synthTone({ frequency: 440, durationMs: 90, gain: 0.14 });
  return synthTone({ frequency: 660, durationMs: 80 });
}

export function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0.0s";
  return `${(ms / 1000).toFixed(1)}s`;
}

export function audioDurationMs(buffer) {
  return Math.round((buffer.length / (SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH)) * 1000);
}

export function audioInputBackendLabel(config) {
  if (config.recordCommand) return "in:custom";
  const backend = (process.env.PI_RT_AUDIO_BACKEND || "").toLowerCase();
  if (["pulse", "pulseaudio", "pacat", "parec"].includes(backend)) return "in:pulse";
  // AudioToolbox is output-only on macOS; input still uses AVFoundation.
  if (["coreaudio", "audiotoolbox", "ffmpeg"].includes(backend)) return "in:avfoundation";
  if (["sox", "rec", "play"].includes(backend)) return "in:sox";
  if (process.env.PULSE_SERVER) return "in:pulse";
  return "in:sox";
}

export function audioOutputBackendLabel(config) {
  if (config.playbackCommand) return "out:custom";
  const backend = (process.env.PI_RT_AUDIO_BACKEND || "").toLowerCase();
  if (["pulse", "pulseaudio", "pacat", "paplay"].includes(backend)) return "out:pulse";
  if (["sox", "play"].includes(backend)) return "out:sox";
  if (backend === "audiotoolbox") return "out:audiotoolbox";
  if (backend === "coreaudio") return "out:coreaudio";
  if (backend === "ffplay" || backend === "ffmpeg") return `out:${backend}`;
  if (process.env.PULSE_SERVER) return "out:pulse";
  return "out:ffplay";
}

export function defaultRecordCommand() {
  if (process.env.PI_RT_RECORD_CMD) return process.env.PI_RT_RECORD_CMD;
  const backend = (process.env.PI_RT_AUDIO_BACKEND || "").toLowerCase();
  const inputDevice = process.env.PI_RT_INPUT_DEVICE || process.env.PI_RT_MIC_DEVICE || "0";
  if (["pulse", "pulseaudio", "pacat", "parec"].includes(backend)) {
    return "parec --raw --format=s16le --rate=24000 --channels=1";
  }
  if (["sox", "rec"].includes(backend)) {
    return "rec -q -t raw -b 16 -e signed-integer -r 24000 -c 1 -";
  }
  if (["coreaudio", "audiotoolbox", "ffmpeg"].includes(backend)) {
    // avfoundation audio input indexes can be listed with:
    //   ffmpeg -f avfoundation -list_devices true -i ""
    // Index 0 is often the current/default input, but macOS does not expose a
    // stable "default" token here. Override with PI_RT_INPUT_DEVICE.
    return `ffmpeg -hide_banner -loglevel error -f avfoundation -i ':${inputDevice}' -ac 1 -ar 24000 -f s16le -`;
  }
  if (process.env.PULSE_SERVER) {
    return "parec --raw --format=s16le --rate=24000 --channels=1";
  }
  return "rec -q -t raw -b 16 -e signed-integer -r 24000 -c 1 -";
}

export function defaultPlaybackCommand() {
  if (process.env.PI_RT_PLAYBACK_CMD) return process.env.PI_RT_PLAYBACK_CMD;
  const backend = (process.env.PI_RT_AUDIO_BACKEND || "").toLowerCase();
  const outDevice = process.env.PI_RT_OUTPUT_DEVICE || process.env.PI_RT_SPEAKER_DEVICE || "";
  // Explicit backend always wins over PULSE_SERVER. The default is explicitly
  // set to pulse above; only the separate auto mode should infer Pulse merely
  // because PULSE_SERVER exists.
  if (["pulse", "pulseaudio", "pacat", "paplay"].includes(backend)) {
    return "pacat --playback --raw --format=s16le --rate=24000 --channels=1";
  }
  if (backend === "sox" || backend === "play") {
    return "play -q -t raw -b 16 -e signed-integer -r 24000 -c 1 -";
  }
  if (backend === "audiotoolbox") {
    // ffmpeg's AudioToolbox muxer allows picking a CoreAudio output device by
    // index. List devices via /rt-devices. Without an explicit device the
    // system default output is used.
    const idx = outDevice ? `-audio_device_index ${outDevice} ` : "";
    return `ffmpeg -hide_banner -loglevel error -f s16le -ar 24000 -ac 1 -i - -f audiotoolbox ${idx}-`;
  }
  if (["coreaudio", "ffplay", "ffmpeg"].includes(backend)) {
    // ffplay routes through SDL/CoreAudio and follows the macOS system default
    // output. ffmpeg 8 ffplay no longer accepts `-ac 1`; use `-ch_layout mono`.
    return "ffplay -nodisp -autoexit -loglevel error -f s16le -ar 24000 -ch_layout mono -i -";
  }
  if (process.env.PULSE_SERVER) {
    return "pacat --playback --raw --format=s16le --rate=24000 --channels=1";
  }
  return "ffplay -nodisp -autoexit -loglevel error -f s16le -ar 24000 -ch_layout mono -i -";
}

// Shell/audio-playback plumbing extracted from realtime-agent.js (bd-e1914a).
// runShellStream spawns a detached `/bin/sh -lc` pipe with no-op error handlers
// so an EPIPE/exit never bubbles into an unhandled 'error' that takes down the
// host; playPcmBuffer streams a PCM buffer into a playback command and resolves
// when the process exits. Both are pure over their inputs (no ctx/module state).
export function runShellStream(command) {
  const proc = spawn("/bin/sh", ["-lc", command], { stdio: ["pipe", "pipe", "pipe"] });
  // Default error handlers so an EPIPE / exit never bubbles into an
  // Unhandled 'error' event that takes down the host.
  proc.on("error", () => {});
  proc.stdin?.on("error", () => {});
  proc.stdout?.on("error", () => {});
  proc.stderr?.on("error", () => {});
  return proc;
}

export function playPcmBuffer(buffer, command, notify, debug = false) {
  return new Promise((resolve) => {
    const proc = runShellStream(command || defaultPlaybackCommand());
    proc.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s && debug) notify?.(`replay: ${s}`, "warning");
    });
    proc.on("exit", () => resolve());
    proc.on("close", () => resolve());
    try {
      proc.stdin.write(buffer);
      proc.stdin.end();
    } catch {
      resolve();
    }
  });
}
