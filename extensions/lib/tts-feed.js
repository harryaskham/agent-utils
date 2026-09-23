import { chmod, copyFile, link, mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { agentUtilsStateRoot, expandStatePath } from "./artifact-state.js";
import { ttsQueueRoot } from "./tts-queue.js";
import { ttsFeedEnabled } from "./privacy.js";

export function ttsFeedPath(env = process.env) {
  return expandStatePath(env.PI_TTS_FEED_PATH || join(agentUtilsStateRoot(env), "tts", "speech.jsonl"), env);
}

// Only publish a legacy snapshot when the new destination does not exist. Keep
// the legacy file intact: an older Pi process may still be appending to it.
// Atomic link publication prevents partial imports and duplicate concurrent
// imports. No lock files, polling, or rereading history on the append hot path.
export async function prepareTtsFeed(env = process.env) {
  if (!ttsFeedEnabled(env)) return null;
  const destination = ttsFeedPath(env);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (await stat(destination).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) return destination;
  const legacy = join(ttsQueueRoot(env), "speech.jsonl");
  if (legacy === destination) return destination;
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(legacy, temporary);
    await chmod(temporary, 0o600);
    const file = await open(temporary, "r");
    try { await file.sync(); } finally { await file.close(); }
    await link(temporary, destination);
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
  } finally { await unlink(temporary).catch(() => {}); }
  return destination;
}

// One append per request, independent of the ephemeral PCM queue. JSONL keeps
// exact text, escaping embedded newlines/control characters. Not a playback ack.
export async function appendTtsFeed({ text, kind, session, agent, host, cwd }, { env = process.env, now = Date.now } = {}) {
  if (!ttsFeedEnabled(env) || !String(text || "").trim()) return;
  const destination = await prepareTtsFeed(env);
  const record = Buffer.from(JSON.stringify({
    version: 1, id: randomUUID(), timestamp: new Date(now()).toISOString(),
    kind, agent: agent || session, session, host: host || hostname(), pid: process.pid, cwd, text: String(text),
  }) + "\n");
  const file = await open(destination, "a", 0o600);
  try {
    // One O_APPEND write per record: concurrent sessions never rewrite history.
    const { bytesWritten } = await file.write(record);
    if (bytesWritten !== record.length) throw new Error("Incomplete TTS feed append");
  } finally { await file.close(); }
}
