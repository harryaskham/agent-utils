import { test, expect } from "@playwright/test";

// pi-wasm S14 (bd-c6ffc3) — real in-browser boot of the v86 microVM exec backend.
//
// Proves, with NO human input and NO API key, that a miniscule Linux guest boots
// entirely in the browser (v86 + Buildroot) and runs real shell commands through
// the serial-console exec protocol (frameCommand/parseSerialResult, incl. the
// stdout/stderr separation from inc3) — validating the protocol against REAL v86,
// which the vitest suite can only exercise against a mock machine.
//
// Assets: this depends on the vendored guest binaries under public/microvm/
// (v86.wasm + buildroot-bzimage68.bin + SeaBIOS/VGA BIOS), fetched by
// `node scripts/fetch-microvm-assets.mjs`. They are gitignored (≈12MB), so the
// test is OPT-IN via PIWASM_E2E_MICROVM=1 and skips cleanly otherwise — the bare
// CI gate (no assets, no env) still passes, mirroring the S3 key-gated E2E.
//
// Run locally:  node scripts/fetch-microvm-assets.mjs && PIWASM_E2E_MICROVM=1 npm run test:e2e

type ExecOut = { ok: boolean; value?: { stdout: string; stderr: string; exitCode: number }; error?: string };

const RUN = process.env.PIWASM_E2E_MICROVM === "1";
const READY = '#microvm-app[data-microvm-ready="true"]';
// v86 boots a real x86 kernel in wasm; without cross-origin isolation it is
// single-threaded and slow, so give boot a generous ceiling.
const BOOT_TIMEOUT_MS = Number(process.env.PIWASM_E2E_MICROVM_BOOT_MS ?? 180_000);

async function execInGuest(
  page: import("@playwright/test").Page,
  command: string,
): Promise<ExecOut> {
  return page.evaluate(
    (cmd) =>
      (window as unknown as { __PI_WASM_MICROVM__: { exec(c: string): Promise<ExecOut> } })
        .__PI_WASM_MICROVM__.exec(cmd),
    command,
  );
}

test.describe("S14 microVM (v86) exec backend — real in-browser boot", () => {
  test.skip(
    !RUN,
    "set PIWASM_E2E_MICROVM=1 (after `node scripts/fetch-microvm-assets.mjs`) to run the v86 boot E2E",
  );

  test("boots v86 and runs shell commands through the serial exec protocol", async ({ page }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 60_000);

    await page.goto("/microvm-demo.html");
    // The page sets data-microvm-ready only after the guest shell answers a probe.
    await page.waitForSelector(READY, { timeout: BOOT_TIMEOUT_MS });

    // 1) stdout + exit code round-trip through the real guest.
    const echo = await execInGuest(page, "echo hello-from-guest");
    expect(echo.ok, `exec error: ${echo.error ?? "none"}`).toBe(true);
    expect(echo.value?.stdout ?? "").toContain("hello-from-guest");
    expect(echo.value?.exitCode).toBe(0);

    // 2) stderr is captured SEPARATELY from stdout (inc3), with a non-zero code.
    const errcase = await execInGuest(page, "ls /no/such/path");
    expect(errcase.ok, `exec error: ${errcase.error ?? "none"}`).toBe(true);
    expect(errcase.value?.exitCode).not.toBe(0);
    expect((errcase.value?.stderr ?? "").length, "stderr should be non-empty").toBeGreaterThan(0);
    expect(errcase.value?.stdout ?? "", "stdout should stay clean of the stderr text").not.toContain(
      "No such file",
    );

    // 3) it is a real Linux guest.
    const uname = await execInGuest(page, "uname -s");
    expect(uname.value?.stdout ?? "").toContain("Linux");
  });
});
