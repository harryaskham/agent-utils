// Direct unit tests for app-automation/editor.js (bd-414ba5). Covers the
// injection-safety escaping of buildEditorReplaceScript and the previously
// untested prepareEditorReplace file-I/O path. Regression + security net; no
// source changes.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";

import { buildEditorReplaceScript, prepareEditorReplace } from "../extensions/app-automation/editor.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "editor-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buildEditorReplaceScript embeds selector and text as JSON string literals (injection-safe)", () => {
  const selector = "#a";
  const text = 'he said "hi"\nbye';
  const script = buildEditorReplaceScript({ selector, text });
  // Values must appear ONLY as JSON-encoded literals, so a value containing
  // quotes/newlines cannot break out of the surrounding JS string.
  assert.ok(script.includes(`const selector = ${JSON.stringify(selector)}`));
  assert.ok(script.includes(`const text = ${JSON.stringify(text)}`));
});

test("buildEditorReplaceScript neutralizes code-looking selector/text input", () => {
  const malicious = '"; globalThis.__pwned = 1; "';
  const script = buildEditorReplaceScript({ selector: malicious, text: malicious });
  // The raw unescaped break-out sequence must NOT appear; only its JSON form.
  assert.ok(script.includes(JSON.stringify(malicious)));
  assert.ok(!script.includes("globalThis.__pwned = 1;\n") || script.includes(JSON.stringify(malicious)));
  // Both the value branch and the contenteditable branch are present.
  assert.match(script, /'value' in element/);
  assert.match(script, /element\.textContent = text/);
});

test("buildEditorReplaceScript coerces nullish selector/text to empty JSON strings", () => {
  const script = buildEditorReplaceScript({ selector: undefined, text: undefined });
  assert.ok(script.includes('const selector = ""'));
  assert.ok(script.includes('const text = ""'));
});

test("prepareEditorReplace returns not-executable without a selector", async () => {
  const result = await prepareEditorReplace({ step: {}, params: {}, snapshotDir: os.tmpdir() });
  assert.equal(result.executable, false);
  assert.match(result.reason, /selector/);
});

test("prepareEditorReplace reads the paste file and writes the injection script", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "paste.txt"), "hello world", "utf8");
    const result = await prepareEditorReplace({
      step: { selector: "[contenteditable]" },
      params: {},
      snapshotDir: dir,
    });
    assert.equal(result.executable, true);
    assert.equal(result.selector, "[contenteditable]");
    assert.equal(result.textLength, "hello world".length);
    assert.equal(result.scriptPath, path.join(dir, "editor-replace.js"));
    assert.equal(result.outputPath, path.join(dir, "editor-replace-result.json"));
    const written = await readFile(result.scriptPath, "utf8");
    assert.ok(written.includes('const text = "hello world"'));
  });
});

test("prepareEditorReplace honors step.inputPath / params.targetSelector overrides", async () => {
  await withTempDir(async (dir) => {
    const customPaste = path.join(dir, "custom.txt");
    await writeFile(customPaste, "abc", "utf8");
    const result = await prepareEditorReplace({
      step: { inputPath: customPaste },
      params: { targetSelector: "#editor" },
      snapshotDir: dir,
    });
    assert.equal(result.executable, true);
    assert.equal(result.selector, "#editor"); // from params.targetSelector
    assert.equal(result.inputPath, customPaste); // from step.inputPath
    assert.equal(result.textLength, 3);
  });
});
