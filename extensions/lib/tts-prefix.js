import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export function githubRepoName(cwd, spawnImpl = spawnSync) {
  try {
    const remote = spawnImpl("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
    const url = String(remote?.stdout || "").trim();
    if (remote?.status !== 0 || !/(?:github\.com)[/:]/i.test(url)) return "";
    const root = spawnImpl("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
    return root?.status === 0 ? basename(String(root.stdout || "").trim()) : "";
  } catch { return ""; }
}

export function fallbackSessionLabel(cwd, { home = homedir(), spawnImpl = spawnSync } = {}) {
  if (resolve(cwd) === resolve(home)) return "home";
  return githubRepoName(cwd, spawnImpl) || basename(resolve(cwd)) || "home";
}

export function speechPrefix({ enabled, configuredPrefix = "", sessionName, cwd, home, spawnImpl } = {}) {
  if (!enabled) return String(configuredPrefix || "");
  const name = String(sessionName || "").trim() || fallbackSessionLabel(cwd || process.cwd(), { home, spawnImpl });
  return `${name}${String(configuredPrefix || "")}`;
}
