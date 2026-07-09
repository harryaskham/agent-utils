import { defineConfig, devices } from "@playwright/test";

// pi-wasm S8 (bd-759769) — Playwright browser-automation harness.
//
// Foundation increment (S7-independent): drives the already-landed S3 provider
// page as a real headless-browser E2E. The full prompt->reason->tool->reply loop
// assertion lands once S7 (the chat UI, bd-e8949f) is in.
//
// Disk-conscious: uses the system Google Chrome (`channel: "chrome"`) so CI/dev
// does NOT download a ~150MB Playwright chromium build. Falls back cleanly if a
// runner prefers bundled chromium by overriding PWTEST_CHANNEL.
//
// Isolated from the vitest suite (test/, `npm test`): Playwright specs live in
// e2e/ and run via `npm run test:e2e`.

const PORT = Number(process.env.PIWASM_E2E_PORT ?? 4319);
const channel = process.env.PWTEST_CHANNEL || "chrome";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel },
    },
  ],
  // Build the browser bundle and serve dist/ before the tests run.
  webServer: {
    command: "npm run build && npm run preview",
    url: `http://localhost:${PORT}`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
