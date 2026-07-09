import { test, expect } from "@playwright/test";
import {
  gotoReady,
  waitReady,
  currentSessionId,
  setSessionBackend,
  execInSession,
  sessionToolNames,
} from "./harness";

// pi-wasm S8d (bd-4dc11d) — durable coverage for S11.1 per-session exec-backend
// selection (bd-36c379, aurora): __PI_WASM_SESSIONS__.setBackend(id, backendId).
// No key / mock loop; js-shell is dep-free (pure JS over the VFS), so this runs
// in the bare gate. Exercises the surface only — no S11.1/S13 source touched.
// Built on the S8b harness seam (e2e/harness.ts).

test.describe("S8d: per-session exec-backend persistence (S11.1)", () => {
  test("setBackend(js-shell) → bash + exec work; reload persists; none → shell_unavailable", async ({ page }) => {
    await gotoReady(page);
    const id = await currentSessionId(page);

    // Select the JS-shell backend on the active session.
    const set = await setSessionBackend(page, id, "js-shell");
    expect(set.backendId, "setBackend should report js-shell active").toBe("js-shell");

    // The session gains a `bash` tool AND exec runs over the VFS.
    expect(await sessionToolNames(page), "bash tool present under js-shell").toContain("bash");
    const echo1 = await execInSession(page, "echo hi");
    expect(echo1.ok, `exec should succeed under js-shell; error=${JSON.stringify(echo1.error)}`).toBe(true);
    expect(echo1.value?.stdout ?? "").toContain("hi");

    // ---- Reload: the session's backendId is persisted; js-shell + bash survive. ----
    await page.reload();
    await waitReady(page);

    expect(await sessionToolNames(page), "bash persists across reload").toContain("bash");
    const echo2 = await execInSession(page, "echo hi");
    expect(echo2.ok, "exec still works after reload (backend persisted)").toBe(true);
    expect(echo2.value?.stdout ?? "").toContain("hi");

    // ---- Switch back to "none": bash removed, exec reports shell_unavailable. ----
    const idAfterReload = await currentSessionId(page);
    await setSessionBackend(page, idAfterReload, "none");
    expect(await sessionToolNames(page), "bash removed under none").not.toContain("bash");
    const echo3 = await execInSession(page, "echo hi");
    expect(echo3.ok, "exec should fail (shell_unavailable) under none").toBe(false);
  });
});
