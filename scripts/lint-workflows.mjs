#!/usr/bin/env node
// bd-ce9baf: Validate .github/workflows/*.{yml,yaml} locally and in CI so
// workflow syntax/structure errors are caught before a push instead of only
// failing after the fact.
//
// Validator selection (best available, in priority order):
//   1. `actionlint` on PATH  -> full Actions-specific semantic + syntax check.
//   2. `ruby -ryaml`         -> YAML well-formedness (reliably present: system
//                               ruby on macOS, preinstalled on ubuntu-latest
//                               GitHub runners; this is the documented fallback
//                               from bd-ce9baf / bd-e9884a).
//   3. `python3` + PyYAML    -> YAML well-formedness, if available.
//
// If NONE of the above is available, the linter prints a clear warning and
// exits 0 (skip) rather than failing, so `npm run check` does not regress in a
// parser-less environment. When a validator is available it is strict and any
// malformed workflow fails the check.
//
// bd-c2eb33: when actionlint specifically is absent but a YAML-only fallback
// (ruby/python) runs, the check previously passed *silently*, so a local
// `npm run check` could go green while CI's actionlint gate (which also checks
// Actions semantics: runner labels, expression syntax, ...) fails. To close
// that "local green != CI gate" gap, `lintWorkflows` now reports whether the
// actionlint semantic layer actually ran (`usedActionlint`), `main()` prints a
// loud, non-silent warning whenever it falls back to YAML-only, and setting
// `LINT_WORKFLOWS_STRICT=1` (the `strict` option) turns an actionlint-absent
// run into a hard, non-zero failure for callers that want strict local/CI
// parity. actionlint ships in the repo's nix devShell.

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** List `.github/workflows/*.{yml,yaml}` under `dir`, sorted, as absolute paths. */
export function listWorkflowFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => join(dir, name));
}

function commandExists(command, args) {
  const probe = spawnSync(command, args, { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

/** Resolve the strongest available validator, or `null` if none. */
function resolveValidator({ useActionlint = true } = {}) {
  if (useActionlint && commandExists("actionlint", ["-version"])) {
    return {
      name: "actionlint",
      // actionlint validates every file in one invocation (syntax + semantics).
      lintAll(files) {
        const res = spawnSync("actionlint", files, { encoding: "utf8" });
        if (res.status === 0) return [];
        const detail = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
        return [{ file: "(actionlint)", reason: detail || "actionlint reported problems" }];
      },
    };
  }
  if (commandExists("ruby", ["-ryaml", "-e", "exit 0"])) {
    return { name: "ruby", lintFile: (file) => rubyYamlCheck(file) };
  }
  if (commandExists("python3", ["-c", "import yaml"])) {
    return { name: "python3+yaml", lintFile: (file) => pythonYamlCheck(file) };
  }
  return null;
}

function rubyYamlCheck(file) {
  const res = spawnSync("ruby", ["-ryaml", "-e", "YAML.load_file(ARGV[0])", file], {
    encoding: "utf8",
  });
  if (res.status === 0) return null;
  return `${res.stderr ?? ""}${res.stdout ?? ""}`.trim() || "ruby YAML parse failed";
}

function pythonYamlCheck(file) {
  const res = spawnSync(
    "python3",
    ["-c", "import sys,yaml; yaml.safe_load(open(sys.argv[1]))", file],
    { encoding: "utf8" },
  );
  if (res.status === 0) return null;
  return `${res.stderr ?? ""}${res.stdout ?? ""}`.trim() || "python YAML parse failed";
}

/**
 * Validate every workflow file under `dir`.
 *
 * Returns `{ ok, skipped, validator, files, errors }`. `skipped` is true (and
 * `ok` is true) when no validator is available, so callers can treat a
 * parser-less environment as a soft pass.
 */
export function lintWorkflows({ dir = join(repoRoot, ".github", "workflows"), useActionlint = true, strict = false } = {}) {
  const files = listWorkflowFiles(dir);
  if (files.length === 0) {
    return { ok: true, skipped: false, validator: "none", usedActionlint: false, files, errors: [] };
  }

  const validator = resolveValidator({ useActionlint });
  if (!validator) {
    // No validator at all. Soft-pass by default so a parser-less environment
    // does not regress `npm run check`; under strict mode this is a hard fail.
    if (strict) {
      return {
        ok: false,
        skipped: false,
        validator: "none",
        usedActionlint: false,
        files,
        errors: [
          {
            file: "(actionlint)",
            reason:
              "strict mode: no workflow validator available (actionlint required for Actions-semantic checks)",
          },
        ],
      };
    }
    return { ok: true, skipped: true, validator: "none", usedActionlint: false, files, errors: [] };
  }

  const usedActionlint = validator.name === "actionlint";
  const errors = [];
  if (validator.lintAll) {
    errors.push(...validator.lintAll(files));
  } else {
    for (const file of files) {
      const reason = validator.lintFile(file);
      if (reason) errors.push({ file, reason });
    }
  }

  // strict: a YAML-only fallback validated well-formedness but NOT actionlint's
  // Actions semantics, so treat the missing semantic layer as a failure.
  if (strict && !usedActionlint) {
    errors.push({
      file: "(actionlint)",
      reason: `strict mode: actionlint required but only '${validator.name}' (YAML well-formedness) is available; GitHub Actions semantics were not checked`,
    });
  }

  return { ok: errors.length === 0, skipped: false, validator: validator.name, usedActionlint, files, errors };
}

function main() {
  const strict = process.env.LINT_WORKFLOWS_STRICT === "1";
  const result = lintWorkflows({ strict });
  const rel = (file) => file.replace(`${repoRoot}/`, "");

  if (result.files.length === 0) {
    console.log("lint-workflows: no .github/workflows/*.yml files found; nothing to validate.");
    return 0;
  }
  if (result.skipped) {
    console.warn(
      "lint-workflows: WARNING no workflow validator available (need actionlint, " +
        "`ruby -ryaml`, or python3+PyYAML); skipping workflow validation. " +
        `${result.files.length} file(s) left unchecked.`,
    );
    return 0;
  }

  // Loud, non-silent signal when the actionlint semantic layer did NOT run but
  // a YAML-only fallback did: it proves well-formedness, not Actions semantics
  // (runner labels, expression syntax, ...), so a local pass here does not
  // guarantee CI's actionlint gate passes (bd-c2eb33). The no-validator-at-all
  // case is covered by the skipped branch (non-strict) or the FAILED strict
  // error (strict), so only warn when a real YAML fallback ran.
  if (!result.usedActionlint && result.validator !== "none") {
    console.warn(
      "lint-workflows: WARNING actionlint not found -- validated YAML well-formedness " +
        `only (via ${result.validator}), NOT GitHub Actions semantics (runner labels, ` +
        "expression syntax, etc.). CI runs actionlint, so a local pass here does NOT " +
        "guarantee the CI workflow-lint gate passes. Install actionlint (it ships in the " +
        "repo's nix devShell) for local/CI parity" +
        (strict ? "." : ", or set LINT_WORKFLOWS_STRICT=1 to make this a hard failure."),
    );
  }

  if (result.ok) {
    console.log(
      `lint-workflows: OK (${result.files.length} file(s) via ${result.validator}): ` +
        result.files.map(rel).join(", "),
    );
    return 0;
  }

  console.error(`lint-workflows: FAILED via ${result.validator}`);
  for (const { file, reason } of result.errors) {
    console.error(`  - ${file === "(actionlint)" ? file : rel(file)}: ${reason}`);
  }
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
