import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { lintWorkflows, listWorkflowFiles } from "../scripts/lint-workflows.mjs";

const repoWorkflowsDir = join(import.meta.dirname, "..", ".github", "workflows");

test("listWorkflowFiles finds the repo's workflow yaml files", () => {
  const files = listWorkflowFiles(repoWorkflowsDir);
  assert.ok(files.length >= 1, "expected at least one .github/workflows/*.yml file");
  assert.ok(
    files.every((f) => f.endsWith(".yml") || f.endsWith(".yaml")),
    "only yaml workflow files should be listed",
  );
});

test("the repository's own workflows are well-formed", () => {
  // Force the YAML-parser path so the result does not depend on actionlint
  // being installed (or on its semantic strictness).
  const result = lintWorkflows({ dir: repoWorkflowsDir, useActionlint: false });
  assert.equal(result.ok, true, `repo workflows should validate: ${JSON.stringify(result.errors)}`);
  if (!result.skipped) {
    assert.ok(["ruby", "python3+yaml"].includes(result.validator), `unexpected validator ${result.validator}`);
  }
});

test("an empty workflows directory is a soft pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "lint-workflows-empty-"));
  try {
    const result = lintWorkflows({ dir, useActionlint: false });
    assert.equal(result.ok, true);
    assert.equal(result.files.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed workflow is rejected when a YAML parser is available", () => {
  const root = mkdtempSync(join(tmpdir(), "lint-workflows-bad-"));
  const dir = join(root, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "good.yml"), "name: good\non: [push]\njobs:\n  noop:\n    runs-on: ubuntu-latest\n");
  // Unterminated flow sequence -> a hard YAML syntax error for both Psych and PyYAML.
  writeFileSync(join(dir, "bad.yml"), "name: bad\non: [push, pull_request\n");
  try {
    const result = lintWorkflows({ dir, useActionlint: false });
    if (result.skipped) {
      // No YAML parser in this environment; the linter intentionally soft-passes.
      assert.equal(result.ok, true);
    } else {
      assert.equal(result.ok, false, "malformed workflow should fail validation");
      assert.ok(
        result.errors.some((e) => e.file.endsWith("bad.yml")),
        "the malformed file should be reported",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
