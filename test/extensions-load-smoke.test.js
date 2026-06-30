// Runtime smoke test: every shipped extension must load and activate cleanly
// against the strict mock pi (bd-87d27a, follow-up to bd-ca0c46).
//
// The static guard (bd-90c02e) catches the registerCommand object-as-name class
// by scanning source; this is the runtime complement — it imports and activates
// every extension in package.json `pi.extensions` against the shared strict
// mock, so a load-time throw or a wrong pi API arg shape (registerCommand(name,
// def) / registerTool(def.name) / on(event,fn)) fails here instead of only
// crashing live (the bd-53da92 class).
//
// Some extensions import host-runtime-provided packages (e.g. @sinclair/typebox,
// the pi-coding-agent runtime) that are declared "*" but NOT installed in a bare
// `npm test` environment (package.json dependencies is intentionally empty). For
// those, importing throws ERR_MODULE_NOT_FOUND; we SKIP them with a diagnostic
// rather than fail, and a floor assertion guarantees the skips can't hollow the
// suite out to nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { createStrictMockPi } from "./helpers/strict-mock-pi.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const extensions = Array.isArray(pkg?.pi?.extensions) ? pkg.pi.extensions : [];

// Detect an unresolved host/optional dependency so we can skip rather than fail.
function missingHostPackage(err) {
  const msg = String(err && err.message);
  if (err?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package/.test(msg)) {
    const m = /Cannot find package '([^']+)'/.exec(msg);
    return m ? m[1] : "unknown";
  }
  return null;
}

let activatedCount = 0;

test("package.json declares pi extensions to smoke-test", () => {
  assert.ok(extensions.length > 0, "package.json pi.extensions must be non-empty");
});

for (const rel of extensions) {
  test(`loads + activates cleanly under strict mock pi: ${rel}`, async (t) => {
    let mod;
    try {
      mod = await import(pathToFileURL(path.join(root, rel)).href);
    } catch (err) {
      const hostPkg = missingHostPackage(err);
      if (hostPkg) {
        t.skip(`host/optional dependency not installed in this environment: ${hostPkg}`);
        return;
      }
      throw err; // a real load-time error (syntax / throw-at-import) — fail loudly
    }
    assert.equal(
      typeof mod.default,
      "function",
      `${rel} must export a default activation function (pi, opts?) => ...`,
    );
    const { pi } = createStrictMockPi();
    // Activating must not throw: catches wrong pi API arg shapes across every
    // bare-importable extension. The strict mock asserts the real
    // registerCommand/registerTool/on contracts and is otherwise permissive.
    await mod.default(pi);
    activatedCount += 1;
  });
}

test("a meaningful number of extensions actually activated (skips did not hollow out the suite)", () => {
  assert.ok(
    activatedCount >= 10,
    `expected >=10 extensions to import + activate under the strict mock, only ${activatedCount} did ` +
      `(if this dropped sharply, a shared import like the strict-mock helper or a common dep likely broke)`,
  );
});
