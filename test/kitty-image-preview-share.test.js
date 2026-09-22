import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, truncateSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import extension from "../extensions/kitty-image-preview.js";
import { shareCurrentImage, MAX_SHARED_IMAGE_BYTES } from "../extensions/kitty-image-preview/share.js";
import { createStrictMockPi } from "./helpers/strict-mock-pi.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kitty-share-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "image.png");
  writeFileSync(file, png);
  return { dir, file, state: { items: [{ path: file, label: "selected" }], index: 0 } };
}

test("image-only final result contains immutable bytes after source replacement/deletion", t => {
  const { dir, file, state } = fixture(t);
  const result = shareCurrentImage(state);
  assert.deepEqual(result.content, [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  writeFileSync(file, "replaced frame");
  state.items = [];
  rmSync(file);
  // The normal toolResult message can be persisted/reloaded without a path.
  const history = path.join(dir, "session.jsonl");
  writeFileSync(history, JSON.stringify({ type: "message", message: {
    role: "toolResult", toolCallId: "share", toolName: "kitty_image_preview_share_current",
    ...result, isError: false, timestamp: Date.now(),
  } }) + "\n");
  const restored = JSON.parse(readFileSync(history, "utf8")).message;
  assert.deepEqual(Buffer.from(restored.content[0].data, "base64"), png);
  assert.equal(restored.content.length, 1);
  assert.equal(JSON.stringify(restored.details).includes(file), false);
});

test("rejects absent, missing, oversized, truncated, corrupt and non-PNG sources", t => {
  const { file, state } = fixture(t);
  assert.throws(() => shareCurrentImage({ items: [], index: 0 }), /No current image/);
  for (const bytes of [Buffer.from("not png"), png.subarray(0, 40), Buffer.concat([png, Buffer.from("junk")])]) {
    writeFileSync(file, bytes);
    assert.throws(() => shareCurrentImage(state), /malformed/);
  }
  const corrupt = Buffer.from(png); corrupt[45] ^= 1;
  writeFileSync(file, corrupt);
  assert.throws(() => shareCurrentImage(state), /malformed/);
  truncateSync(file, MAX_SHARED_IMAGE_BYTES + 1);
  assert.throws(() => shareCurrentImage(state), /8 MiB/);
  rmSync(file);
  assert.throws(() => shareCurrentImage(state), /ENOENT/);
  assert.throws(() => shareCurrentImage(state, AbortSignal.abort()), /abort/i);
});

for (const disabled of [undefined, "1"]) {
  test(`registered share is final-only; preview stays local (PI_DISABLE_AHP=${disabled})`, async t => {
    const { dir, file } = fixture(t);
    const previous = process.env.PI_DISABLE_AHP;
    if (disabled) process.env.PI_DISABLE_AHP = disabled; else delete process.env.PI_DISABLE_AHP;
    t.after(() => { if (previous === undefined) delete process.env.PI_DISABLE_AHP; else process.env.PI_DISABLE_AHP = previous; });
    const { pi, tools } = createStrictMockPi();
    // No bridge, messages, or extra publication path is needed.
    pi.sendMessage = pi.sendUserMessage = pi.appendEntry = () => assert.fail("duplicate publication");
    extension(pi);
    const ctx = { cwd: dir, hasUI: false };
    const updates = [];
    const run = (name, params) => tools.get(`kitty_image_preview_${name}`).execute(name, params, undefined, update => updates.push(update), ctx);
    const added = await run("add", { path: file, show: false });
    assert.ok(added.content.every(block => block.type === "text"));
    const folder = await run("add_folder", { path: dir });
    assert.ok(folder.content.every(block => block.type === "text"));
    const navigated = await run("show", { action: "first" });
    assert.ok(navigated.content.every(block => block.type === "text"));
    const sharedPromise = run("share_current", {});
    // execute snapshots synchronously, even though the tool returns a Promise.
    writeFileSync(file, "next stream frame");
    const shared = await sharedPromise;
    assert.deepEqual(shared.content, [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
    assert.equal(updates.length, 0);
  });
}
