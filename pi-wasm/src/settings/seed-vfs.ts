// pi-wasm S6 (bd-4c572a): optionally seed the SDK's file-based config into the
// S2 VFS. Path A drives `new Agent(...)` directly with runtime keys, so this is
// NOT required for the MVP — but a consumer that wants the on-disk Pi layout
// (/home/.pi/agent/{auth,models,settings}.json present in the VFS, e.g. for a
// resource loader) can call this to materialize it. Uses the ExecutionEnv
// Result API (methods return Result, never throw).

import { normalizeSettings } from "./store";
import type { PiWasmSettings } from "./types";

/** Minimal Result shape returned by ExecutionEnv fs methods. */
export interface SeedResult {
  ok: boolean;
  error?: unknown;
}

/**
 * Structural subset of the S2 ExecutionEnv this helper needs. `BrowserExecutionEnv`
 * satisfies it directly; kept structural to avoid a hard import coupling.
 */
export interface SeedEnv {
  writeFile(path: string, content: string): Promise<SeedResult>;
  createDir(path: string, options?: { recursive?: boolean }): Promise<SeedResult>;
}

export interface SeedOptions {
  /** Agent config dir. Defaults to /home/.pi/agent (matches createBrowserExecutionEnv seedDirs). */
  agentDir?: string;
}

/**
 * Write auth.json / models.json / settings.json into the VFS under `agentDir`.
 * Returns the list of paths written. Throws if the env reports a write failure.
 */
export async function seedAgentConfig(
  env: SeedEnv,
  settings: PiWasmSettings,
  options: SeedOptions = {},
): Promise<string[]> {
  const s = normalizeSettings(settings);
  const dir = options.agentDir ?? "/home/.pi/agent";

  const mk = await env.createDir(dir, { recursive: true });
  if (!mk.ok) throw mk.error ?? new Error(`seedAgentConfig: createDir failed for ${dir}`);

  const files: Record<string, unknown> = {
    "auth.json": { providers: mapKeysToAuth(s.providerKeys) },
    "models.json": { models: s.models, selected: s.selectedModelId, baseUrl: s.baseUrl },
    "settings.json": s.settings,
  };

  const written: string[] = [];
  for (const [name, value] of Object.entries(files)) {
    const path = `${dir}/${name}`;
    const res = await env.writeFile(path, JSON.stringify(value, null, 2));
    if (!res.ok) throw res.error ?? new Error(`seedAgentConfig: writeFile failed for ${path}`);
    written.push(path);
  }
  return written;
}

function mapKeysToAuth(providerKeys: Record<string, string>): Record<string, { apiKey: string }> {
  const out: Record<string, { apiKey: string }> = {};
  for (const [provider, apiKey] of Object.entries(providerKeys)) out[provider] = { apiKey };
  return out;
}
