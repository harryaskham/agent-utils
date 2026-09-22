import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ttsQueueRoot } from "./tts-queue.js";

export function ttsFeedPath(env = process.env) {
  return join(ttsQueueRoot(env), "speech.jsonl");
}

// One append per request, no queue lock, read/modify/write cycle, or idle I/O.
// JSONL preserves full text while escaping embedded newlines/control characters.
// This is a request feed, not a receipt of successful synthesis or playback.
export function appendTtsFeed({ text, kind, session, cwd }, { env = process.env, now = Date.now } = {}) {
  if (!String(text || "").trim()) return;
  const root = ttsQueueRoot(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  appendFileSync(ttsFeedPath(env), JSON.stringify({
    timestamp: new Date(now()).toISOString(),
    kind, session, pid: process.pid, cwd, text: String(text),
  }) + "\n", { encoding: "utf8", mode: 0o600, flag: "a" });
}
