#!/usr/bin/env node
// Ranked low-coverage module report built on the Node test runner's stable lcov
// coverage output (bd-391c04). Complements `npm run test:coverage`: instead of a
// long per-file table, it prints the lowest-covered source modules worst-first
// so you can see what to test next at a glance.
//
// Usage:
//   node scripts/coverage-summary.mjs              # run coverage, print summary
//   node scripts/coverage-summary.mjs path.lcov    # summarize an existing lcov
//   node scripts/coverage-summary.mjs --threshold 80
//   node scripts/coverage-summary.mjs --all        # show every file

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const pct = (hit, found) => (found > 0 ? (hit / found) * 100 : 100);

/**
 * Parse lcov text into ranked per-file coverage records.
 * @param {string} lcovText
 * @param {{ threshold?: number, all?: boolean }} [options]
 * @returns {{ records: Array<{file:string,line:number,branch:number,func:number,lines:number}>,
 *            totals: {line:number,branch:number,func:number,files:number} }}
 */
export function summarizeLcov(lcovText, { threshold = 90, all = false } = {}) {
  const files = [];
  let cur = null;
  const totals = { LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0, files: 0 };
  for (const line of String(lcovText ?? "").split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      cur = { file: line.slice(3), LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("LF:")) cur.LF = Number(line.slice(3)) || 0;
    else if (line.startsWith("LH:")) cur.LH = Number(line.slice(3)) || 0;
    else if (line.startsWith("BRF:")) cur.BRF = Number(line.slice(4)) || 0;
    else if (line.startsWith("BRH:")) cur.BRH = Number(line.slice(4)) || 0;
    else if (line.startsWith("FNF:")) cur.FNF = Number(line.slice(4)) || 0;
    else if (line.startsWith("FNH:")) cur.FNH = Number(line.slice(4)) || 0;
    else if (line === "end_of_record") {
      files.push(cur);
      totals.LF += cur.LF; totals.LH += cur.LH;
      totals.BRF += cur.BRF; totals.BRH += cur.BRH;
      totals.FNF += cur.FNF; totals.FNH += cur.FNH;
      totals.files += 1;
      cur = null;
    }
  }
  const records = files
    .map((f) => ({
      file: f.file,
      line: pct(f.LH, f.LF),
      branch: pct(f.BRH, f.BRF),
      func: pct(f.FNH, f.FNF),
      lines: f.LF,
    }))
    .filter((r) => all || r.line < threshold || r.func < threshold)
    .sort((a, b) => a.line - b.line || a.func - b.func || a.file.localeCompare(b.file));
  return {
    records,
    totals: {
      line: pct(totals.LH, totals.LF),
      branch: pct(totals.BRH, totals.BRF),
      func: pct(totals.FNH, totals.FNF),
      files: totals.files,
    },
  };
}

function fmt(n) {
  return `${n.toFixed(2).padStart(6)}%`;
}

export function renderSummary(summary, { threshold, all }) {
  const lines = [];
  const heading = all
    ? "Coverage summary (all files, lowest line coverage first):"
    : `Coverage summary (modules below ${threshold}% line or func, worst first):`;
  lines.push(heading);
  if (summary.records.length === 0) {
    lines.push(`  (none — every file is at or above ${threshold}% line and func coverage)`);
  } else {
    for (const r of summary.records) {
      lines.push(`  line ${fmt(r.line)}  branch ${fmt(r.branch)}  func ${fmt(r.func)}  ${r.file}`);
    }
  }
  const t = summary.totals;
  lines.push(`Overall: line ${fmt(t.line)} / branch ${fmt(t.branch)} / func ${fmt(t.func)} across ${t.files} files`);
  return lines.join("\n");
}

export function parseArgs(argv) {
  const opts = { threshold: 90, all: false, lcovPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") opts.all = true;
    else if (arg === "--threshold") opts.threshold = Number(argv[++i]) || opts.threshold;
    else if (!arg.startsWith("--")) opts.lcovPath = arg;
  }
  return opts;
}

function runCoverageToLcov() {
  const dir = mkdtempSync(join(tmpdir(), "agent-utils-cov-"));
  const lcovPath = join(dir, "coverage.lcov");
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--experimental-test-coverage",
      "--test-reporter=lcov",
      `--test-reporter-destination=${lcovPath}`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stderr.write("warning: test run exited non-zero; coverage may be incomplete\n");
  }
  const text = readFileSync(lcovPath, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return text;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const lcovText = opts.lcovPath ? readFileSync(opts.lcovPath, "utf8") : runCoverageToLcov();
  const summary = summarizeLcov(lcovText, opts);
  process.stdout.write(`${renderSummary(summary, opts)}\n`);
}

// Only run main when invoked directly, not when imported by tests.
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
