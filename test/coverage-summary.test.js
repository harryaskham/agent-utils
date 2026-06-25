// Unit tests for the pure summarizeLcov parser used by the coverage-summary
// dev tool (bd-391c04). Asserts lcov parsing, percentage math (incl. the
// found==0 -> 100% edge), threshold filtering, sorting, and totals.

import test from "node:test";
import assert from "node:assert/strict";

import { summarizeLcov, parseArgs, renderSummary } from "../scripts/coverage-summary.mjs";

const SAMPLE = [
  "TN:",
  "SF:extensions/a.js",
  "FNF:2",
  "FNH:1",
  "BRF:4",
  "BRH:2",
  "LH:8",
  "LF:10",
  "end_of_record",
  "TN:",
  "SF:extensions/b.js",
  "FNF:0",
  "FNH:0",
  "BRF:0",
  "BRH:0",
  "LH:5",
  "LF:5",
  "end_of_record",
  "",
].join("\n");

test("summarizeLcov computes line/branch/func percentages per file", () => {
  const { records } = summarizeLcov(SAMPLE, { all: true });
  const a = records.find((r) => r.file === "extensions/a.js");
  assert.equal(a.line, 80); // 8/10
  assert.equal(a.branch, 50); // 2/4
  assert.equal(a.func, 50); // 1/2
  assert.equal(a.lines, 10);
});

test("summarizeLcov treats found==0 as 100% (no lines/branches/funcs to miss)", () => {
  const { records } = summarizeLcov(SAMPLE, { all: true });
  const b = records.find((r) => r.file === "extensions/b.js");
  assert.equal(b.line, 100); // 5/5
  assert.equal(b.branch, 100); // 0/0 -> 100
  assert.equal(b.func, 100); // 0/0 -> 100
});

test("summarizeLcov filters to modules below the line-or-func threshold", () => {
  const below90 = summarizeLcov(SAMPLE, { threshold: 90 });
  assert.deepEqual(below90.records.map((r) => r.file), ["extensions/a.js"]); // b.js is 100%
  const below40 = summarizeLcov(SAMPLE, { threshold: 40 });
  assert.deepEqual(below40.records.map((r) => r.file), []); // a.js line 80 / func 50 both >= 40
  // func below threshold also qualifies a file even when its line coverage is high.
  const below60 = summarizeLcov(SAMPLE, { threshold: 60 });
  assert.deepEqual(below60.records.map((r) => r.file), ["extensions/a.js"]); // func 50 < 60
});

test("summarizeLcov sorts worst line coverage first and reports overall totals", () => {
  const { records, totals } = summarizeLcov(SAMPLE, { all: true });
  assert.deepEqual(records.map((r) => r.file), ["extensions/a.js", "extensions/b.js"]); // 80 before 100
  assert.equal(totals.files, 2);
  assert.equal(Math.round(totals.line * 100) / 100, 86.67); // 13/15
  assert.equal(totals.branch, 50); // 2/4
  assert.equal(totals.func, 50); // 1/2
});

test("summarizeLcov tolerates empty / malformed input", () => {
  assert.deepEqual(summarizeLcov("").records, []);
  assert.deepEqual(summarizeLcov(null).records, []);
  assert.equal(summarizeLcov("").totals.files, 0);
});

test("parseArgs handles defaults, flags, --threshold N, and a positional lcov path (bd-5a4ca0)", () => {
  assert.deepEqual(parseArgs([]), { threshold: 90, all: false, lcovPath: null });
  assert.equal(parseArgs(["--all"]).all, true);
  assert.equal(parseArgs(["--threshold", "80"]).threshold, 80);
  assert.equal(parseArgs(["cov.lcov"]).lcovPath, "cov.lcov");
  const mixed = parseArgs(["--threshold", "75", "--all", "x.lcov"]);
  assert.deepEqual(mixed, { threshold: 75, all: true, lcovPath: "x.lcov" });
  // A non-numeric threshold keeps the default rather than becoming NaN.
  assert.equal(parseArgs(["--threshold", "oops"]).threshold, 90);
});

test("renderSummary reflects threshold/all in the heading, lists rows, and prints totals (bd-5a4ca0)", () => {
  const summary = summarizeLcov(SAMPLE, { all: true });
  const out = renderSummary(summary, { threshold: 90, all: false });
  assert.match(out, /modules below 90% line or func/);
  assert.match(out, /extensions\/a\.js/);
  assert.match(out, /Overall: line .* across 2 files/);
  // --all switches the heading wording.
  assert.match(renderSummary(summary, { threshold: 90, all: true }), /all files, lowest line coverage first/);
  // Empty records render the 'none' branch.
  const none = renderSummary({ records: [], totals: { line: 100, branch: 100, func: 100, files: 3 } }, { threshold: 90, all: false });
  assert.match(none, /none — every file is at or above 90%/);
});
