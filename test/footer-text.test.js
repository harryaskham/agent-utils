// Direct behavioral unit tests for the footer-text.js pure formatters
// (bd-a61626). Before this, these helpers were only "tested" via source-pattern
// assert.match greps in pi-graphics.test.js, so their actual behavior was
// unverified. Regression net; no source changes. HOME is overridden/restored
// for the prettyFooterCwd cases.

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  formatFooterTokens,
  formatFooterPct,
  compactPathSegment,
  compactFooterPath,
  prettyFooterCwd,
  compactFooterProvider,
  compactFooterModelName,
  noEllipsisFooterText,
} from "../extensions/pi-graphics/footer-text.js";

test("formatFooterTokens scales to k/m with a stripped .0", () => {
  assert.equal(formatFooterTokens(0), "0");
  assert.equal(formatFooterTokens(500), "500");
  assert.equal(formatFooterTokens(999), "999");
  assert.equal(formatFooterTokens(1000), "1k");
  assert.equal(formatFooterTokens(1500), "1.5k");
  assert.equal(formatFooterTokens(10000), "10k");
  assert.equal(formatFooterTokens(999999), "1000k"); // < 1e6 stays in the k band
  assert.equal(formatFooterTokens(1000000), "1m");
  assert.equal(formatFooterTokens(1500000), "1.5m");
  assert.equal(formatFooterTokens(12000000), "12m");
  assert.equal(formatFooterTokens("not a number"), "0");
});

test("formatFooterPct strips a trailing .0 and rounds to one decimal", () => {
  assert.equal(formatFooterPct(0), "0%");
  assert.equal(formatFooterPct(100), "100%");
  assert.equal(formatFooterPct(12), "12%");
  assert.equal(formatFooterPct(12.34), "12.3%");
  assert.equal(formatFooterPct(0.05), "0.1%");
  assert.equal(formatFooterPct("bad"), "0%");
});

test("compactPathSegment keeps the first non-dot character", () => {
  assert.equal(compactPathSegment(".config"), "c");
  assert.equal(compactPathSegment(".gitignore"), "g");
  assert.equal(compactPathSegment("abc"), "a");
  assert.equal(compactPathSegment("...x"), "x");
  assert.equal(compactPathSegment(".."), "."); // all dots -> first raw char
  assert.equal(compactPathSegment(""), "");
});

test("compactFooterPath compacts intermediate segments past the threshold", () => {
  assert.equal(compactFooterPath("/home/harry/project/src", 5), "/h/h/p/src");
  assert.equal(compactFooterPath("ab", 5), "ab"); // within threshold -> unchanged
  // Single-char segments are already minimal.
  assert.equal(compactFooterPath("~/a/b/c", 3), "~/a/b/c");
});

test("compactFooterProvider abbreviates known providers and passes through unknowns", () => {
  assert.equal(compactFooterProvider("github-copilot"), "ghcp");
  assert.equal(compactFooterProvider("openai"), "oai");
  assert.equal(compactFooterProvider("anthropic"), "ant");
  assert.equal(compactFooterProvider("litellm-openai"), "loai");
  assert.equal(compactFooterProvider("litellm-anthropic"), "lant");
  assert.equal(compactFooterProvider("openrouter"), "oprt");
  assert.equal(compactFooterProvider("azure-eastus"), "az");
  assert.equal(compactFooterProvider("somethingelse"), "somethingelse");
  assert.equal(compactFooterProvider(""), "");
});

test("compactFooterModelName strips family prefixes with the GitHub Copilot gpt-5 exception", () => {
  assert.equal(compactFooterModelName("gpt-4o", "openai"), "4o"); // gpt- stripped
  assert.equal(compactFooterModelName("gpt-4o-mini", "openai"), "4o-mini");
  assert.equal(compactFooterModelName("gpt-5", "github-copilot"), "gpt-5"); // ghcp gpt-5* keeps prefix
  assert.equal(compactFooterModelName("gpt-5.1", "github-copilot"), "gpt-5.1");
  assert.equal(compactFooterModelName("gpt-4o", "github-copilot"), "4o"); // non-5 ghcp still stripped
  assert.equal(compactFooterModelName("claude-sonnet-4-5", "anthropic"), "sonnet-4-5");
  assert.equal(compactFooterModelName("claude-opus-4-7", "anthropic"), "opus-4.7"); // special dot fixup
  assert.equal(compactFooterModelName("sonnet-4-5-1m-internal", "anthropic"), "sonnet-4-5"); // suffix stripped
});

test("noEllipsisFooterText returns the text unchanged (no-op truncate sentinel)", () => {
  assert.equal(noEllipsisFooterText("hello", 3), "hello");
  assert.equal(noEllipsisFooterText("", 0), "");
  assert.equal(noEllipsisFooterText(null, 5), "");
});

const HOME_SENTINEL = "/home/footer-text-sentinel";
let savedHome;
beforeEach(() => {
  savedHome = process.env.HOME;
  process.env.HOME = HOME_SENTINEL;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

test("prettyFooterCwd renders ~ for HOME and compacts paths", () => {
  assert.equal(prettyFooterCwd(HOME_SENTINEL), "~");
  assert.equal(prettyFooterCwd(`${HOME_SENTINEL}/projects/foo`), "~/p/foo");
  assert.equal(prettyFooterCwd("/var/log/syslog"), "/v/l/syslog");
});
