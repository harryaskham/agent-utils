// pi-wasm S14 (bd-c6ffc3) — standalone microVM (v86) demo page + Playwright hook.
//
// Boots the real v86-backed MicrovmExecBackend entirely in the browser and
// exposes a small test API on `window.__PI_WASM_MICROVM__` so the S8 Playwright
// harness can drive a scenario against it:
//
//   await gotoReady(page, '/microvm-demo.html', '#microvm-app[data-microvm-ready="true"]');
//   const r = await page.evaluate(() => window.__PI_WASM_MICROVM__.exec("echo hi"));
//
// This page needs NO API key (pure exec), so it runs in the bare gate. It DOES
// need the vendored guest assets under public/microvm/ (see
// scripts/fetch-microvm-assets.mjs); without them the boot fails and the page
// sets data-microvm-error instead of data-microvm-ready.
//
// Increment 4a: proves boot + serial exec (echo/stderr/exit code) against real
// v86. The shared LightningFsVfs + seedWorkFile/env are wired now so 4b (the
// handle9p bridge mounting /work) can assert the guest sees a tool-written file.

import { LightningFsVfs } from "./vfs/vfs";
import { createMicrovmExecBackend } from "./exec/microvm-backend";
import { V86Machine } from "./exec/v86-machine";
import type { ExecResult } from "./exec/exec-backend";

type ExecOut = { ok: true; value: ExecResult } | { ok: false; error: string };

interface MicrovmTestApi {
  ready: boolean;
  exec(command: string, options?: { cwd?: string; timeout?: number }): Promise<ExecOut>;
  seedWorkFile(path: string, content: string): Promise<void>;
  env: { readTextFile(path: string): Promise<{ ok: boolean; value?: string; error?: string }> };
}

async function main(): Promise<void> {
  const app = document.getElementById("microvm-app")!;
  const statusEl = document.getElementById("status")!;
  const outEl = document.getElementById("out")!;
  const log = (m: string): void => {
    outEl.textContent += m + "\n";
  };

  // A single shared VFS: file-operating backends (and, in 4b, the 9p bridge)
  // read/write the SAME LightningFsVfs the S4 tools use.
  const vfs = new LightningFsVfs("pi-wasm-microvm");
  const machine = new V86Machine({ bootTimeoutMs: 120_000 });
  const backend = createMicrovmExecBackend({ machine, bootTimeoutMs: 120_000 });

  const api: MicrovmTestApi = {
    ready: false,
    async exec(command, options = {}) {
      const r = await backend.exec(command, { cwd: options.cwd ?? "/", timeout: options.timeout ?? 20 });
      return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error.message };
    },
    async seedWorkFile(path, content) {
      const slash = path.lastIndexOf("/");
      const dir = slash > 0 ? path.slice(0, slash) : "/";
      try {
        await vfs.mkdir(dir);
      } catch {
        /* dir may already exist */
      }
      await vfs.writeFile(path, content);
    },
    env: {
      async readTextFile(path) {
        try {
          return { ok: true, value: await vfs.readFileText(path) };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    },
  };
  (window as unknown as { __PI_WASM_MICROVM__: MicrovmTestApi }).__PI_WASM_MICROVM__ = api;

  try {
    statusEl.textContent = "booting v86 guest (this can take ~30–60s in wasm)…";
    // A trivial exec triggers the lazy boot and confirms the serial shell +
    // exec protocol end-to-end against real v86.
    const probe = await api.exec("true", { timeout: 120 });
    if (!probe.ok) throw new Error(probe.error);
    api.ready = true;
    statusEl.textContent = `v86 ready (probe exit ${probe.value.exitCode})`;
    app.setAttribute("data-microvm-ready", "true");
    log("guest shell ready — try window.__PI_WASM_MICROVM__.exec('uname -a')");
  } catch (e) {
    statusEl.textContent = "v86 boot failed: " + String(e);
    app.setAttribute("data-microvm-error", "true");
    log("boot error: " + String(e));
  }
}

void main();
