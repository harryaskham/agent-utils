// Immutable startup settings readers for Agent Utils speech/choice surfaces.
// Runtime slash-command overrides are intentionally held in memory and never
// write settings.json.

import { readAgentSettings, agentSettingsPath } from "../pi-graphics/agent-io.js";

function readSlice(slice, path) {
  const all = readAgentSettings(path);
  const value = all?.agentUtils?.[slice];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function readPersistedTtsSettings(path = agentSettingsPath()) {
  return readSlice("tts", path);
}

export function readPersistedNarrateSettings(path = agentSettingsPath()) {
  return readSlice("narrate", path);
}

export function readPersistedReadSettings(path = agentSettingsPath()) {
  return readSlice("read", path);
}

export function readPersistedChoiceSettings(path = agentSettingsPath()) {
  return readSlice("choice", path);
}

export function readPersistedRingInputSettings(path = agentSettingsPath()) {
  return readSlice("ringInput", path);
}

export function readPersistedOmniInputSettings(path = agentSettingsPath()) {
  return readSlice("omniInput", path);
}

export { agentSettingsPath as ttsSettingsPath };
