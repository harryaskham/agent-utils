// Agent settings IO/path helpers for the pi-graphics extension, extracted from
// pi-graphics.js (bd-e1914a). Resolves the Pi agent dir / settings.json path and
// reads JSON defensively.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function readJsonIfExists(path) {
  try {
    if (!path || !existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function agentSettingsPath() {
  return join(agentDir(), "settings.json");
}
