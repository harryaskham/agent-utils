import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { archiveSharedImage, imageAgentDirectory, inlineSharedImages, localMarkdownImages, MAX_SHARED_IMAGE_BYTES } from "../extensions/lib/shared-images.js";
import { createSharedImagesExtension } from "../extensions/shared-images.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const provenance = { agent: "agent-name", session: "session-1", host: "node", cwd: "/project", kind: "tool", tool: "read", eventId: "call-1", index: 0 };

test("archive copies immutable images and private metadata, survives source deletion, and deduplicates replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "shared-image-"));
  const env = { PI_SHARED_IMAGES_DIR: join(root, "images") };
  try {
    const path = join(root, "source.png");
    await writeFile(path, PNG);
    const shares = await Promise.all(Array.from({ length: 6 }, () => archiveSharedImage({ path, label: "screenshot" }, provenance, { env, now: () => 0 })));
    assert.equal(new Set(shares.map((share) => share.path)).size, 1);
    await rm(path);
    assert.deepEqual(await readFile(shares[0].path), PNG);
    const metadata = JSON.parse(await readFile(shares[0].metadataPath, "utf8"));
    assert.equal(metadata.sha256, createHash("sha256").update(PNG).digest("hex"));
    assert.equal(metadata.timestamp, "1970-01-01T00:00:00.000Z");
    assert.equal(metadata.source.path, path);
    assert.equal(metadata.agent, "agent-name");
    assert.equal(metadata.session, "session-1");
    assert.equal((await stat(shares[0].metadataPath)).mode & 0o777, 0o600);
    assert.equal((await stat(shares[0].path)).mode & 0o777, 0o600);
    assert.equal((await readdir(join(env.PI_SHARED_IMAGES_DIR, "agent-name"))).length, 2);
    const other = await archiveSharedImage({ data: PNG.toString("base64"), mimeType: "image/png" }, { ...provenance, eventId: "call-2" }, { env });
    assert.notEqual(other.path, shares[0].path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("safe agent names, explicit path override, malformed input and archive symlink refusal", async () => {
  assert.equal(imageAgentDirectory("name"), "name");
  assert(!imageAgentDirectory("../../evil").includes("/"));
  assert.notEqual(imageAgentDirectory("a/b"), imageAgentDirectory("a b"));
  const root = await mkdtemp(join(tmpdir(), "shared-image-"));
  const env = { PI_SHARED_IMAGES_DIR: root };
  try {
    await assert.rejects(archiveSharedImage({ data: "%%%%" }, provenance, { env }), /base64/);
    await assert.rejects(archiveSharedImage({ data: "A".repeat(Math.ceil(MAX_SHARED_IMAGE_BYTES / 3) * 4 + 4) }, provenance, { env }), /oversized/);
    await symlink(tmpdir(), join(root, provenance.agent));
    await assert.rejects(archiveSharedImage({ data: PNG.toString("base64") }, provenance, { env }), /symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("typed image blocks and local markdown only; no URL fetching or text scraping", () => {
  assert.equal(inlineSharedImages([{ type: "image", data: "YQ==", mimeType: "image/png" }]).length, 1);
  assert.equal(inlineSharedImages([{ type: "resource", resource: { blob: "YQ==", mimeType: "image/jpeg" } }]).length, 1);
  assert.deepEqual(localMarkdownImages('![local](</tmp/a b.png>) ![remote](https://example.com/a.png) ![relative](fig.png "title")'), [{ path: "/tmp/a b.png", label: "local" }, { path: "fig.png", label: "relative" }]);
});

test("extension archives tool images, gallery additions and samples, not preview streams or user uploads", async () => {
  const handlers = new Map(), archived = [];
  createSharedImagesExtension({ env: { CACO_AGENT_ID: "a", CACO_PROJECT: "p" }, archive: async (image, meta) => { archived.push({ image, meta }); return { id: "copy" }; } })({
    on: (event, fn) => handlers.set(event, fn), getSessionName: () => "friendly",
  });
  const ctx = { cwd: "/actual", sessionManager: { getSessionId: () => "id" } };
  const result = await handlers.get("tool_result")({ toolName: "read", toolCallId: "t1", content: [{ type: "image", data: "YQ==", mimeType: "image/png" }], details: { kept: true } }, ctx);
  assert.equal(result.details.kept, true);
  assert.equal(result.details.sharedImages.count, 1);
  await handlers.get("tool_result")({ toolName: "kitty_image_preview_add_folder", details: { added: [{ path: "a.png" }, { path: "b.png" }] } }, ctx);
  await handlers.get("tool_result")({ toolName: "kitty_image_preview_stream_sample", details: { sample: { path: "sample.png" } } }, ctx);
  await handlers.get("tool_result")({ toolName: "kitty_image_preview_stream_status", details: { latestPath: "frame.png" } }, ctx);
  await handlers.get("message_end")({ message: { role: "user", content: [{ type: "image", data: "YQ==" }] } }, ctx);
  assert.equal(archived.length, 4);
  assert.equal(archived[0].meta.agent, "a");
  assert.equal(archived[0].meta.cwd, "/actual");
  await handlers.get("message_end")({ message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "![result](plot.png)" }] } }, ctx);
  assert.equal(archived.length, 5);
  const shown = { kittyImagePreviewState: { visible: true, index: 0, items: [{ path: "restored.png" }] } };
  await handlers.get("tool_result")({ toolName: "kitty_image_preview_show", input: { action: "current" }, details: shown }, ctx);
  assert.equal(archived.length, 6, "explicitly showing a restored image also preserves it");
  await handlers.get("tool_result")({ toolName: "kitty_image_preview_show", input: { action: "hide" }, details: shown }, ctx);
  assert.equal(archived.length, 6);
  const primitive = await handlers.get("tool_result")({ toolName: "read", content: [{ type: "image", data: "YQ==" }], details: "opaque" }, ctx);
  assert.equal(primitive, undefined, "preserve non-object tool details");
  assert.equal(archived.length, 7);
});
