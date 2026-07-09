import { test, expect } from "@playwright/test";

// pi-wasm S8 (bd-759769) — full in-browser agent-loop browser-automation harness.
//
// Proves, with NO human input, that the whole loop runs client-side against the
// S7 chat app (bd-e8949f) which composes S6 settings + S3 streaming + S4 file
// tools over the S2 VFS. Builds on the S8a harness foundation (bd-8a973e).
//
// Two tiers (per the seam authors msm-0/aurora/ms2-2):
//   Tier 1 (ALWAYS runs, no key): the app boots, the S4 file tools execute
//     against the VFS (read→edit→write, bash blocked), and the mock loop
//     produces a streamed assistant reply. Deterministic + CI-safe.
//   Tier 2 (KEY-gated): with a real key injected via the S6 settings store, a
//     real streaming completion runs AND a real prompt→reason→tool→reply cycle
//     writes a file the prompt asked for — asserted present in the VFS.
//
// Key handling: PIWASM_E2E_KEY / OPENAI_API_KEY, injected into the S6 settings
// store (IndexedDB), never committed. Tier 2 is test.skip'd without a key so the
// bare gate passes.
//
// The `#app[data-pi-wasm-ready="true"]` hook + waitForFunction (NOT --dump-dom,
// which fires before async ESM settles) are the right sync points (ms2-2 verified).

const KEY = process.env.PIWASM_E2E_KEY || process.env.OPENAI_API_KEY || "";
const MODEL = process.env.PIWASM_E2E_MODEL || "gpt-4.1";
const BASE_URL = process.env.PIWASM_E2E_BASE_URL || "http://100.83.90.42:4000/v1";

// A live S6 settings blob (PiWasmSettings shape) that puts the app in live mode.
const liveSettings = () => ({
  providerKeys: { openai: KEY },
  baseUrl: BASE_URL,
  models: [{ id: MODEL, provider: "openai" }],
  selectedModelId: MODEL,
  settings: {},
});

// Boot the app, persist live settings into the S6 store (IndexedDB), then reload
// so the fresh boot reads them and constructs a LIVE session. Avoids the
// addInitScript/IndexedDB open race by seeding after first ready + reloading.
async function seedLiveSettingsAndReload(page: import("@playwright/test").Page, query = "") {
  await page.goto("/");
  await page.waitForSelector('#app[data-pi-wasm-ready="true"]');
  await page.evaluate(
    (s) => (window as unknown as { __PI_WASM_SETTINGS__: { store: { save(v: unknown): Promise<void> } } })
      .__PI_WASM_SETTINGS__.store.save(s),
    liveSettings(),
  );
  await page.goto(`/${query}`);
  await page.waitForSelector('#app[data-pi-wasm-ready="true"]');
}

test.describe("S8: full in-browser agent loop", () => {
  test("Tier 1 (no key): boots, S4 tools run against the VFS, mock loop replies", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('#app[data-pi-wasm-ready="true"]');

    const ready = await page.evaluate(
      () => (window as unknown as { __PI_WASM__?: { ready?: boolean } }).__PI_WASM__?.ready,
    );
    expect(ready, "chat harness should be ready").toBe(true);

    // S4 acceptance: read→edit→write over the VFS, bash blocked (deterministic).
    const smoke = (await page.evaluate(() =>
      (window as unknown as { __PI_WASM__: { runToolsSmoke(): Promise<{ ok: boolean; steps: string[]; error?: string }> } })
        .__PI_WASM__.runToolsSmoke(),
    )) as { ok: boolean; steps: string[]; error?: string };
    expect(smoke.ok, `runToolsSmoke error: ${smoke.error ?? "none"}`).toBe(true);
    expect(smoke.steps.length, "smoke should record read/edit/write steps").toBeGreaterThanOrEqual(3);

    // The chat loop (mock fallback, no key) produces a streamed assistant reply.
    await page.evaluate(() =>
      (window as unknown as { __PI_WASM__: { send(t: string): Promise<void> } }).__PI_WASM__.send(
        "Say hello in exactly three words.",
      ),
    );
    const transcript = (await page.evaluate(() =>
      (window as unknown as { __PI_WASM__: { getTranscript(): { role: string; text: string }[] } })
        .__PI_WASM__.getTranscript(),
    )) as { role: string; text: string }[];
    const assistantReply = transcript.find((m) => m.role === "assistant" && m.text.trim().length > 0);
    expect(assistantReply, "chat should produce a non-empty assistant reply").toBeTruthy();
  });

  test("Tier 2a (key-gated): a real streaming completion runs live", async ({ page }) => {
    test.skip(!KEY, "no PIWASM_E2E_KEY / OPENAI_API_KEY — skipping live streaming");
    test.setTimeout(90_000);

    const prompt = "Say hello in exactly three words.";
    await seedLiveSettingsAndReload(page, `?autorun=1&prompt=${encodeURIComponent(prompt)}`);

    await page.waitForFunction(
      () => (window as unknown as { __PI_WASM_S3__?: unknown }).__PI_WASM_S3__ !== undefined,
      undefined,
      { timeout: 60_000 },
    );
    const result = (await page.evaluate(
      () => (window as unknown as { __PI_WASM_S3__?: { ok: boolean; text?: string; model?: string; error?: string } })
        .__PI_WASM_S3__,
    )) as { ok: boolean; text?: string; model?: string; error?: string };

    expect(result?.ok, `expected live stream ok; error=${result?.error ?? "none"}`).toBe(true);
    expect((result.text ?? "").trim().length).toBeGreaterThan(0);
    expect(result.model).toBe(MODEL);
    await expect(page).toHaveTitle(/pi-wasm S7:ok/);
  });

  test("Tier 2b (key-gated): full loop — model calls the write tool, file lands in the VFS", async ({ page }) => {
    test.skip(!KEY, "no PIWASM_E2E_KEY / OPENAI_API_KEY — skipping live tool-call loop");
    test.setTimeout(120_000);

    await seedLiveSettingsAndReload(page);

    const target = "/work/s8-live.txt";
    const marker = "PIWASM-LIVE-OK";
    // Explicit, imperative prompt so a tool-capable model reliably calls `write`.
    const prompt =
      `Use the write tool to create a file at ${target} whose exact content is a single line: ${marker}\n` +
      `Do not add anything else to the file. After writing it, reply with the word DONE.`;

    // send() resolves after the full turn (agent.waitForIdle), so any tool call
    // has executed by the time it returns.
    await page.evaluate(
      (p) => (window as unknown as { __PI_WASM__: { send(t: string): Promise<void> } }).__PI_WASM__.send(p),
      prompt,
    );

    // The model-driven tool call must have written the file into the VFS.
    const read = (await page.evaluate(
      (path) =>
        (window as unknown as {
          __PI_WASM__: { env: { readTextFile(p: string): Promise<{ ok: boolean; value?: string; error?: unknown }> } };
        }).__PI_WASM__.env.readTextFile(path),
      target,
    )) as { ok: boolean; value?: string; error?: unknown };

    expect(read.ok, `expected ${target} to exist in the VFS after the tool call`).toBe(true);
    expect(read.value ?? "").toContain(marker);

    // And a streamed assistant reply was produced in the same turn.
    const transcript = (await page.evaluate(() =>
      (window as unknown as { __PI_WASM__: { getTranscript(): { role: string; text: string }[] } })
        .__PI_WASM__.getTranscript(),
    )) as { role: string; text: string }[];
    expect(transcript.some((m) => m.role === "assistant" && m.text.trim().length > 0)).toBe(true);
  });
});
