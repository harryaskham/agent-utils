// Agent directory resolution, realtime dev-link management, and default-model
// settings snapshot/restore extracted from realtime-agent.js (bd-e1914a).
// Pure over Node builtins (fs/os/path) + process.env; no module state or ctx.

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function agentBaseDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function agentSettingsPath() {
  return join(agentBaseDir(), "settings.json");
}

export function realtimeDevLinkDir() {
  return join(agentBaseDir(), "extensions", "agent-utils-realtime-dev");
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateAgentUtilsCheckout(path) {
  const root = resolve(path || ".");
  const packageJson = join(root, "package.json");
  const realtimeExtension = join(root, "extensions", "realtime-agent.js");
  if (!existsSync(packageJson)) throw new Error(`No package.json found at ${root}`);
  if (!existsSync(realtimeExtension)) throw new Error(`No realtime extension found at ${realtimeExtension}`);
  const pkg = readJsonFile(packageJson);
  if (pkg.name !== "agent-utils") throw new Error(`Expected package.json name "agent-utils" at ${root}, got ${pkg.name || "<missing>"}`);
  return { root, realtimeExtension };
}

export function installRealtimeDevLink(sourceRoot) {
  const source = validateAgentUtilsCheckout(sourceRoot);
  const linkDir = realtimeDevLinkDir();
  rmSync(linkDir, { recursive: true, force: true });
  mkdirSync(linkDir, { recursive: true });
  writeFileSync(join(linkDir, "package.json"), `${JSON.stringify({
    name: "agent-utils-realtime-dev",
    private: true,
    pi: { extensions: ["./extensions/realtime-agent.js"] },
  }, null, 2)}\n`);
  symlinkSync(join(source.root, "extensions"), join(linkDir, "extensions"), "dir");
  return { linkDir, sourceRoot: source.root, extension: source.realtimeExtension };
}

export function removeRealtimeDevLink() {
  const linkDir = realtimeDevLinkDir();
  const existed = existsSync(linkDir);
  rmSync(linkDir, { recursive: true, force: true });
  return { linkDir, existed };
}

export function realtimeDevLinkStatus() {
  const linkDir = realtimeDevLinkDir();
  const extensionLink = join(linkDir, "extensions");
  if (!existsSync(linkDir)) return { linkDir, linked: false };
  let target = null;
  try {
    const stat = lstatSync(extensionLink);
    if (stat.isSymbolicLink()) target = readlinkSync(extensionLink);
  } catch {}
  return { linkDir, linked: true, target, extension: join(extensionLink, "realtime-agent.js") };
}

export function readDefaultModelSettings() {
  const path = agentSettingsPath();
  try {
    if (!existsSync(path)) return null;
    const json = JSON.parse(readFileSync(path, "utf8"));
    return { path, provider: json.defaultProvider, model: json.defaultModel };
  } catch { return null; }
}

export function restoreDefaultModelSettings(snapshot) {
  if (!snapshot?.path) return;
  try {
    if (!existsSync(snapshot.path)) return;
    const json = JSON.parse(readFileSync(snapshot.path, "utf8"));
    if (snapshot.provider !== undefined) json.defaultProvider = snapshot.provider;
    if (snapshot.model !== undefined) json.defaultModel = snapshot.model;
    writeFileSync(snapshot.path, `${JSON.stringify(json, null, 2)}\n`);
  } catch {}
}

export function restoreDefaultModelSettingsSoon(snapshot) {
  restoreDefaultModelSettings(snapshot);
  setTimeout(() => restoreDefaultModelSettings(snapshot), 50).unref?.();
  setTimeout(() => restoreDefaultModelSettings(snapshot), 250).unref?.();
}
