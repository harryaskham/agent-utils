// PCM/audio + duration helpers and format constants extracted from
// realtime-agent.js (bd-e1914a). These are pure functions over their inputs
// plus the fixed realtime PCM format (24 kHz, mono, 16-bit). Behavior is
// unchanged from the original inline definitions.

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
