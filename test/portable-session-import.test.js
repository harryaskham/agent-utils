import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import portableSessionExtension, {
  buildImportedPortableSession,
  buildPortableSessionBundle,
  formatPortableSessionCompatibilityReport,
  parseSessionImportArgs,
  portableSessionDirectoryName,
  resolvePortableSessionImportDir,
  validatePortableSessionBundle,
  writeImportedPortableSession,
} from "../extensions/portable-session.js";

const originHeader = {
  type: "session",
  version: 3,
  id: "origin-session",
  timestamp: "2026-08-21T00:00:00.000Z",
  cwd: "/home/source/work/repo",
};

const originEntries = [
  {
    type: "message",
    id: "root0001",
    parentId: null,
    timestamp: "2026-08-21T00:00:01.000Z",
    message: {
      role: "user",
      content: "Read /home/source/work/repo/src/main.js and /opt/preserved/config.json",
      timestamp: 1,
    },
  },
  {
    type: "custom",
    id: "state002",
    parentId: "root0001",
    timestamp: "2026-08-21T00:00:02.000Z",
    customType: "origin-host-state",
    data: { cache: "/home/source/.cache/pi", untouched: true },
  },
];

function bundle() {
  return buildPortableSessionBundle({
    header: originHeader,
    entries: originEntries,
    host: "origin-host",
    home: "/home/source",
    repository: { remote: "git@example/repo", commit: "abc" },
    model: { provider: "origin-provider", id: "origin-model" },
    createdAt: "2026-08-21T00:00:03.000Z",
  }).bundle;
}

