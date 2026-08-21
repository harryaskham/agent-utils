import test from "node:test";
import assert from "node:assert/strict";
import {
  PORTABLE_SESSION_BUNDLE_VERSION,
  createImportedSessionProvenance,
  createPortableSessionManifest,
  translatePortableValue,
  validatePortableSessionManifest,
} from "../extensions/lib/portable-session.js";

function manifest(overrides = {}) {
  return createPortableSessionManifest({
    origin: {
      sessionId: "origin-session",
      host: "aurora",
      home: "/home/harry",
      cwd: "/home/harry/work/agent-utils",
    },
    repository: { remote: "git@example/repo", commit: "abc123" },
    model: { provider: "github-copilot", id: "example/model" },
    customTypes: ["z-state", "a-state", "z-state"],
    createdAt: "2026-08-21T00:00:00.000Z",
    ...overrides,
  });
}

test("manifest creation is versioned, validated, cloned, and deterministic with an injected timestamp", () => {
  const source = { sessionId: "s1", host: "aurora", home: "/home/h", cwd: "/home/h/repo" };
  const result = createPortableSessionManifest({ origin: source, customTypes: ["z", "a", "z"], createdAt: "fixed" });
  source.cwd = "/mutated";
  assert.equal(result.bundleVersion, PORTABLE_SESSION_BUNDLE_VERSION);
  assert.equal(result.origin.cwd, "/home/h/repo");
  assert.deepEqual(result.customTypes, ["a", "z"]);
  assert.equal(result.createdAt, "fixed");
  assert.equal(validatePortableSessionManifest(result), result);
});

test("manifest validation rejects unsupported versions and incomplete origin metadata", () => {
  assert.throws(() => validatePortableSessionManifest({ bundleVersion: 99, origin: {} }), /unsupported.*version/i);
  assert.throws(
    () => createPortableSessionManifest({ origin: { sessionId: "s", host: "h", home: "/home/h" } }),
    /origin\.cwd/,
  );
});

test("translation rewrites exact and nested prefixes across differing HOME and checkout roots", () => {
  const input = {
    cwd: "/home/harry/work/repo",
    tool: { path: "/home/harry/work/repo/src/a.js" },
    command: "cd /home/harry/work/repo && cp /home/harry/file /tmp/out",
    custom: { customType: "host-state", data: ["/home/harry/.cache/state"] },
  };
  const { value, report } = translatePortableValue(input, [
    { from: "/home/harry/work/repo", to: "/Users/harry/dev/repo" },
    { from: "/home/harry", to: "/Users/harry" },
  ]);
  assert.equal(value.cwd, "/Users/harry/dev/repo");
  assert.equal(value.tool.path, "/Users/harry/dev/repo/src/a.js");
  assert.equal(value.command, "cd /Users/harry/dev/repo && cp /Users/harry/file /tmp/out");
  assert.equal(value.custom.customType, "host-state");
  assert.equal(value.custom.data[0], "/Users/harry/.cache/state");
  assert.ok(report.translated.some((entry) => entry.location === "/tool/path"));
  assert.deepEqual(report.unresolved, [{ location: "/command", path: "/tmp/out" }]);
});

test("translation is boundary safe and does not rewrite lookalike prefixes", () => {
  const input = {
    exact: "/home/harry",
    child: "/home/harry/repo",
    sibling: "/home/harry-old/repo",
    embedded: "prefix/home/harry/repo",
    url: "https://example.test/home/harry/repo",
  };
  const { value } = translatePortableValue(input, [{ from: "/home/harry", to: "/data/data/com.termux/files/home" }]);
  assert.equal(value.exact, "/data/data/com.termux/files/home");
  assert.equal(value.child, "/data/data/com.termux/files/home/repo");
  assert.equal(value.sibling, "/home/harry-old/repo");
  assert.equal(value.embedded, "prefix/home/harry/repo");
  assert.equal(value.url, "https://example.test/home/harry/repo");
});

test("translation reports unresolved absolute paths without deleting them", () => {
  const { value, report } = translatePortableValue(
    { fullOutputPath: "/var/tmp/pi-output.txt", message: "read '/opt/service/config.json'" },
    [{ from: "/home/source", to: "/Users/target" }],
  );
  assert.equal(value.fullOutputPath, "/var/tmp/pi-output.txt");
  assert.deepEqual(report.unresolved, [
    { location: "/fullOutputPath", path: "/var/tmp/pi-output.txt" },
    { location: "/message", path: "/opt/service/config.json" },
  ]);
});

test("Windows-style declared prefixes translate conservatively", () => {
  const { value, report } = translatePortableValue(
    { path: "C:\\Users\\Harry\\repo\\file.txt", near: "C:\\Users\\Harry-old\\file.txt" },
    [{ from: "C:\\Users\\Harry", to: "/home/harry" }],
  );
  assert.equal(value.path, "/home/harry\\repo\\file.txt");
  assert.equal(value.near, "C:\\Users\\Harry-old\\file.txt");
  assert.deepEqual(report.unresolved, [{ location: "/near", path: "C:\\Users\\Harry-old\\file.txt" }]);
});

test("import provenance records a new id and immutable origin identity", () => {
  const result = createImportedSessionProvenance(manifest(), {
    sessionId: "new-session",
    importedAt: "2026-08-21T01:00:00.000Z",
  });
  assert.deepEqual(result, {
    sessionId: "new-session",
    importedAt: "2026-08-21T01:00:00.000Z",
    parentSession: { id: "origin-session", host: "aurora", bundleVersion: 1 },
  });
  assert.throws(() => createImportedSessionProvenance(manifest(), {}), /new sessionId/);
});
