// Robustness guard for the bd-53da92 incident: an extension called
// pi.registerCommand({ name, ... }) with a SINGLE object instead of the real
// two-arg form pi.registerCommand(name, { ... }). Pi stored the whole object as
// the command name, so the slash-command matcher's name.startsWith(input) threw
// "startsWith is not a function" for EVERY slash command and took down the harness.
//
// A single bad command registration must never be able to crash all commands
// again. This guard statically asserts that every registerCommand call across
// every shipped extension passes a string (literal or identifier) as the command
// name — never an object literal.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Pure detector (exported for self-test): return the leading non-space character
// of the first argument of every registerCommand(...) / registerCommand?.(...)
// call in the given source. A '{' means an object literal was passed as the
// name — the bd-53da92 bug.
export function registerCommandFirstArgChars(source) {
  const out = [];
  const re = /registerCommand\s*(?:\?\.)?\s*\(\s*(\S)/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

const isStringOrIdentStart = (ch) => /['"`]/.test(ch) || /[A-Za-z_$]/.test(ch);

test("detector flags an object-literal name and accepts string/identifier names (bd-53da92)", () => {
  // The exact broken shape from bd-53da92 is detected:
  assert.deepEqual(registerCommandFirstArgChars(`pi.registerCommand?.({ name: "x" })`), ["{"]);
  // The correct two-arg shapes are accepted:
  assert.deepEqual(registerCommandFirstArgChars(`pi.registerCommand("rt", {})`), ['"']);
  assert.deepEqual(registerCommandFirstArgChars(`pi.registerCommand('stt', {})`), ["'"]);
  assert.deepEqual(registerCommandFirstArgChars(`pi.registerCommand(name, {})`), ["n"]);
  // Multiple calls in one source are all captured:
  assert.deepEqual(
    registerCommandFirstArgChars(`pi.registerCommand("a",{});pi.registerCommand?.("b",{})`),
    ['"', '"'],
  );
});

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
// Pi extensions are declared under the package.json "pi" key.
const extensions = Array.isArray(pkg?.pi?.extensions) ? pkg.pi.extensions : [];

test("every shipped extension registers commands with a string name, never an object (bd-53da92 guard)", () => {
  assert.ok(extensions.length > 0, "package.json must list extensions to guard");
  for (const rel of extensions) {
    const src = readFileSync(path.join(root, rel), "utf8");
    for (const ch of registerCommandFirstArgChars(src)) {
      assert.notEqual(
        ch,
        "{",
        `${rel}: registerCommand called with an object literal as the first arg. ` +
          `The API is registerCommand(name, def); a {…} name crashes ALL slash commands (bd-53da92).`,
      );
      assert.ok(
        isStringOrIdentStart(ch),
        `${rel}: registerCommand first arg should be a string or identifier name, got leading '${ch}'`,
      );
    }
  }
});

test("guard actually covered the known command-registering extensions", () => {
  // Sanity: if these stop matching, the detector regex has drifted and the guard
  // above would silently pass by scanning nothing.
  const rt = readFileSync(path.join(root, "extensions/realtime-agent.js"), "utf8");
  assert.ok(
    registerCommandFirstArgChars(rt).length >= 10,
    "expected realtime-agent.js to register many commands",
  );
  const fas = readFileSync(path.join(root, "extensions/force-agent-speech.js"), "utf8");
  assert.deepEqual(
    registerCommandFirstArgChars(fas),
    ['"'],
    "force-agent-speech must register exactly one string-named command (the bd-53da92 fix)",
  );
});
