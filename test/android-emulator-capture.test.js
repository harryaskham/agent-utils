import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import androidCliExtension from "../extensions/android.js";

// A valid 1x1 PNG (starts with the 89 50 4E 47 ... signature).
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

function makeHarness() {
  const tools = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
  };
  androidCliExtension(pi);
  return { tools };
}

/**
 * Write an executable fake `adb` that ignores its args and behaves per `mode`:
 *  - "png":    cats a golden PNG file to stdout, exit 0
 *  - "nonpng": prints a non-PNG warning to stdout, exit 0
 *  - "fail":   prints to stderr, exit 1
 */
function makeFakeAdb(dir, mode, goldenPath) {
  const file = join(dir, "fake-adb.sh");
  let body;
  if (mode === "png") body = `#!/usr/bin/env bash\ncat ${JSON.stringify(goldenPath)}\n`;
  else if (mode === "nonpng") body = "#!/usr/bin/env bash\nprintf 'error: device offline\\n'\n";
  else body = "#!/usr/bin/env bash\nprintf 'adb: no devices/emulators found\\n' >&2\nexit 1\n";
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

async function withFakeAdb(mode, fn) {
  const dir = mkdtempSync(join(tmpdir(), "android-capture-"));
  const golden = join(dir, "golden.png");
  writeFileSync(golden, ONE_BY_ONE_PNG);
  const fakeAdb = makeFakeAdb(dir, mode, golden);
  const prev = process.env.ANDROID_ADB_BIN;
  process.env.ANDROID_ADB_BIN = fakeAdb;
  try {
    return await fn({ dir });
  } finally {
    if (prev === undefined) delete process.env.ANDROID_ADB_BIN;
    else process.env.ANDROID_ADB_BIN = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("android_emulator_screenshot writes the captured PNG and returns image content", async () => {
  await withFakeAdb("png", async ({ dir }) => {
    const { tools } = makeHarness();
    const out = join(dir, "shot.png");
    const result = await tools.get("android_emulator_screenshot").execute(
      "c1",
      { serial: "emulator-5554", outputPath: out, preview: true },
      null,
      null,
      { cwd: dir },
    );

    assert.equal(result.details.path, out);
    assert.equal(result.details.serial, "emulator-5554");
    assert.equal(result.details.size, ONE_BY_ONE_PNG.length);
    assert.deepEqual(readFileSync(out), ONE_BY_ONE_PNG);

    const image = result.content.find((c) => c.type === "image");
    assert.ok(image, "preview should attach image content");
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data, "base64").length, ONE_BY_ONE_PNG.length);
    assert.equal(result.details.nextTool.name, "kitty_image_preview_add");
  });
});

test("android_emulator_screenshot preview=false omits image content but still saves the file", async () => {
  await withFakeAdb("png", async ({ dir }) => {
    const { tools } = makeHarness();
    const out = join(dir, "shot.png");
    const result = await tools.get("android_emulator_screenshot").execute(
      "c1",
      { outputPath: out, preview: false },
      null,
      null,
      { cwd: dir },
    );
    assert.equal(result.content.some((c) => c.type === "image"), false);
    assert.deepEqual(readFileSync(out), ONE_BY_ONE_PNG);
  });
});

test("android_emulator_screenshot rejects non-PNG stdout even when adb exits 0", async () => {
  await withFakeAdb("nonpng", async ({ dir }) => {
    const { tools } = makeHarness();
    const out = join(dir, "shot.png");
    await assert.rejects(
      () => tools.get("android_emulator_screenshot").execute("c1", { outputPath: out }, null, null, { cwd: dir }),
      /did not return PNG data/i,
    );
  });
});

test("android_emulator_screenshot surfaces a clear error when adb exits non-zero", async () => {
  await withFakeAdb("fail", async ({ dir }) => {
    const { tools } = makeHarness();
    const out = join(dir, "shot.png");
    await assert.rejects(
      () => tools.get("android_emulator_screenshot").execute("c1", { outputPath: out }, null, null, { cwd: dir }),
      /adb screencap failed/i,
    );
  });
});

test("android_emulator_stream captures the requested frames into a 2-file rotation", async () => {
  await withFakeAdb("png", async ({ dir }) => {
    const { tools } = makeHarness();
    const outputDir = join(dir, "stream");
    const updates = [];
    const result = await tools.get("android_emulator_stream").execute(
      "c1",
      { frames: 3, intervalMs: 50, outputDir, preview: true },
      null,
      (u) => updates.push(u),
      { cwd: dir },
    );

    assert.equal(result.details.framesRequested, 3);
    assert.equal(result.details.framesCaptured, 3);
    assert.ok(result.details.latestPath?.startsWith(outputDir));
    assert.deepEqual(readFileSync(result.details.latestPath), ONE_BY_ONE_PNG);
    // 3 frames over a 2-file rotation -> frames 00 and 01 both exist.
    assert.deepEqual(readFileSync(join(outputDir, "android-stream-00.png")), ONE_BY_ONE_PNG);
    assert.deepEqual(readFileSync(join(outputDir, "android-stream-01.png")), ONE_BY_ONE_PNG);
    assert.equal(updates.length, 3, "each captured frame should emit a preview update");
  });
});
