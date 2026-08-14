// Durable settings.json slices for /tts and /narrate (bd-bafb6e).

import { writeFileSync } from "node:fs";
import { readJsonIfExists, agentSettingsPath } from "../pi-graphics/agent-io.js";

export const PERSISTED_TTS_FIELDS = Object.freeze([
  "enabled", "provider", "voice", "lang", "speed", "embedding", "style",
  "styleDegree", "endpoint", "backend", "server", "device",
]);
export const PERSISTED_NARRATE_FIELDS = Object.freeze(["enabled", "model"]);
const TTS_FIELDS = new Set(PERSISTED_TTS_FIELDS);
const NARRATE_FIELDS = new Set(PERSISTED_NARRATE_FIELDS);

function readSlice(slice, path) {
  const all = readJsonIfExists(path);
  const value = all?.agentUtils?.[slice];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function persistSlice(slice, allowed, field, value, path) {
  if (!allowed.has(field)) return false;
  try {
    const all = readJsonIfExists(path) || {};
    if (!all.agentUtils || typeof all.agentUtils !== "object" || Array.isArray(all.agentUtils)) all.agentUtils = {};
    if (!all.agentUtils[slice] || typeof all.agentUtils[slice] !== "object" || Array.isArray(all.agentUtils[slice])) all.agentUtils[slice] = {};
    all.agentUtils[slice][field] = value;
    writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

export function readPersistedTtsSettings(path = agentSettingsPath()) {
  return readSlice("tts", path);
}

export function readPersistedNarrateSettings(path = agentSettingsPath()) {
  return readSlice("narrate", path);
}

export function persistTtsSetting(field, value, path = agentSettingsPath()) {
  return persistSlice("tts", TTS_FIELDS, field, value, path);
}

export function persistNarrateSetting(field, value, path = agentSettingsPath()) {
  return persistSlice("narrate", NARRATE_FIELDS, field, value, path);
}

export { agentSettingsPath as ttsSettingsPath };
