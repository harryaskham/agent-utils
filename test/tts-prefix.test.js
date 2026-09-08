import test from "node:test";
import assert from "node:assert/strict";

import { fallbackSessionLabel, githubRepoName, speechPrefix } from "../extensions/lib/tts-prefix.js";

function gitStub({ remote = "", root = "" } = {}) {
  return (_command, args) => args.includes("get-url")
    ? { status: remote ? 0 : 1, stdout: remote }
    : { status: root ? 0 : 1, stdout: root };
}

test("GitHub repository identity uses the repository root name", () => {
  const spawnImpl = gitStub({ remote: "git@github.com:owner/project.git\n", root: "/work/project\n" });
  assert.equal(githubRepoName("/work/project/subdir", spawnImpl), "project");
  assert.equal(fallbackSessionLabel("/work/project/subdir", { home: "/home/me", spawnImpl }), "project");
});

test("non-GitHub directories use dirname and the exact home directory becomes home", () => {
  const spawnImpl = gitStub({ remote: "git@gitlab.com:owner/project.git\n", root: "/work/project\n" });
  assert.equal(fallbackSessionLabel("/work/project/subdir", { home: "/home/me", spawnImpl }), "subdir");
  assert.equal(fallbackSessionLabel("/Users/harryaskham", { home: "/Users/harryaskham", spawnImpl }), "home");
});

test("prefixWithSessionName concatenates live session/fallback identity with configured punctuation", () => {
  assert.equal(speechPrefix({ enabled: false, configuredPrefix: ": ", sessionName: "named" }), ": ");
  assert.equal(speechPrefix({ enabled: true, configuredPrefix: ": ", sessionName: "my session" }), "my session: ");
  assert.equal(speechPrefix({ enabled: true, configuredPrefix: ": ", cwd: "/work/repo", home: "/home/me", spawnImpl: gitStub() }), "repo: ");
});
