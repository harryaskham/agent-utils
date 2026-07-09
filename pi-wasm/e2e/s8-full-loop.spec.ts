import { test, expect } from "@playwright/test";
import {
  resolveKey,
  DEFAULT_MODEL,
  gotoReady,
  seedLiveSettings,
  sendPrompt,
  runToolLoopScenario,
  expectAssistantReply,
  type PiWasmGlobals,
} from "./harness";

// pi-wasm S8 (bd-759769) — full in-browser agent-loop harness, now consuming the
// shared S8b seam (e2e/harness.ts, bd-caa275) so downstream exec-backend specs
// (S14 microVM, S15 remote) reuse the same primitives.
//
// Tier 1 (ALWAYS runs, no key): app boots, S4 tools run read→edit→write over the
//   VFS (bash blocked), mock loop replies. Deterministic + CI-safe.
// Tier 2 (KEY-gated): a real streaming completion AND a real prompt→reason→tool→
//   reply cycle whose written file is asserted present in the VFS.

const KEY = resolveKey();

test.describe("S8: full in-browser agent loop", () => {
  test("Tier 1 (no key): boots, S4 tools run against the VFS, mock loop replies", async ({ page }) => {
    await gotoReady(page);

    const ready = await page.evaluate(() => (window as unknown as PiWasmGlobals).__PI_WASM__?.ready);
    expect(ready, "chat harness should be ready").toBe(true);

    // S4 acceptance: read→edit→write over the VFS, bash blocked (deterministic).
    const smoke = await page.evaluate(() =>
      (window as unknown as PiWasmGlobals).__PI_WASM__!.runToolsSmoke(),
    );
    expect(smoke.ok, `runToolsSmoke error: ${smoke.error ?? "none"}`).toBe(true);
    expect(smoke.steps.length, "smoke should record read/edit/write steps").toBeGreaterThanOrEqual(3);

    // The chat loop (mock fallback, no key) produces a streamed assistant reply.
    await sendPrompt(page, "Say hello in exactly three words.");
    await expectAssistantReply(page);
  });

  test("Tier 2a (key-gated): a real streaming completion runs live", async ({ page }) => {
    test.skip(!KEY, "no PIWASM_E2E_KEY / OPENAI_API_KEY — skipping live streaming");
    test.setTimeout(90_000);

    const prompt = "Say hello in exactly three words.";
    await seedLiveSettings(page, { key: KEY }, `?autorun=1&prompt=${encodeURIComponent(prompt)}`);

    await page.waitForFunction(
      () => (window as unknown as PiWasmGlobals).__PI_WASM_S3__ !== undefined,
      undefined,
      { timeout: 60_000 },
    );
    const result = await page.evaluate(() => (window as unknown as PiWasmGlobals).__PI_WASM_S3__);

    expect(result?.ok, `expected live stream ok; error=${result?.error ?? "none"}`).toBe(true);
    expect((result?.text ?? "").trim().length).toBeGreaterThan(0);
    expect(result?.model).toBe(DEFAULT_MODEL);
    await expect(page).toHaveTitle(/pi-wasm S7:ok/);
  });

  test("Tier 2b (key-gated): full loop — model calls the write tool, file lands in the VFS", async ({ page }) => {
    test.skip(!KEY, "no PIWASM_E2E_KEY / OPENAI_API_KEY — skipping live tool-call loop");
    test.setTimeout(120_000);

    const target = "/work/s8-live.txt";
    const marker = "PIWASM-LIVE-OK";
    const prompt =
      `Use the write tool to create a file at ${target} whose exact content is a single line: ${marker}\n` +
      `Do not add anything else to the file. After writing it, reply with the word DONE.`;

    // The pluggable full-loop scenario from the S8b seam: seed live settings →
    // scripted prompt → assert the tool wrote the file → assert a streamed reply.
    await runToolLoopScenario(page, {
      key: KEY,
      prompt,
      assertFile: { path: target, contains: marker },
    });
  });
});
