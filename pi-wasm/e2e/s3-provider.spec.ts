import { test, expect } from "@playwright/test";
import { resolveKey, DEFAULT_MODEL } from "./harness";

// pi-wasm S8 (bd-759769) — real-browser E2E of the landed S3 provider layer
// (bd-cbf86f). Proves, with NO human input, that a real streaming model call
// runs end-to-end in a browser against the CORS LiteLLM endpoint and renders
// streamed text. This is the S7-independent foundation of the S8 harness; the
// full prompt->tool->reply loop assertion is added once S7 (bd-e8949f) lands.
//
// Key handling: supplied via env (PIWASM_E2E_KEY, else OPENAI_API_KEY) and
// injected as `window.__PI_WASM_KEY__` BEFORE page scripts run, so it never
// appears in the URL, the DOM, or a trace. CI-gated: the test skips when no key
// is present, so the bare test gate still passes without a secret.

type S3Result = {
  ok: boolean;
  text?: string;
  model?: string;
  baseUrl?: string;
  chunks?: number;
  error?: string;
};

const KEY = resolveKey();
const MODEL = DEFAULT_MODEL;
// Optional base-URL override; defaults to the page's built-in LiteLLM proxy.
const BASE_URL = process.env.PIWASM_E2E_BASE_URL || "";

test.describe("S3 provider layer — real streaming call in-browser", () => {
  test.skip(!KEY, "no PIWASM_E2E_KEY / OPENAI_API_KEY in env — skipping live provider E2E");

  test("autorun streams a real completion and reports ok", async ({ page }) => {
    // Inject the runtime key before any page script executes (never in URL/DOM).
    await page.addInitScript((key) => {
      (window as unknown as { __PI_WASM_KEY__?: string }).__PI_WASM_KEY__ = key;
    }, KEY);

    const prompt = "Say hello in exactly three words.";
    const params = new URLSearchParams({ autorun: "1", model: MODEL, prompt });
    if (BASE_URL) params.set("baseUrl", BASE_URL);
    // The S3 provider demo lives at /provider-demo.html (the primary page `/` is
    // the S7 chat app since bd-e8949f). This test targets the standalone S3 demo.
    await page.goto(`/provider-demo.html?${params.toString()}`);

    // Wait for the page's autorun to publish its result global.
    await page.waitForFunction(
      () => (window as unknown as { __PI_WASM_S3__?: unknown }).__PI_WASM_S3__ !== undefined,
      undefined,
      { timeout: 45_000 },
    );

    const result = (await page.evaluate(
      () => (window as unknown as { __PI_WASM_S3__?: S3Result }).__PI_WASM_S3__,
    )) as S3Result;

    expect(result, "S3 result global should be set").toBeTruthy();
    expect(result.ok, `expected ok; got error=${result.error ?? "none"}`).toBe(true);
    expect((result.text ?? "").trim().length, "streamed text should be non-empty").toBeGreaterThan(0);
    expect(result.chunks ?? 0, "should have received streamed deltas").toBeGreaterThan(0);
    expect(result.model).toBe(MODEL);

    // The streamed text is rendered live into #stream, and the title flips to ok.
    await expect(page).toHaveTitle(/pi-wasm S3:ok/);
    const streamText = (await page.locator("#stream").textContent()) ?? "";
    expect(streamText.trim().length).toBeGreaterThan(0);

    // The key must never leak into the rendered page.
    const bodyText = (await page.locator("body").textContent()) ?? "";
    expect(bodyText).not.toContain(KEY);
  });
});
