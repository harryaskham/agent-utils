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

test("usedActionlint is false on the YAML-only fallback path (bd-c2eb33)", () => {
  // Forcing useActionlint:false always selects a YAML fallback (or none),
  // never the actionlint semantic layer, so the missing-semantics signal must
  // report false regardless of whether actionlint is installed on this host.
  const result = lintWorkflows({ dir: repoWorkflowsDir, useActionlint: false });
  assert.equal(result.usedActionlint, false, "fallback path must report usedActionlint=false");
});

test("strict mode fails when actionlint is unavailable (bd-c2eb33)", () => {
  // useActionlint:false guarantees actionlint is not the validator, so strict
  // mode must turn the missing Actions-semantic layer into a hard failure,
  // whether or not a YAML fallback parser is present in this environment.
  const result = lintWorkflows({ dir: repoWorkflowsDir, useActionlint: false, strict: true });
  assert.equal(result.ok, false, "strict + no actionlint should fail");
  assert.ok(
    result.errors.some((e) => e.file === "(actionlint)"),
    "strict failure should be attributed to the missing actionlint layer",
  );
});
