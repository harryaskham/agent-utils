import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import portableSessionExtension, {
  buildPortableSessionBundle,
  inspectPortableSessionEntries,
  parseSessionExportArgs,
  redactPortableValue,
  writePortableSessionBundle,
} from "../extensions/portable-session.js";

const header = {
  type: "session",
  version: 3,
  id: "origin-session",
  timestamp: "2026-08-21T00:00:00.000Z",
  cwd: "/home/source/repo",
};

const entries = [
  { type: "custom", id: "a", parentId: null, customType: "state-a", data: { path: "/home/source/cache" } },
  {
    type: "message",
    id: "b",
    parentId: "a",
    message: {
      role: "assistant",
      provider: "github-copilot",
      model: "test-model",
      content: [{ type: "image", mimeType: "image/png", data: "YWJj" }],
    },
  },
  { type: "custom_message", id: "c", parentId: "b", customType: "state-b", content: "hello" },
];

test("session-export argument parsing requires one destination and supports bounds", () => {
  assert.deepEqual(parseSessionExportArgs("'out file.json' --redact --max-bytes=123"), {
    destination: "out file.json",
    redact: true,
    maxBytes: 123,
    help: false,
  });
  assert.throws(() => parseSessionExportArgs(""), /explicit destination/);
  assert.throws(() => parseSessionExportArgs("a b"), /exactly one destination/);
  assert.throws(() => parseSessionExportArgs("a --max-bytes nope"), /positive integer/);
});

test("entry inspection reports custom types, inline image bytes, and latest model", () => {
  assert.deepEqual(inspectPortableSessionEntries(entries), {
    customTypes: ["state-a", "state-b"],
    imageCount: 1,
    imageBase64Bytes: 4,
    latestModel: { provider: "github-copilot", id: "test-model" },
  });
});

test("bundle creation records origin metadata and preserves extension-owned entries", () => {
  const { bundle, redactions } = buildPortableSessionBundle({
    header,
    entries,
    host: "origin-host",
    home: "/home/source",
    repository: { remote: "git@example/repo", commit: "abc" },
    createdAt: "fixed",
  });
  assert.equal(redactions, 0);
  assert.equal(bundle.manifest.origin.sessionId, "origin-session");
  assert.equal(bundle.manifest.origin.host, "origin-host");
  assert.deepEqual(bundle.manifest.customTypes, ["state-a", "state-b"]);
  assert.equal(bundle.session.entries[0].data.path, "/home/source/cache");
  assert.deepEqual(bundle.images, { count: 1, base64Bytes: 4 });
});

test("redaction masks secret-shaped keys and values while leaving ordinary content", () => {
  const { value, replacements } = redactPortableValue({
    apiKey: "plain-key",
    nested: { authorization: "Bearer abc.def.ghi", note: "token=sk-abcdefghijklmnop" },
    safe: "hello",
  });
  assert.equal(value.apiKey, "[REDACTED]");
  assert.equal(value.nested.authorization, "[REDACTED]");
  assert.equal(value.nested.note, "token=[REDACTED]");
  assert.equal(value.safe, "hello");
  assert.equal(replacements, 3);
});

test("atomic bundle write refuses collisions and enforces max size", async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-session-export-"));
  try {
    const destination = join(root, "nested", "bundle.json");
    const result = await writePortableSessionBundle(destination, { manifest: { ok: true } }, { nonce: () => "fixed" });
    assert.equal(JSON.parse(await readFile(destination, "utf8")).manifest.ok, true);
    await assert.rejects(() => writePortableSessionBundle(destination, { replacement: true }), /refusing to overwrite/);
    await assert.rejects(
      () => writePortableSessionBundle(join(root, "too-large.json"), { value: "x".repeat(100) }, { maxBytes: 10 }),
      /exceeding --max-bytes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registered command exports the active branch and reports redaction and images", async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-session-command-"));
  const commands = new Map();
  const notices = [];
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    async exec(_command, args) {
      return args.at(-1) === "HEAD"
        ? { code: 0, stdout: "abc123\n" }
        : { code: 0, stdout: "git@example/repo\n" };
    },
  };
  portableSessionExtension(pi);
  const ctx = {
    cwd: root,
    model: { provider: "github-copilot", id: "test-model" },
    sessionManager: {
      getSessionFile: () => join(root, "source.jsonl"),
      getHeader: () => header,
      getBranch: () => [...entries, { type: "message", id: "d", parentId: "c", message: { role: "user", content: "Bearer abc.def.ghi" } }],
    },
    ui: { notify(message, level) { notices.push({ message, level }); } },
  };
  try {
    await commands.get("session-export").handler("bundle.json --redact", ctx);
    const bundle = JSON.parse(await readFile(join(root, "bundle.json"), "utf8"));
    assert.equal(bundle.session.entries.at(-1).message.content, "[REDACTED]");
    assert.equal(bundle.manifest.repository.commit, "abc123");
    assert.match(notices.at(-1).message, /1 inline images, 1 redactions/);
    assert.equal(notices.at(-1).level, "info");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
