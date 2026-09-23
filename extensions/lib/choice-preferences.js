// Node-local presentation preference, separate from immutable/shared Pi settings.
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isIncognito } from "./privacy.js";
import { basename, dirname, join, resolve } from "node:path";
import { agentUtilsStateRoot, expandStatePath } from "./artifact-state.js";

export function choicePreferencesPath(env = process.env) {
  return expandStatePath(env.PI_CHOICE_UI_STATE_PATH || join(agentUtilsStateRoot(env), "choice", "ui.json"), env);
}
async function writableTarget(path) {
  let target = resolve(path);
  const visited = new Set();
  for (let i = 0; i < 32; i++) {
    if (visited.has(target)) throw new Error("choice view preference: symlink cycle");
    visited.add(target);
    const info = await lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isSymbolicLink()) { target = resolve(dirname(target), await readlink(target)); continue; }
    if (info && !info.isFile()) throw new Error("choice view preference is not a regular file");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    return join(await realpath(dirname(target)), basename(target));
  }
  throw new Error("choice view preference: too many symlink hops");
}
export async function readChoicePreferences(path) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { if (error.code === "ENOENT") return { expanded: null }; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) throw new Error("invalid choice view preference file");
    const data = Buffer.alloc(4097);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > 4096) throw new Error("choice view preference file exceeds 4 KiB");
    let value;
    try { value = JSON.parse(data.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new Error("invalid choice view preference JSON"); }
    if (!value || value.version !== 1 || !(value.expanded === null || typeof value.expanded === "boolean")) throw new Error("unsupported choice view preference");
    return { expanded: value.expanded };
  } finally { await file.close(); }
}
export async function writeChoicePreferences(path, expanded) {
  if (!(expanded === null || typeof expanded === "boolean")) throw new Error("choice view must be expanded, compact, or reset");
  const target = await writableTarget(path);
  const temp = `${target}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temp, "wx", 0o600);
    await file.writeFile(`${JSON.stringify({ version: 1, expanded })}\n`);
    await file.sync(); await file.close(); file = null;
    await rename(temp, target);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
export function createChoicePreferenceStore({ env = process.env, path = choicePreferencesPath(env) } = {}) {
  if (isIncognito(env)) {
    let expanded = null;
    return { path: null, persistent: false, load: async () => ({ expanded }), save: async (value) => { expanded = value; }, flush: async () => {} };
  }
  let pending = Promise.resolve();
  return {
    path,
    persistent: true,
    load: () => readChoicePreferences(path),
    save(expanded) {
      // Serialize toggles from this session; no background writer or idle timer.
      // Across independent sessions, the last completed explicit toggle wins.
      const next = pending.then(() => writeChoicePreferences(path, expanded));
      pending = next.catch(() => {});
      return next;
    },
    flush: () => pending,
  };
}
