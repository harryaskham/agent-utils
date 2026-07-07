// Static import-graph guard (bd-4c80c0): every module reachable via TOP-LEVEL
// static `import`/`export ... from` starting at a test file must be resolvable
// under a bare `node --test` (no installed node_modules). A peer dependency
// (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@sinclair/typebox`,
// ...) is provided by the Pi host at runtime but is NOT installed here, so a
// top-level import of one in any statically test-reachable file makes the whole
// test crash at module-load with an opaque ERR_MODULE_NOT_FOUND.
//
// The fix for such a case is a lazy `await import(...)` (or dependency
// injection) inside the function that needs the peer dep — dynamic imports are
// intentionally NOT followed here, so they do not trip this guard. Extension
// entry files that are only loaded via the dynamic import in
// extensions-load-smoke.test.js may still import peer deps at the top level;
// this guard only constrains the STATIC graph rooted at test files (the part
// that must load for the suite to even collect).
//
// This complements extensions-load-smoke.test.js (which activates every
// extension against the strict mock and SKIPS peer-dep-importing entry files):
// that guards runtime activation shape, this guards static loadability of the
// test-reachable graph. Together they caught / now lock in the bd-aacc0c ports
// (firecracker-vm, app-automation, kitty-image-preview off typebox + pi-ai).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");
const requireFromRoot = createRequire(pathToFileURL(path.join(root, "package.json")));

// Line-anchored matchers for the three ES top-level import/export-from shapes.
// Line-anchoring (rather than spanning newlines) avoids matching a `from "..."`
// that appears inside a string/template literal in the module body.
const SINGLE_LINE_FROM = /^[ \t]*(?:import|export)\b[^\n]*?\bfrom[ \t]*["']([^"']+)["'][ \t]*;?[ \t]*$/gm;
const MULTILINE_CLOSE_FROM = /^[ \t]*\}[ \t]*from[ \t]*["']([^"']+)["'][ \t]*;?[ \t]*$/gm;
const SIDE_EFFECT_IMPORT = /^[ \t]*import[ \t]*["']([^"']+)["'][ \t]*;?[ \t]*$/gm;

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "crypto", "dns", "events", "fs", "http",
  "http2", "https", "module", "net", "os", "path", "perf_hooks", "process",
  "querystring", "readline", "stream", "string_decoder", "timers", "tls", "tty",
  "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

function isRelative(spec) {
  return spec.startsWith("./") || spec.startsWith("../");
}

function isBuiltin(spec) {
  if (spec.startsWith("node:")) return true;
  const bare = spec.split("/")[0];
  return NODE_BUILTINS.has(bare);
}

function topLevelSpecifiers(source) {
  const specs = [];
  for (const re of [SINGLE_LINE_FROM, MULTILINE_CLOSE_FROM, SIDE_EFFECT_IMPORT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

// Resolve a relative specifier to an on-disk file (bare, .js, or index.js).
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}

function walkTestImportGraph() {
  const testFiles = readdirSync(testDir)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join(testDir, f));

  const visited = new Set();
  const violations = [];
  const queue = testFiles.map((file) => ({ file, root: path.basename(file) }));

  while (queue.length > 0) {
    const { file, root: rootTest } = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);

    let source;
    try { source = readFileSync(file, "utf8"); } catch { continue; }

    for (const spec of topLevelSpecifiers(source)) {
      if (isBuiltin(spec)) continue;
      if (isRelative(spec)) {
        const target = resolveRelative(file, spec);
        if (target) {
          queue.push({ file: target, root: rootTest });
        } else {
          violations.push({ rootTest, file: path.relative(root, file), spec, why: "unresolved relative import" });
        }
        continue;
      }
      // Bare package specifier: must resolve from the package root, else it is
      // a peer dependency (or missing dep) that breaks `node --test`.
      try {
        requireFromRoot.resolve(spec);
      } catch {
        violations.push({ rootTest, file: path.relative(root, file), spec, why: "unresolved package (peer dep must be lazily imported)" });
      }
    }
  }

  return { visited, violations };
}

test("no statically test-reachable module top-level-imports an unresolvable peer dep (bd-4c80c0)", () => {
  const { violations } = walkTestImportGraph();
  const detail = violations
    .map((v) => `  [${v.rootTest}] ${v.file} -> "${v.spec}" (${v.why})`)
    .join("\n");
  assert.equal(
    violations.length,
    0,
    `Found ${violations.length} top-level import(s) that do not resolve under bare \`node --test\`.\n` +
      `Make the import lazy (\`await import(...)\`) or inject the dependency so the module loads without it:\n${detail}`,
  );
});

test("the import-graph walk visited a meaningful number of modules (guard is not hollowed out)", () => {
  const { visited } = walkTestImportGraph();
  assert.ok(
    visited.size >= 100,
    `expected the static test-import graph to span >=100 modules, only ${visited.size} were visited ` +
      `(if this dropped sharply, the import-matching regexes likely broke and the guard is no longer effective)`,
  );
});
