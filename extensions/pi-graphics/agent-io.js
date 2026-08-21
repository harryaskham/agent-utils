// Agent settings IO/path helpers for the pi-graphics extension, extracted from
// pi-graphics.js (bd-e1914a). Resolves the Pi agent dir / settings.json path and
// reads JSON defensively.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAgentUtilsSpecialForms } from "../lib/settings-special-forms.js";

const warnedSpecialForms = new Set();

export function readJsonIfExists(path) {
  try {
    if (!path || !existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function readAgentSettings(path, options = {}) {
  const settings = readJsonIfExists(path);
  if (!settings) return settings;
  return resolveAgentUtilsSpecialForms(settings, {
    ...options,
    onDiagnostic(detail) {
      try { options.onDiagnostic?.(detail); } catch {}
      const key = `${path}:${detail.path}:${detail.code}`;
      if (options.silent || warnedSpecialForms.has(key)) return;
      warnedSpecialForms.add(key);
      try { process.emitWarning(`Agent Utils setting ${detail.path} failed (${detail.code}); using false.`, { code: "PI_AGENT_UTILS_SETTING" }); } catch {}
    },
  });
}

export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function agentSettingsPath() {
  return join(agentDir(), "settings.json");
}
