// Immutable startup settings readers for Agent Utils speech/choice surfaces.
// Runtime slash-command overrides are intentionally held in memory and never
// write settings.json.

import { readAgentSettings, agentSettingsPath } from "../pi-graphics/agent-io.js";

function readSlice(slice, path, options) {
  // Options select the environment for settings special forms. A Durable host
  // evaluates them for one session, without changing the worker environment.
  const all = readAgentSettings(path, options ?? {});
  const value = all?.agentUtils?.[slice];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function readPersistedTtsSettings(path = agentSettingsPath(), options) {
  return readSlice("tts", path, options);
}

export function readPersistedNarrateSettings(path = agentSettingsPath(), options) {
  return readSlice("narrate", path, options);
}

export function readPersistedReadSettings(path = agentSettingsPath()) {
  return readSlice("read", path);
}

export function readPersistedChoiceSettings(path = agentSettingsPath(), options) {
  return readSlice("choice", path, options);
}

export function readPersistedRingInputSettings(path = agentSettingsPath()) {
  return readSlice("ringInput", path);
}

export function readPersistedOmniInputSettings(path = agentSettingsPath()) {
  return readSlice("omniInput", path);
}

export { agentSettingsPath as ttsSettingsPath };
