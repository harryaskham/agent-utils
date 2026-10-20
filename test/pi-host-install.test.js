import test from "node:test";
import assert from "node:assert/strict";

import { chooseHostVersion, findPiBinary, runningPiVersion, HOST_PACKAGES } from "../scripts/pi-host-install.mjs";

const offer = (...versions) => Object.fromEntries(HOST_PACKAGES.map((name) => [name, versions]));

test("host install matches the running Pi when the registry has it", () => {
  assert.deepEqual(chooseHostVersion("1.3.0", offer("1.2.0", "1.3.0")), { version: "1.3.0", reason: "matches running Pi" });
});

test("a lagging mirror falls back to the newest same-major release that is not newer", () => {
  const choice = chooseHostVersion("1.3.0", offer("0.84.4", "1.1.0", "1.2.0"));
  assert.equal(choice.version, "1.2.0");
  assert.equal(choice.fallback, true);
  assert.match(choice.reason, /registry lacks 1\.3\.0/);
});

test("only releases every host package offers are eligible; prereleases are ignored", () => {
  const available = offer("1.2.0", "1.3.0");
  available["@earendil-works/pi-tui"] = ["1.2.0", "1.3.0-beta.1"];
  assert.equal(chooseHostVersion("1.3.0", available).version, "1.2.0");
  assert.equal(chooseHostVersion("1.3.0", offer()).version, null);
});

test("without a running Pi the latest common release is used", () => {
  assert.deepEqual(chooseHostVersion(null, offer("1.10.0", "1.9.0", "1.2.0")), { version: "1.10.0", reason: "latest" });
});

test("the running Pi version comes from PI_HOST_VERSION or pi --version", () => {
  assert.equal(runningPiVersion({ env: { PI_HOST_VERSION: "1.3.0" } }), "1.3.0");
  const env = { PATH: "/bin" };
  assert.equal(runningPiVersion({ env, exists: () => true, exec: () => "pi 1.3.0\n" }), "1.3.0");
  assert.equal(runningPiVersion({ env, exists: () => true, exec: () => { throw new Error("missing"); } }), null);
  assert.equal(runningPiVersion({ env, exists: () => false, exec: () => "1.0.0" }), null);
});

test("npm's node_modules/.bin pi is never mistaken for the operator's Pi", () => {
  const path = ["/repo/node_modules/.bin", "/repo/node_modules/pkg/node_modules/.bin", "/home/me/.nix-profile/bin"].join(":");
  assert.equal(findPiBinary({ env: { PATH: path }, exists: () => true }), "/home/me/.nix-profile/bin/pi");
  assert.equal(findPiBinary({ env: { PATH: path, PI_BIN: "/opt/pi" }, exists: () => true }), "/opt/pi");
});
