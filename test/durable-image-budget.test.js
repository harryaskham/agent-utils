import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { extension } from "../extensions/durable/image-budget.mjs";

test("the image budget module changes no request: it has no hooks, tools or commands (bd-e7946b)", async () => {
  assert.equal(extension.name, "agent-utils-image-budget");
  // A hook is the only way a module changes a request (beforeRequest); none is left to leave an image out.
  assert.deepEqual(extension.hooks, []);
  assert.deepEqual(Object.keys(extension).sort(), ["hooks", "name"]);
  const module = await import("../extensions/durable/image-budget.mjs");
  assert.deepEqual(Object.keys(module), ["extension"], "no observer, command or tool beside it");
});

test("nothing reads an image limit from the environment or imports the old budget", () => {
  const source = readFileSync(new URL("../extensions/durable/image-budget.mjs", import.meta.url), "utf8");
  const code = source.split("\n").filter((line) => !line.startsWith("//")).join("\n");
  assert.doesNotMatch(code, /import|process\.env|PI_IMAGE_BUDGET/);
  assert.equal(existsSync(new URL("../extensions/lib/image-budget.js", import.meta.url)), false);
});
