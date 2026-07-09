import { defineConfig } from "vite";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// S1 spike: start with NO node polyfills on purpose. Per the S1 derisk
// (scratch note pi-wasm:sdk-node-surface-findings), the `.` entries of
// @earendil-works/pi-agent-core and @earendil-works/pi-ai are import-time
// browser-clean; only the pi-coding-agent barrel and the `/node` subpath pull
// node:fs/child_process. If this bundle builds without polyfills, that is the
// strongest possible feasibility signal. Any polyfill/alias added later must be
// documented in FEASIBILITY.md with the exact transitive import that forced it.

// The S14 microVM demo (microvm-demo.html → src/microvm-demo.ts →
// src/exec/v86-machine.ts) is the ONLY entry that imports the optional `v86`
// module. Its ~12MB assets are gitignored and fetched opt-in via
// scripts/fetch-microvm-assets.mjs. Only include it in the build when `v86` is
// actually installed, so the DEFAULT build (and the S9 nix build, the S8
// Playwright harness, and fresh checkouts/CI) don't fail on an unresolved "v86"
// import. When the opt-in assets are fetched it builds exactly as before. The
// main app path (exec/registry/microvm-backend) never statically imports
// v86-machine, so excluding the demo page is sufficient. (bd-c9f4d5)
const v86Available = existsSync(fileURLToPath(new URL("./node_modules/v86", import.meta.url)));

const input: Record<string, string> = {
  //   index.html          — S7 chat app shell (primary; wires S2/S3/S4/S6)
  //   shell.html          — S12 slick native-feeling agent GUI (additive)
  //   provider-demo.html  — S3 standalone provider demo (preserved)
  //   settings-demo.html  — S6 standalone settings demo (preserved)
  main: "index.html",
  shell: "shell.html",
  "provider-demo": "provider-demo.html",
  settings: "settings-demo.html",
  //   microvm-demo.html   — S14 v86 microVM demo; only when `v86` is installed
  ...(v86Available ? { "microvm-demo": "microvm-demo.html" } : {}),
};

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input,
      // Fail loudly if a node: builtin is pulled in, rather than silently
      // externalizing it (which would defer the failure to runtime in-browser).
      onwarn(warning, warn) {
        warn(warning);
      },
    },
  },
});
