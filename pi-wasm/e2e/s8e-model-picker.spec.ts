import { test, expect } from "@playwright/test";
import {
  gotoReady,
  waitReady,
  currentSessionId,
  createSession,
  switchSession,
  setSessionModel,
  sessionModelId,
} from "./harness";

// pi-wasm S8e (capstone of the S11.x harness coverage) — durable coverage for
// S11.2 per-session model picker (bd-8a5ecc, aurora): __PI_WASM_SESSIONS__.setModel(id, modelId?).
// No key / mock loop → bare gate. Exercises the surface only. Built on the S8b seam.
//
// The chat app's mock-mode global-default model is src/provider.ts DEFAULT_MODEL_ID.
const APP_DEFAULT_MODEL = "gpt-4.1";

test.describe("S8e: per-session model picker persistence (S11.2)", () => {
  test("setModel reflects + persists across reload; undefined reverts to default; per-session distinct", async ({
    page,
  }) => {
    await gotoReady(page);
    const id = await currentSessionId(page);

    // Pick a per-session model (id only needs to persist — never called in mock mode).
    await setSessionModel(page, id, "gpt-5-mini");
    expect(await sessionModelId(page), "modelId reflects the choice").toBe("gpt-5-mini");

    // ---- Reload: the session's model persists. ----
    await page.reload();
    await waitReady(page);
    expect(await sessionModelId(page), "model persists across reload").toBe("gpt-5-mini");

    // Clearing (undefined) reverts to the global default.
    const idAfter = await currentSessionId(page);
    await setSessionModel(page, idAfter, undefined);
    expect(await sessionModelId(page), "clear reverts to global default").toBe(APP_DEFAULT_MODEL);

    // ---- Distinct per session. ----
    const beta = await createSession(page, "Beta"); // switches to beta (defaults to global model)
    await setSessionModel(page, beta.id, "claude-sonnet-5");
    expect(await sessionModelId(page), "beta model set").toBe("claude-sonnet-5");

    await switchSession(page, idAfter);
    expect(await sessionModelId(page), "session A model isolated from B").toBe(APP_DEFAULT_MODEL);
    await switchSession(page, beta.id);
    expect(await sessionModelId(page), "session B model isolated from A").toBe("claude-sonnet-5");
  });
});
