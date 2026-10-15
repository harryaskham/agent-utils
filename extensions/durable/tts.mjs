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

import { readFileSync } from "node:fs";
import { createDurableAgentAudio } from "../lib/durable-agent-audio.js";
import { readPersistedChoiceSettings, readPersistedNarrateSettings, readPersistedTtsSettings } from "../lib/tts-settings.js";

const INSTANCE = Symbol.for("agent-utils.durable-agent-audio.v1");

function readSlice(read) {
  try { return read(); } catch { return {}; }
}

/** Absolute playback binaries the Nix package records next to this module. */
function packagedExecutables() {
  try {
    const value = JSON.parse(readFileSync(new URL("./runtime-paths.json", import.meta.url), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, path]) => typeof path === "string" && path.startsWith("/")))
      : {};
  } catch { return {}; }
}

function start() {
  // pi-daemon re-imports an edited module. Stop the previous instance's speech
  // and keep its process-start time and in-memory fallback state.
  const previous = globalThis[INSTANCE];
  void previous?.dispose?.().catch?.(() => {});
  const instance = createDurableAgentAudio({
    env: process.env,
    persistedSettings: {
      tts: readSlice(readPersistedTtsSettings),
      narrate: readSlice(readPersistedNarrateSettings),
      choice: readSlice(readPersistedChoiceSettings),
    },
    executables: packagedExecutables(),
    ...(previous ? { loadedAt: previous.loadedAt, memoryState: previous.memoryState } : {}),
  });
  globalThis[INSTANCE] = instance;
  return instance;
}

const audio = start();

export const commands = audio.commands;

export function observe(event, ctx) {
  return audio.observe(event, ctx);
}
