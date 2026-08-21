// Agent settings IO/path helpers for the pi-graphics extension, extracted from
// pi-graphics.js (bd-e1914a). Resolves the Pi agent dir / settings.json path and
// reads JSON defensively.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAgentUtilsSpecialForms } from "../lib/settings-special-forms.js";

const warnedSpecialForms = new Set();
const resolvedSettingsCache = new Map();

export function readJsonIfExists(path) {
  try {
    if (!path || !existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function readAgentSettings(path, options = {}) {
  const cacheable = Object.keys(options).length === 0;
  let signature = "";
  if (cacheable) {
    try {
      const info = statSync(path);
      signature = `${info.size}:${info.mtimeMs}`;
      const cached = resolvedSettingsCache.get(path);
      if (cached?.signature === signature) return cached.value;
    } catch {}
  }
  const settings = readJsonIfExists(path);
  if (!settings) return settings;
  const value = resolveAgentUtilsSpecialForms(settings, {
    ...options,
    onDiagnostic(detail) {
      try { options.onDiagnostic?.(detail); } catch {}
      const key = `${path}:${detail.path}:${detail.code}`;
      if (options.silent || warnedSpecialForms.has(key)) return;
      warnedSpecialForms.add(key);
      try { process.emitWarning(`Agent Utils setting ${detail.path} failed (${detail.code}); using a type-safe fallback.`, { code: "PI_AGENT_UTILS_SETTING" }); } catch {}
    },
  });
  if (cacheable && signature) resolvedSettingsCache.set(path, { signature, value });
  return value;
}

export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function agentSettingsPath() {
  return join(agentDir(), "settings.json");
}
