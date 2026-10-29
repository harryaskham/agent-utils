// Shared Durable /tts, /narrate and choice-audio module construction (bd-832b7a).
//
// `tts.mjs` uses the worker environment for every session. A host-specific
// module can pass `sessionEnv(ctx)` to overlay one session's host-owned
// variables (for example pi-daemon `sessionEnvFiles`) without changing the
// shared worker environment. Settings special forms are then evaluated with
// that session environment, matching an interactive Pi started with it.

import { readFileSync } from "node:fs";
import { createDurableAgentAudio } from "../lib/durable-agent-audio.js";
import { readPersistedChoiceSettings, readPersistedNarrateSettings, readPersistedTtsSettings } from "../lib/tts-settings.js";

export const DURABLE_AUDIO_INSTANCE = Symbol.for("agent-utils.durable-agent-audio.v1");

function readSlice(read, env) {
  try { return read(undefined, env === process.env ? {} : { env }); } catch { return {}; }
}

/** The immutable `agentUtils.tts|narrate|choice` slices, evaluated for one environment. */
export function readDurableAudioSettings(env = process.env) {
  return {
    tts: readSlice(readPersistedTtsSettings, env),
    narrate: readSlice(readPersistedNarrateSettings, env),
    choice: readSlice(readPersistedChoiceSettings, env),
  };
}

/** Absolute playback binaries the Nix package records next to this module. */
export function packagedExecutables() {
  try {
    const value = JSON.parse(readFileSync(new URL("./runtime-paths.json", import.meta.url), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, path]) => typeof path === "string" && path.startsWith("/")))
      : {};
  } catch { return {}; }
}

/**
 * Start a Durable audio module. A re-imported module stops the previous
 * instance's speech and keeps its process-start time and in-memory fallback state.
 */
export function createDurableTtsModule({
  env = process.env,
  sessionEnv,
  instanceKey = DURABLE_AUDIO_INSTANCE,
  ...options
} = {}) {
  const previous = globalThis[instanceKey];
  void previous?.dispose?.().catch?.(() => {});
  const instance = createDurableAgentAudio({
    env,
    persistedSettings: readDurableAudioSettings(env),
    ...(typeof sessionEnv === "function" ? { sessionEnv, readPersistedSettings: readDurableAudioSettings } : {}),
    executables: packagedExecutables(),
    ...(previous ? { loadedAt: previous.loadedAt, memoryState: previous.memoryState } : {}),
    ...options,
  });
  globalThis[instanceKey] = instance;
  return instance;
}
