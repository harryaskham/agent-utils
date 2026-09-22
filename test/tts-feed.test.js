import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTtsFeed, ttsFeedPath } from "../extensions/lib/tts-feed.js";

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "tts-feed-"));
  return { root, env: { HOME: root, XDG_STATE_HOME: join(root, "state"), PI_TTS_QUEUE_DIR: join(root, "queue") } };
};

test("speech feed uses durable state independent of the queue and preserves multiline text", async () => {
  const { root, env } = await fixture();
  try {
    const text = 'hello\nworld\t"quoted"\u001b';
    await appendTtsFeed({ text, kind: "tts", session: "one", cwd: "/project" }, { env, now: () => 0 });
    await appendTtsFeed({ text: "next", kind: "narrate", session: "two" }, { env, now: () => 1 });
    await appendTtsFeed({ text: " " }, { env });
    const lines = (await readFile(ttsFeedPath(env), "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).text, text);
    assert.equal(JSON.parse(lines[0]).timestamp, "1970-01-01T00:00:00.000Z");
    assert.equal(JSON.parse(lines[1]).kind, "narrate");
    assert.equal((await stat(ttsFeedPath(env))).mode & 0o777, 0o600);
    assert.equal(ttsFeedPath(env), join(env.XDG_STATE_HOME, "agent-utils/tts/speech.jsonl"));
    assert.equal(ttsFeedPath({ HOME: root }), join(root, ".local/state/agent-utils/tts/speech.jsonl"));
    assert.equal(ttsFeedPath({ HOME: root, PI_TTS_FEED_PATH: "~/custom/feed.jsonl" }), join(root, "custom/feed.jsonl"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy feed is copied once atomically under concurrent appends and retained", async () => {
  const { root, env } = await fixture();
  try {
    await mkdir(env.PI_TTS_QUEUE_DIR);
    const legacy = join(env.PI_TTS_QUEUE_DIR, "speech.jsonl");
    const original = JSON.stringify({ text: "history" }) + "\n";
    await writeFile(legacy, original);
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendTtsFeed({ text: `request-${i}`, kind: "tts", session: "test" }, { env })));
    const records = (await readFile(ttsFeedPath(env), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 21);
    assert.equal(records.filter((r) => r.text === "history").length, 1);
    assert.equal(new Set(records.map((r) => r.text)).size, 21);
    assert.equal(await readFile(legacy, "utf8"), original);
    await rm(env.PI_TTS_QUEUE_DIR, { recursive: true });
    assert.equal((await stat(ttsFeedPath(env))).isFile(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
