import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TOKEN_FILE = "~/.config/gh-auth-tokens/copilot.token";
export const DEFAULT_AUTH_JSON_FILE = "~/.pi/agent/auth.json";
export const DEFAULT_AUTH_JSON_KEY = "github-copilot";
export const DEFAULT_API_BASE = "https://api.githubcopilot.com/v1";

function expandHome(inputPath) {
  if (!inputPath.startsWith("~/")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(2));
}

export function responsesApiBase(value) {
  const base = String(value || "").replace(/\/$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function resolveWebSearchAuthConfig(env = process.env) {
  const explicitApiBase = Boolean(env.WEB_SEARCH_COPILOT_API_BASE);
  const proxyBase = env.WEB_SEARCH_LITELLM_BASE_URL || env.LITELLM_BASE_URL || env.LITELLM_PROXY_URL;
  const proxyKey = env.WEB_SEARCH_LITELLM_API_KEY || env.LITELLM_MASTER_KEY;
  const useProxy = !explicitApiBase && Boolean(proxyBase && proxyKey);
  const explicitTokenFile = Boolean(env.WEB_SEARCH_COPILOT_TOKEN_FILE);
  return {
    explicitTokenFile,
    tokenFile: expandHome(env.WEB_SEARCH_COPILOT_TOKEN_FILE || DEFAULT_TOKEN_FILE),
    authJsonFile: expandHome(env.WEB_SEARCH_COPILOT_AUTH_JSON || DEFAULT_AUTH_JSON_FILE),
    authJsonKey: env.WEB_SEARCH_COPILOT_AUTH_JSON_KEY || DEFAULT_AUTH_JSON_KEY,
    apiBase: useProxy ? responsesApiBase(proxyBase) : (env.WEB_SEARCH_COPILOT_API_BASE || DEFAULT_API_BASE).replace(/\/$/, ""),
    authMode: useProxy ? "litellm" : "copilot",
    proxyKey: useProxy ? proxyKey : undefined,
  };
}

async function readTokenFile(tokenFile) {
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token) throw new Error(`GitHub Copilot token file is empty: ${tokenFile}`);
  return token;
}

async function readTokenFromAuthJson(authJsonFile, authJsonKey) {
  try {
    const parsed = JSON.parse(await readFile(authJsonFile, "utf8"));
    const access = parsed?.[authJsonKey]?.access;
    return typeof access === "string" && access.trim() ? access.trim() : null;
  } catch {
    return null;
  }
}

export async function resolveWebSearchToken(config) {
  if (config.authMode === "litellm") return config.proxyKey;
  if (config.explicitTokenFile) return readTokenFile(config.tokenFile);
  const fromAuthJson = await readTokenFromAuthJson(config.authJsonFile, config.authJsonKey);
  return fromAuthJson || readTokenFile(config.tokenFile);
}
