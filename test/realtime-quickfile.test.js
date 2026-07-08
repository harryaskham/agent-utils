import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveQuickfileBead,
  fileQuickfileUtterance,
  makeCacoRunner,
} from "../extensions/lib/realtime-quickfile.js";

test("deriveQuickfileBead returns null for empty / whitespace-only input", () => {
  assert.equal(deriveQuickfileBead(""), null);
  assert.equal(deriveQuickfileBead("   \n\t "), null);
  assert.equal(deriveQuickfileBead(null), null);
  assert.equal(deriveQuickfileBead(undefined), null);
});

test("deriveQuickfileBead: short single-line utterance -> title == description == trimmed text", () => {
  const d = deriveQuickfileBead("  add a dark mode toggle  ");
  assert.deepEqual(d, { title: "add a dark mode toggle", description: "add a dark mode toggle" });
});

test("deriveQuickfileBead: multiline -> title is first line, description is full text", () => {
  const d = deriveQuickfileBead("fix the login bug\nit 500s when the email has a plus sign");
  assert.equal(d.title, "fix the login bug");
  assert.equal(d.description, "fix the login bug\nit 500s when the email has a plus sign");
});

test("deriveQuickfileBead: long line -> title truncated on a word boundary with ellipsis; description keeps full text", () => {
  const long =
    "we should add a reusable composite action for the azure ephemeral rust not nix CI so gcc comes via nix shell and builds stop failing";
  const d = deriveQuickfileBead(long, { titleMax: 72 });
  assert.ok(d.title.length <= 73, `title too long: ${d.title.length}`); // <=72 chars + ellipsis
  assert.ok(d.title.endsWith("…"), "expected ellipsis");
  assert.ok(!d.title.slice(0, -1).endsWith(" "), "no trailing space before ellipsis");
  assert.equal(d.description, long, "description keeps the full utterance");
  // Word-boundary cut: the title (minus ellipsis) is a prefix of the source.
  assert.ok(long.startsWith(d.title.slice(0, -1)), "title should be a clean prefix");
});

test("fileQuickfileUtterance: empty utterance is skipped, no runner call", async () => {
  let called = false;
  const res = await fileQuickfileUtterance("   ", { runCaco: async () => { called = true; return { stdout: "", stderr: "", code: 0 }; } });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.equal(called, false, "runner must not be called for an empty utterance");
});

test("fileQuickfileUtterance: draft create shells `caco bd create --status draft` and parses the bead id", async () => {
  const calls = [];
  const runCaco = async (args) => { calls.push(args); return { stdout: "created bd-a1b2c3 (draft)\n", stderr: "", code: 0 }; };
  const res = await fileQuickfileUtterance("add a dark mode toggle", { runCaco, project: "agent-utils" });
  assert.equal(res.ok, true);
  assert.equal(res.beadId, "bd-a1b2c3");
  assert.equal(res.title, "add a dark mode toggle");
  assert.equal(res.expand, false);
  const args = calls[0];
  assert.deepEqual(args.slice(0, 2), ["bd", "create"]);
  assert.ok(args.includes("--status") && args[args.indexOf("--status") + 1] === "draft", "must create a draft");
  assert.ok(args.includes("--project") && args[args.indexOf("--project") + 1] === "agent-utils");
  assert.equal(args[args.indexOf("--title") + 1], "add a dark mode toggle");
  assert.equal(args[args.indexOf("--description") + 1], "add a dark mode toggle");
});

test("fileQuickfileUtterance: expand mode shells `caco bd expand --text`", async () => {
  const calls = [];
  const runCaco = async (args) => { calls.push(args); return { stdout: "expanded into bd-111111, bd-222222\n", stderr: "", code: 0 }; };
  const res = await fileQuickfileUtterance("three ideas: A, then B, then C", { runCaco, expand: true });
  assert.equal(res.ok, true);
  assert.equal(res.expand, true);
  const args = calls[0];
  assert.deepEqual(args.slice(0, 2), ["bd", "expand"]);
  assert.equal(args[args.indexOf("--text") + 1], "three ideas: A, then B, then C");
  assert.ok(!args.includes("--status"), "expand must not pass --status");
});

test("fileQuickfileUtterance: non-zero caco exit surfaces an error, not a throw", async () => {
  const runCaco = async () => ({ stdout: "", stderr: "daemon unreachable", code: 1 });
  const res = await fileQuickfileUtterance("something", { runCaco });
  assert.equal(res.ok, false);
  assert.equal(res.error, "daemon unreachable");
  assert.equal(res.title, "something");
});

test("fileQuickfileUtterance: a throwing runner is caught and reported", async () => {
  const runCaco = async () => { throw new Error("spawn ENOENT"); };
  const res = await fileQuickfileUtterance("something", { runCaco });
  assert.equal(res.ok, false);
  assert.match(res.error, /ENOENT/);
});

test("makeCacoRunner uses the injected execImpl and never throws", async () => {
  let received;
  const execImpl = (bin, args, opts, cb) => { received = { bin, args }; cb(null, "created bd-abcdef\n", ""); };
  const run = makeCacoRunner({ cacoBin: "caco", execImpl });
  const res = await run(["bd", "create", "--status", "draft"]);
  assert.equal(received.bin, "caco");
  assert.deepEqual(received.args, ["bd", "create", "--status", "draft"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /bd-abcdef/);
});

test("makeCacoRunner maps an execImpl error to a non-zero code", async () => {
  const execImpl = (bin, args, opts, cb) => cb(Object.assign(new Error("boom"), { code: 7 }), "", "boom");
  const run = makeCacoRunner({ execImpl });
  const res = await run(["bd", "create"]);
  assert.equal(res.code, 7);
  assert.equal(res.stderr, "boom");
});
