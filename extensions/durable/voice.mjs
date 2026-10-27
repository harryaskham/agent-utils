// Durable adaptor: voice input run by pi-daemon (bd-6ffaf9). /call holds a voice call with the
// agent, /stt dictates and /ptt is push-to-talk; the agent gets end_call. The daemon records
// each session's microphone (its own device= and server=), transcribes and submits the speech;
// clients follow the call's document (voice-client.js shows it with the TUI's speech chip).
//
// List this file in a pi-daemon profile's `extensions:`, beside tts.mjs (whose speech mutes the
// microphone while it plays). The behaviour lives in ../lib/durable-voice.js over the libraries
// TUI /stt uses. Settings: settings.json `agentUtils.stt`, then the worker's environment
// (PI_STT_*, PI_RT_LOCAL_VAD_*, PULSE_SOURCE, PULSE_SERVER, PI_RT_RECORD_CMD), then each
// session's /call key=value. Needs pi-daemon 1.10 or later (module commands with the Durable
// harness; sessions with live background tasks resume at startup).
import { readFileSync } from "node:fs";
import { createAudioProviders } from "../lib/audio-providers.js";
import { readPersistedSttSettings } from "../lib/realtime-settings.js";
import { createVoiceCommands, createVoiceTask, createVoiceTools } from "../lib/durable-voice.js";

function readSlice(read) {
  try { return read(); } catch { return {}; }
}

/** Absolute Pulse binaries the Nix package records next to this module (pacat records too). */
function packagedExecutables() {
  try {
    const value = JSON.parse(readFileSync(new URL("./runtime-paths.json", import.meta.url), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, path]) => typeof path === "string" && path.startsWith("/")))
      : {};
  } catch { return {}; }
}

const task = createVoiceTask({
  env: process.env,
  persisted: readSlice(readPersistedSttSettings),
  audioProviders: createAudioProviders({}),
  executables: packagedExecutables(),
});

// The call task, and the agent's end_call.
export const extension = { name: "agent-utils-voice", tasks: [task], tools: createVoiceTools({ task }) };

// /call, /stt and /ptt.
export const commands = createVoiceCommands({ task });