function parseJsonl(text) {
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

test("session-import argument parsing accepts paths and bounds and rejects missing values", () => {
  assert.deepEqual(parseSessionImportArgs("'bundle file.json' --cwd '/target work' --session-dir=/sessions --max-bytes=123"), {
    bundlePath: "bundle file.json",
    targetCwd: "/target work",
    sessionDir: "/sessions",
    maxBytes: 123,
    help: false,
  });
  assert.throws(() => parseSessionImportArgs(""), /requires a bundle path/);
  assert.throws(() => parseSessionImportArgs("a b"), /exactly one bundle path/);
  assert.throws(() => parseSessionImportArgs("a --cwd"), /requires a path/);
  assert.throws(() => parseSessionImportArgs("a --cwd --max-bytes 10"), /requires a path/);
  assert.throws(() => parseSessionImportArgs("a --session-dir="), /requires a path/);
});

test("bundle validation rejects conflicting identity, duplicate IDs, and dangling parents", () => {
  assert.equal(validatePortableSessionBundle(bundle()).manifest.origin.sessionId, "origin-session");

  const wrongHeader = structuredClone(bundle());
  wrongHeader.session.header.id = "other";
  assert.throws(() => validatePortableSessionBundle(wrongHeader), /header id does not match/);

  const duplicate = structuredClone(bundle());
  duplicate.session.entries[1].id = duplicate.session.entries[0].id;
  assert.throws(() => validatePortableSessionBundle(duplicate), /duplicate entry id/);

  const dangling = structuredClone(bundle());
  dangling.session.entries[1].parentId = "missing";
  assert.throws(() => validatePortableSessionBundle(dangling), /unresolved parentId/);
});

test("import creates a new local identity, provenance, conservative translation, and warnings", () => {
  const source = bundle();
  source.session.header.parentSession = "/home/source/.pi/agent/sessions/origin.jsonl";
  const sourceBefore = structuredClone(source);
  const imported = buildImportedPortableSession({
    bundle: source,
    targetCwd: "/Users/target/dev/repo",
    targetHome: "/Users/target",
    sessionId: "new-session",
    importedAt: "2026-08-21T01:00:00.000Z",
    modelAvailable: false,
    knownCustomTypes: [],
  });

  assert.equal(imported.header.id, "new-session");
  assert.equal(imported.header.cwd, "/Users/target/dev/repo");
  assert.equal(imported.header.parentSession, undefined, "portable origins are not misrepresented as local parent-session paths");
  assert.deepEqual(imported.header.portableImport, {
    sessionId: "new-session",
    importedAt: "2026-08-21T01:00:00.000Z",
    parentSession: { id: "origin-session", host: "origin-host", bundleVersion: 1 },
  });
  assert.match(imported.entries[0].message.content, /\/Users\/target\/dev\/repo\/src\/main\.js/);
  assert.match(imported.entries[0].message.content, /\/opt\/preserved\/config\.json/);
  assert.equal(imported.entries[1].data.cache, "/Users/target/.cache/pi");
  assert.deepEqual(imported.report.unresolved, [
    { location: "/entries/0/message/content", path: "/opt/preserved/config.json" },
  ]);
  assert.deepEqual(imported.report.warnings, [
    { code: "model-unavailable", provider: "origin-provider", model: "origin-model" },
    { code: "custom-type-unavailable", customType: "origin-host-state" },
  ]);
  assert.deepEqual(source, sourceBefore, "import must never mutate the source bundle");
});

test("unknown compatibility remains a warning, never a hard import failure", () => {
  const imported = buildImportedPortableSession({
    bundle: bundle(),
    targetCwd: "/data/data/com.termux/files/home/repo",
    targetHome: "/data/data/com.termux/files/home",
    sessionId: "termux-session",
    modelAvailable: null,
    knownCustomTypes: null,
  });
  const text = formatPortableSessionCompatibilityReport(imported.report);
  assert.match(text, /model-unverified origin-provider\/origin-model/);
  assert.match(text, /custom-type-unverified origin-host-state/);
  assert.match(text, /unresolved \/opt\/preserved\/config.json.*preserved/);
  assert.equal(imported.entries[1].customType, "origin-host-state", "unknown custom entry stays structurally intact");
});

test("destination placement matches Pi default dirs and preserves explicit shared session dirs", () => {
  const root = "/tmp/pi-agent-test/sessions";
  const currentCwd = "/home/source/repo";
  const targetCwd = "/Users/target/repo";
  const currentDefault = join(root, portableSessionDirectoryName(currentCwd));
  assert.equal(
    resolvePortableSessionImportDir({ targetCwd, currentCwd, currentSessionDir: currentDefault }),
    join(root, portableSessionDirectoryName(targetCwd)),
  );
  assert.equal(
    resolvePortableSessionImportDir({ targetCwd, currentCwd, currentSessionDir: "/shared/pi-sessions" }),
    "/shared/pi-sessions",
    "custom --session-dir remains shared; Pi filters it by header cwd",
  );
  assert.equal(
    resolvePortableSessionImportDir({ targetCwd, currentCwd, currentSessionDir: currentDefault, sessionDir: "/explicit" }),
    "/explicit",
  );
});

test("atomic imported-session write is JSONL, mode 0600, and collision-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-session-import-write-"));
  const imported = buildImportedPortableSession({
    bundle: bundle(),
    targetCwd: root,
    targetHome: root,
    sessionId: "new-session",
    importedAt: "2026-08-21T01:00:00.000Z",
  });
  try {
    const result = await writeImportedPortableSession({ sessionDir: root, ...imported, nonce: () => "fixed" });
    const rows = parseJsonl(await readFile(result.destination, "utf8"));
    assert.equal(rows.length, originEntries.length + 1);
    assert.equal(rows[0].id, "new-session");
    assert.equal((await stat(result.destination)).mode & 0o777, 0o600);
    await assert.rejects(
      () => writeImportedPortableSession({ sessionDir: root, ...imported, nonce: () => "second" }),
      /refusing to overwrite/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registered command performs a differing-HOME round trip and emits a compatibility report", async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-session-command-import-"));
  const targetCwd = join(root, "target-checkout");
  const sessionDir = join(root, "sessions");
  const bundlePath = join(root, "portable.json");
  await mkdir(targetCwd, { recursive: true });
  const source = `${JSON.stringify(bundle(), null, 2)}\n`;
  await writeFile(bundlePath, source);

  const commands = new Map();
  const notices = [];
  const pi = { registerCommand(name, definition) { commands.set(name, definition); } };
  portableSessionExtension(pi);
  const ctx = {
    cwd: root,
    modelRegistry: { find: () => { throw new Error("provider catalogue unavailable"); } },
    sessionManager: {
      getSessionDir: () => sessionDir,
      getCwd: () => root,
    },
    ui: { notify(message, level) { notices.push({ message, level }); } },
  };

  try {
    await commands.get("session-import").handler(`portable.json --cwd '${targetCwd}'`, ctx);
    const files = await readdir(sessionDir);
    assert.equal(files.filter((name) => name.endsWith(".jsonl")).length, 1);
    const rows = parseJsonl(await readFile(join(sessionDir, files.find((name) => name.endsWith(".jsonl"))), "utf8"));
    assert.notEqual(rows[0].id, originHeader.id);
    assert.equal(rows[0].cwd, targetCwd);
    assert.equal(rows[0].portableImport.parentSession.host, "origin-host");
    assert.equal(await readFile(bundlePath, "utf8"), source, "source bundle bytes stay unchanged");
    assert.match(notices[0].message, /Imported 2 entries from origin-host\/origin-session/);
    assert.equal(notices[0].level, "info");
    assert.match(notices[1].message, /compatibility report/i);
    assert.match(notices[1].message, /unresolved \/opt\/preserved\/config.json/);
    assert.match(notices[1].message, /model-unverified/);
    assert.match(notices[1].message, /custom-type-unverified/);
    assert.equal(notices[1].level, "warning");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registered command safely defaults target cwd to the current cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-session-command-default-cwd-"));
  const sessionDir = join(root, "sessions");
  await writeFile(join(root, "portable.json"), JSON.stringify(bundle()));
  const commands = new Map();
  const notices = [];
  portableSessionExtension({ registerCommand(name, definition) { commands.set(name, definition); } });
  const ctx = {
    cwd: root,
    sessionManager: { getSessionDir: () => sessionDir, getCwd: () => root },
    ui: { notify(message, level) { notices.push({ message, level }); } },
  };
  try {
    await commands.get("session-import").handler("portable.json", ctx);
    const file = (await readdir(sessionDir)).find((name) => name.endsWith(".jsonl"));
    assert.ok(file);
    const [header] = parseJsonl(await readFile(join(sessionDir, file), "utf8"));
    assert.equal(header.cwd, root);
    assert.equal(notices[0].level, "info");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registered command validates target cwd before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-session-command-bad-cwd-"));
  const sessionDir = join(root, "sessions");
  await writeFile(join(root, "portable.json"), JSON.stringify(bundle()));
  const commands = new Map();
  const notices = [];
  portableSessionExtension({ registerCommand(name, definition) { commands.set(name, definition); } });
  const ctx = {
    cwd: root,
    sessionManager: { getSessionDir: () => sessionDir, getCwd: () => root },
    ui: { notify(message, level) { notices.push({ message, level }); } },
  };
  try {
    await commands.get("session-import").handler("portable.json --cwd missing", ctx);
    assert.match(notices.at(-1).message, /target cwd does not exist/);
    assert.equal(notices.at(-1).level, "error");
    await assert.rejects(() => access(sessionDir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
