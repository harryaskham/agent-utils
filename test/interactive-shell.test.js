import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { buildSpawnArgs } from "../extensions/interactive-shell.js";

test("Darwin uses the stdio-safe PTY bridge instead of incompatible BSD script flags", () => {
  const spec = buildSpawnArgs("/usr/bin/printf", ["hello %s\\n", "world"], 100, 20, "darwin", { KEEP: "yes", PYTHON: "python-test" });
  assert.equal(spec.cmd, "python-test");
  assert.match(spec.args[0], /scripts\/pty-bridge\.py$/);
  assert.deepEqual(spec.args.slice(1), ["/usr/bin/printf", "hello %s\\n", "world"]);
  assert.equal(spec.env.KEEP, "yes");
  assert.equal(spec.env.TERM, "xterm-256color");
  assert.equal(spec.env.COLUMNS, "100");
  assert.equal(spec.env.LINES, "20");
});

test("Linux uses util-linux script with one safely quoted command", () => {
  const spec = buildSpawnArgs("/bin/echo", ["two words", "it's-safe"], 80, 24, "linux", {});
  assert.equal(spec.cmd, "script");
  assert.equal(spec.args[0], "-qfc");
  assert.equal(spec.args[2], "/dev/null");
  assert.equal(spec.args[1], "'/bin/echo' 'two words' 'it'\\''s-safe'");
});

test("Darwin PTY bridge gives a piped child a real terminal", { skip: process.platform !== "darwin" }, () => {
  const spec = buildSpawnArgs("/usr/bin/tty", [], 80, 24, "darwin", process.env);
  const result = spawnSync(spec.cmd, spec.args, { env: spec.env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(`${result.stdout}${result.stderr}`, /\/dev\/ttys?\d+/, "child command observes an allocated PTY rather than a Node pipe");
});
