import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTtsFeed, ttsFeedPath } from "../extensions/lib/tts-feed.js";

test("speech feed appends private JSONL near queue without losing multiline text", () => {
  const root = mkdtempSync(join(tmpdir(), "tts-feed-"));
  const env = { PI_TTS_QUEUE_DIR: join(root, "queue") };
  try {
    const text = 'hello\nworld\t"quoted"\u001b';
    appendTtsFeed({ text, kind: "tts", session: "one", cwd: "/project" }, { env, now: () => 0 });
    appendTtsFeed({ text: "next", kind: "narrate", session: "two" }, { env, now: () => 1 });
    appendTtsFeed({ text: " " }, { env });
    const lines = readFileSync(ttsFeedPath(env), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).text, text);
    assert.equal(JSON.parse(lines[0]).timestamp, "1970-01-01T00:00:00.000Z");
    assert.equal(JSON.parse(lines[1]).kind, "narrate");
    assert.equal(statSync(ttsFeedPath(env)).mode & 0o777, 0o600);
    assert.equal(ttsFeedPath(env), join(env.PI_TTS_QUEUE_DIR, "speech.jsonl"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
