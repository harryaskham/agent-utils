import { defineConfig } from "vite";

// S1 spike: start with NO node polyfills on purpose. Per the S1 derisk
// (scratch note pi-wasm:sdk-node-surface-findings), the `.` entries of
// @earendil-works/pi-agent-core and @earendil-works/pi-ai are import-time
// browser-clean; only the pi-coding-agent barrel and the `/node` subpath pull
// node:fs/child_process. If this bundle builds without polyfills, that is the
// strongest possible feasibility signal. Any polyfill/alias added later must be
// documented in FEASIBILITY.md with the exact transitive import that forced it.
export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      // Multi-page build:
      //   index.html          — S7 chat app shell (primary; wires S2/S3/S4/S6)
      //   shell.html          — S12 slick native-feeling agent GUI (additive)
      //   provider-demo.html  — S3 standalone provider demo (preserved)
      //   settings-demo.html  — S6 standalone settings demo (preserved)
      input: {
        main: "index.html",
        shell: "shell.html",
        "provider-demo": "provider-demo.html",
        settings: "settings-demo.html",
      },
      // Fail loudly if a node: builtin is pulled in, rather than silently
      // externalizing it (which would defer the failure to runtime in-browser).
      onwarn(warning, warn) {
        warn(warning);
      },
    },
  },
});
