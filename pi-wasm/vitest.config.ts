import { defineConfig } from "vitest/config";

// pi-wasm S2 tests. Runs in the node environment with fake-indexeddb providing a
// headless IndexedDB so the lightning-fs backend is exercised without a browser.
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
