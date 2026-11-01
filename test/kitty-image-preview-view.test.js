// The TUI gallery remembers being hidden or cleared (by /image-hide, /image-clear) across a
// reopened session, and a later image shows it again; /image-show is remembered too.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createStrictMockPi } from "./helpers/strict-mock-pi.js";
import preview, { VIEW_ENTRY_TYPE } from "../extensions/kitty-image-preview.js";

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function snapshot(paths, visible = true) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "kitty_image_preview_add",
      details: {
        kittyImagePreviewState: {
          visible,
          index: paths.length - 1,
          items: paths.map((file, id) => ({ id: 4000 + id, path: file, label: path.basename(file), mediaType: "image/png", width: 1, height: 1 })),
          ownedImageIds: [],
          config: { placement: "aboveEditor", passthrough: "none" },
        },
      },
    },
  };
}

/** Open a session whose branch is `branch`; its status and what its commands append. */
async function open(branch) {
  const appended = [];
  const h = createStrictMockPi({ appendEntry: (customType, data) => appended.push({ type: "custom", customType, data }) });
  preview(h.pi);
  const notices = [];
  const terminal = { write() {}, columns: 100, rows: 30 };
  const tui = { terminal, requestRender() {} };
  const ui = { setStatus() {}, setWidget(_id, factory) { if (typeof factory === "function") factory(tui, {}); }, notify: (text) => notices.push(text) };
  const ctx = { cwd: os.tmpdir(), hasUI: true, ui, sessionManager: { getBranch: () => branch, getEntries: () => branch } };
  await h.handlers.get("session_start")[0]({}, ctx);
  const run = async (name) => h.commands.get(name).handler("", ctx);
  const status = async () => {
    await run("image-status");
    return notices.at(-1);
  };
  return { h, ctx, appended, run, status, close: () => h.handlers.get("session_shutdown")?.[0]?.({}, ctx) };
}

test("a gallery hidden or cleared stays so when the session reopens, until a later image", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kitty-view-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = path.join(dir, "old.png");
  const fresh = path.join(dir, "new.png");
  await writeFile(old, PNG);
  await writeFile(fresh, PNG);

  // Shown, as the last tool left it.
  const first = await open([snapshot([old])]);
  assert.match(await first.status(), /\/image-hide/, "visible");
  await first.run("image-hide");
  assert.deepEqual(first.appended, [{ type: "custom", customType: VIEW_ENTRY_TYPE, data: { visible: false } }]);
  await first.close();

  // Reopened: still hidden, its image kept.
  const reopened = await open([snapshot([old]), ...first.appended]);
  assert.match(await reopened.status(), /\/image-show \/image-clear 1 image/, "hidden, with its image");
  await reopened.close();

  // A later image (its tool result after the hide) shows it again.
  const added = await open([snapshot([old]), ...first.appended, snapshot([old, fresh])]);
  assert.match(await added.status(), /\/image-hide/, "shown again for the new image");
  await added.close();

  // /image-show is remembered as well.
  await reopened.run("image-show");
  const shown = await open([snapshot([old]), ...first.appended, ...reopened.appended]);
  assert.match(await shown.status(), /\/image-hide/);
  await shown.close();

  // Cleared: reopens empty.
  const clearing = await open([snapshot([old])]);
  await clearing.run("image-clear");
  await clearing.close();
  const cleared = await open([snapshot([old]), ...clearing.appended]);
  assert.match(await cleared.status(), /no image|No image|\/image-status/i);
  await cleared.close();
});
