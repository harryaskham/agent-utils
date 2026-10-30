// Visual thoughts: generated images and their prompts, kept per session on disk so a reloaded
// or resumed session's backdrop starts from its recent imagery.
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function visualThoughtsStateDir(env = process.env) {
  if (env.PI_VISUAL_THOUGHTS_DIR) return env.PI_VISUAL_THOUGHTS_DIR;
  const state = env.PI_AGENT_UTILS_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "agent-utils");
  return join(state, "visual-thoughts");
}

function safeName(value) {
  return String(value || "session").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "session";
}

/** A session's image store: `save(record, png)`, `recent(n)`, `prune(keep)`. */
export function createImageStore({ root, sessionId }) {
  const dir = join(root, safeName(sessionId));
  const index = join(dir, "index.jsonl");
  return {
    dir,
    async save(record, png) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${safeName(record.id)}.png`);
      await writeFile(path, png, { mode: 0o600 });
      const line = { id: record.id, file: `${safeName(record.id)}.png`, prompt: record.prompt, model: record.model, batch: record.batch, at: record.at, ms: record.ms };
      await appendFile(index, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      return path;
    },
    /** The newest `limit` records whose files exist, oldest first, with their paths. */
    async recent(limit = 8) {
      let text = "";
      try { text = await readFile(index, "utf8"); } catch { return []; }
      const records = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record?.id && /^[A-Za-z0-9._-]+\.png$/.test(String(record.file || ""))) records.push({ ...record, path: join(dir, record.file) });
        } catch {}
      }
      return records.filter((record) => existsSync(record.path)).slice(-limit);
    },
    /** Keep the newest `keep` images (and their index lines). */
    async prune(keep = 48) {
      let names = [];
      try { names = (await readdir(dir)).filter((name) => name.endsWith(".png")); } catch { return; }
      const records = await this.recent(Number.MAX_SAFE_INTEGER);
      const kept = new Set(records.slice(-Math.max(0, keep)).map((record) => record.file));
      for (const name of names) if (!kept.has(name)) await rm(join(dir, name), { force: true });
      const lines = records.filter((record) => kept.has(record.file)).map(({ path: _path, ...record }) => JSON.stringify(record));
      await writeFile(index, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
    },
  };
}

/**
 * Keep the store bounded across sessions: drop sessions untouched for `maxAgeDays`, then the
 * least recently touched until the rest fit in `maxBytes`. `keep` (a session in use) is spared.
 */
export async function pruneStore(root, { maxAgeDays = 14, maxBytes = 1_500_000_000, keep = null, now = Date.now() } = {}) {
  let names = [];
  try { names = await readdir(root); } catch { return { removed: 0 }; }
  const sessions = [];
  for (const name of names) {
    const dir = join(root, name);
    let files = [];
    try { files = await readdir(dir); } catch { continue; }
    let bytes = 0;
    let touched = 0;
    for (const file of files) {
      try {
        const info = await stat(join(dir, file));
        bytes += info.size;
        touched = Math.max(touched, info.mtimeMs);
      } catch {}
    }
    sessions.push({ name, dir, bytes, touched });
  }
  sessions.sort((a, b) => a.touched - b.touched);
  let total = sessions.reduce((sum, session) => sum + session.bytes, 0);
  let removed = 0;
  for (const session of sessions) {
    if (keep && session.name === safeName(keep)) continue;
    const stale = now - session.touched > maxAgeDays * 86_400_000;
    if (!stale && total <= maxBytes) continue;
    await rm(session.dir, { recursive: true, force: true });
    total -= session.bytes;
    removed += 1;
  }
  return { removed };
}
