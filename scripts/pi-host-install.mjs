#!/usr/bin/env node
// Install Pi host packages (pi-ai, pi-coding-agent, pi-tui and their typebox)
// for bare `node --test` runs, without recording them in package.json. They
// install into node_modules/.pi-host (its own npm prefix, since npm skips
// explicitly requested packages that package.json lists as peers) and are
// linked into node_modules so imports resolve as they would under Pi.
//
// Why not devDependencies: Pi installs git packages with
// `npm install --omit=dev --legacy-peer-deps`, and npm still resolves the whole
// dev tree before omitting it. A dev pin that the operator's registry cannot
// serve (a mirror that lags npmjs, or a pin newer than the mirror) then breaks
// `pi update --extensions` for an extension that never needs those modules —
// Pi supplies them at runtime. Keeping the host out of the manifest makes the
// production install independent of any host version.
//
// Version: PI_HOST_VERSION, else the running `pi --version` (PI_BIN or PATH),
// else the registry's latest. When the registry lacks that exact release, the
// newest available release of the same major that is not newer is used and a
// warning says so.
//
// Usage: npm run host:install [-- --dry-run] (after any plain `npm install`,
// which prunes packages that are not in package.json).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_PACKAGES = Object.freeze(["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]);
// Host-supplied modules extensions import directly; linked when the host has them.
const LINKED_COMPANIONS = Object.freeze(["typebox", "@sinclair/typebox"]);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (version) => SEMVER.exec(String(version || "").trim())?.slice(1).map(Number) || null;
const compare = (a, b) => {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/// Pick the version to install from what every host package offers.
export function chooseHostVersion(target, availableByPackage) {
  const sets = Object.values(availableByPackage).map((versions) => new Set((versions || []).filter((v) => parse(v))));
  const common = [...(sets[0] || [])].filter((version) => sets.every((set) => set.has(version))).sort(compare);
  if (common.length === 0) return { version: null, reason: "registry offers no common stable host release" };
  if (!parse(target)) return { version: common.at(-1), reason: "latest" };
  if (common.includes(target)) return { version: target, reason: "matches running Pi" };
  const major = parse(target)[0];
  const fallback = common.filter((version) => parse(version)[0] === major && compare(version, target) <= 0).at(-1);
  if (fallback) return { version: fallback, reason: `registry lacks ${target}; using ${fallback}`, fallback: true };
  return { version: common.at(-1), reason: `registry lacks ${target} and its major; using latest ${common.at(-1)}`, fallback: true };
}

/// The operator's Pi, never a `pi` bin that npm put on PATH from node_modules.
export function findPiBinary({ env = process.env, exists = existsSync } = {}) {
  if (env.PI_BIN) return env.PI_BIN;
  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (!dir || `${dir}${sep}`.includes(`${sep}node_modules${sep}`)) continue;
    const candidate = join(dir, "pi");
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function runningPiVersion({ env = process.env, exec = execFileSync, exists = existsSync } = {}) {
  if (env.PI_HOST_VERSION) return String(env.PI_HOST_VERSION).trim();
  const bin = findPiBinary({ env, exists });
  if (!bin) return null;
  try {
    const out = exec(bin, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] || null;
  } catch {
    return null;
  }
}

function npmVersions(name) {
  const out = execFileSync("npm", ["view", name, "versions", "--json"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dryRun = process.argv.includes("--dry-run");
  const target = runningPiVersion();
  const available = Object.fromEntries(HOST_PACKAGES.map((name) => [name, npmVersions(name)]));
  const choice = chooseHostVersion(target, available);
  if (!choice.version) throw new Error(choice.reason);
  if (choice.fallback) console.warn(`pi-host-install: ${choice.reason}`);
  const specs = HOST_PACKAGES.map((name) => `${name}@${choice.version}`);
  const modules = join(root, "node_modules");
  const hostDir = join(modules, ".pi-host");
  const linked = [];
  if (!dryRun) {
    rmSync(hostDir, { recursive: true, force: true });
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(join(hostDir, "package.json"), `${JSON.stringify({
      name: "agent-utils-pi-host", private: true,
      dependencies: Object.fromEntries(HOST_PACKAGES.map((name) => [name, choice.version])),
    }, null, 2)}\n`);
    const result = spawnSync("npm", ["install", "--no-package-lock", "--legacy-peer-deps", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], { cwd: hostDir, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status || 1);
    for (const name of [...HOST_PACKAGES, ...LINKED_COMPANIONS]) {
      const source = join(hostDir, "node_modules", name);
      if (!existsSync(join(source, "package.json"))) continue;
      const target = join(modules, name);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(relative(dirname(target), source), target, "dir");
      linked.push(name);
    }
  }
  console.log(JSON.stringify({ target, installed: choice.version, reason: choice.reason, packages: specs, linked, dryRun }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(`pi-host-install: ${error.message}`); process.exit(1); });
}
