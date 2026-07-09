import { test, expect } from "@playwright/test";
import {
  gotoReady,
  waitReady,
  sendPrompt,
  getTranscript,
  listSessions,
  createSession,
  switchSession,
  removeSession,
} from "./harness";

// pi-wasm S8c (bd-23ab90) — durable browser coverage for S11 keyed multi-session
// management (bd-0dc0bc, aurora). S11 exposes window.__PI_WASM_SESSIONS__ "for
// S8"; this turns aurora's one-off CDP validation into landed CI. No key needed
// (mock loop), so it runs in the bare gate. Exercises the S11 surface only; does
// not touch S11 source. Uses the S8b harness seam (e2e/harness.ts).

const ALPHA = "s8c-alpha-marker";
const BETA = "s8c-beta-marker";

test.describe("S8c: keyed multi-session persistence (S11)", () => {
  test("create → send → reload → sessions + transcripts restore; isolation + delete", async ({ page }) => {
    await gotoReady(page);

    // Two named sessions, each with a distinct mock message. create() switches to
    // the new session, so each send lands in its own session (isolation).
    const alpha = await createSession(page, "Alpha");
    await sendPrompt(page, ALPHA);
    const beta = await createSession(page, "Beta");
    await sendPrompt(page, BETA);
    expect(alpha.id).not.toBe(beta.id);

    // Both present before reload.
    const before = await listSessions(page);
    expect(before.some((s) => s.id === alpha.id), "alpha in list").toBe(true);
    expect(before.some((s) => s.id === beta.id), "beta in list").toBe(true);

    // ---- Reload: everything is persisted in IndexedDB and must survive. ----
    await page.reload();
    await waitReady(page);

    const after = await listSessions(page);
    expect(after.some((s) => s.id === alpha.id), "alpha persisted across reload").toBe(true);
    expect(after.some((s) => s.id === beta.id), "beta persisted across reload").toBe(true);

    // Switching restores each session's OWN transcript (persistence + isolation).
    await switchSession(page, alpha.id);
    const tAlpha = await getTranscript(page);
    expect(tAlpha.some((m) => m.text.includes(ALPHA)), "alpha transcript restored").toBe(true);
    expect(tAlpha.some((m) => m.text.includes(BETA)), "alpha must NOT contain beta's message").toBe(false);

    await switchSession(page, beta.id);
    const tBeta = await getTranscript(page);
    expect(tBeta.some((m) => m.text.includes(BETA)), "beta transcript restored").toBe(true);
    expect(tBeta.some((m) => m.text.includes(ALPHA)), "beta must NOT contain alpha's message").toBe(false);

    // Delete-cleanup: removing a session drops it from the list.
    await switchSession(page, alpha.id); // move off beta before removing it
    await removeSession(page, beta.id);
    const afterDelete = await listSessions(page);
    expect(afterDelete.some((s) => s.id === beta.id), "beta removed from list").toBe(false);
    expect(afterDelete.some((s) => s.id === alpha.id), "alpha still present").toBe(true);
  });
});
