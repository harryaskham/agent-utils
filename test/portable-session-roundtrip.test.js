import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildImportedPortableSession,
  buildPortableSessionBundle,
  resolvePortableSessionImportDir,
  writeImportedPortableSession,
  writePortableSessionBundle,
} from "../extensions/portable-session.js";

function parseJsonl(text) {
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

test("end-to-end bundle round trip crosses HOME and checkout roots within a bounded size and time", async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-session-roundtrip-"));
  const originHome = "/home/alice";
  const originCwd = "/home/alice/work/agent-utils";
  const targetHome = join(root, "Users", "bob");
  const targetCwd = join(targetHome, "src", "agent-utils");
  const targetSessionRoot = join(targetHome, ".pi", "agent", "sessions");
  await mkdir(targetCwd, { recursive: true });

  const header = {
    type: "session",
    version: 3,
    id: "origin-id",
    timestamp: "2026-08-21T00:00:00.000Z",
    cwd: originCwd,
  };
  const entries = [
    {
      type: "message",
      id: "root0001",
      parentId: null,
      timestamp: "2026-08-21T00:00:01.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: `Inspect ${originCwd}/src/main.js and /opt/shared/config.json` },
          { type: "image", mimeType: "image/png", data: "a".repeat(4096) },
        ],
        timestamp: 1,
      },
    },
    {
      type: "custom",
      id: "state002",
      parentId: "root0001",
      timestamp: "2026-08-21T00:00:02.000Z",
      customType: "host-routing",
      data: { cache: `${originHome}/.cache/pi`, pulseSource: "remote.monitor" },
    },
    {
      type: "custom_message",
      id: "notice03",
      parentId: "state002",
      timestamp: "2026-08-21T00:00:03.000Z",
      customType: "portable-note",
      content: `checkout=${originCwd}`,
      display: true,
    },
  ];

  const startedAt = Date.now();
  try {
    const exported = buildPortableSessionBundle({
      header,
      entries,
      host: "linux-origin",
      home: originHome,
      repository: { remote: "git@example/agent-utils", commit: "abc123" },
      model: { provider: "origin-provider", id: "origin-model" },
      createdAt: "2026-08-21T00:00:04.000Z",
    });
    const bundlePath = join(root, "handoff", "session.bundle.json");
    const bundleWrite = await writePortableSessionBundle(bundlePath, exported.bundle, { maxBytes: 1024 * 1024 });
    assert.ok(bundleWrite.bytes < 16 * 1024, "small fixture remains comfortably below the transfer bound");

    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    const imported = buildImportedPortableSession({
      bundle,
      targetCwd,
      targetHome,
      sessionId: "imported-id",
      importedAt: "2026-08-21T01:00:00.000Z",
      modelAvailable: false,
      knownCustomTypes: ["portable-note"],
    });
    const sessionDir = resolvePortableSessionImportDir({ targetCwd, targetHome });
    assert.equal(sessionDir.startsWith(targetSessionRoot), true, "default placement lives in target HOME's Pi session tree");
    const importedWrite = await writeImportedPortableSession({ sessionDir, ...imported, nonce: () => "roundtrip" });
    const rows = parseJsonl(await readFile(importedWrite.destination, "utf8"));

    assert.equal(rows[0].id, "imported-id");
    assert.equal(rows[0].cwd, targetCwd);
    assert.equal(rows[0].portableImport.parentSession.id, "origin-id");
    assert.equal(rows[0].portableImport.parentSession.host, "linux-origin");
    assert.match(rows[1].message.content[0].text, new RegExp(`${targetCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/src/main\\.js`));
    assert.match(rows[1].message.content[0].text, /\/opt\/shared\/config\.json/);
    assert.equal(rows[1].message.content[1].data.length, 4096, "inline image survives byte-for-byte");
    assert.equal(rows[2].customType, "host-routing");
    assert.equal(rows[2].data.cache, `${targetHome}/.cache/pi`);
    assert.equal(rows[2].data.pulseSource, "remote.monitor", "host-specific payload is preserved for its extension to validate");
    assert.equal(rows[3].customType, "portable-note");
    assert.match(rows[3].content, new RegExp(targetCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(imported.report.unresolved, [
      { location: "/entries/0/message/content/0/text", path: "/opt/shared/config.json" },
    ]);
    assert.deepEqual(imported.report.warnings, [
      { code: "model-unavailable", provider: "origin-provider", model: "origin-model" },
      { code: "custom-type-unavailable", customType: "host-routing" },
    ]);
    assert.ok(Date.now() - startedAt < 2000, "bounded fixture round trip completes within two seconds");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
