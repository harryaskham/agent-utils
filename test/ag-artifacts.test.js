import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendTtsFeed, ttsFeedPath } from "../extensions/lib/tts-feed.js";
import { archiveSharedImage } from "../extensions/lib/shared-images.js";
import { sharedImagesRoot } from "../extensions/lib/artifact-state.js";

const run = promisify(execFile);
test("ag reads real extension-written speech and image sidecars after source deletion", { skip: !process.env.AG_TEST_BIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ag-boundary-"));
  const env = { HOME: root, PI_AGENT_UTILS_STATE_DIR: join(root, "state"), PI_TTS_QUEUE_DIR: join(root, "queue") };
  try {
    await appendTtsFeed({ text: "full\ntext", kind: "narrate", agent: "boundary-agent", session: "s1" }, { env });
    const source = join(root, "source.png");
    await writeFile(source, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"));
    const image = await archiveSharedImage({ path: source, label: "boundary" }, { agent: "boundary-agent", session: "s1", eventId: "t1", index: 0 }, { env });
    await rm(source);
    const args = ["--config", join(root, "absent.yaml"), "--json", "--local", "--tts-feed", ttsFeedPath(env), "--image-dir", sharedImagesRoot(env)];
    const result = JSON.parse((await run(process.env.AG_TEST_BIN, [...args, "tts", "list"])).stdout);
    assert.equal(result.data.hosts[0].data.records[0].text, "full\ntext");
    const listing = JSON.parse((await run(process.env.AG_TEST_BIN, [...args, "image", "list"])).stdout);
    assert.equal(listing.data.hosts[0].data.records[0].id, image.id);
    assert.equal(listing.data.hosts[0].data.records[0].source.label, "boundary");
    const info = JSON.parse((await run(process.env.AG_TEST_BIN, [...args, "image", "info", image.id])).stdout);
    assert.equal(info.data.sha256, image.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
