// Durable adaptor: /tts, /narrate and ask_user choice audio for pi-daemon (bd-832b7a).
//
// List this file in a pi-daemon profile's `extensions:`. It exports the
// extension-module contract's `commands` and `observe`; all behaviour lives in
// ../lib/durable-agent-audio.js over the same speech, routing and provider
// libraries the TUI /tts extension uses. It never imports Pi TUI APIs.
//
// Configuration comes from the worker's environment (PI_TTS_*, PI_NARRATE_*,
// AZURE_SPEECH_*, OPENAI_*, PULSE_SERVER/PULSE_SINK, …) and the immutable
// `agentUtils.tts|narrate|choice` slices of Pi's settings.json. Runtime toggles
// are per session and stored in the host's per-session module state.
// Host-specific modules may use ./tts-module.js to add per-session variables.

import { createDurableTtsModule } from "./tts-module.js";

const audio = createDurableTtsModule();

export const commands = audio.commands;

export function observe(event, ctx) {
  return audio.observe(event, ctx);
}
