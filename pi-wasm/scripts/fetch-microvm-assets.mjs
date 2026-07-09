#!/usr/bin/env node
// pi-wasm S14 (bd-c6ffc3) — fetch the vendored v86 microVM guest assets.
//
// Downloads (into public/microvm/, gitignored) the ~12MB of binaries the v86
// exec backend needs at runtime, so they are NOT committed to the repo:
//   - v86.wasm                  (copied from the installed `v86` npm package)
//   - seabios.bin, vgabios.bin  (v86 firmware, from the v86 repo)
//   - buildroot-bzimage68.bin   (a miniscule Linux guest kernel, from i.copy.sh)
//
// Idempotent: skips a file that already exists with the expected size. Assets
// are pinned by size (+ the bzimage by sha256) for determinism. Run:
//   node scripts/fetch-microvm-assets.mjs
//
// The v86 microVM E2E (e2e/microvm.spec.ts) is opt-in via PIWASM_E2E_MICROVM=1
// and needs these assets present; the bare CI gate skips it.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, copyFile, writeFile, stat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "microvm");

/** @type {{name:string, url?:string, copyFrom?:string, size:number, sha256?:string}[]} */
const ASSETS = [
  {
    name: "v86.wasm",
    // Copied from the installed npm package so the wasm matches the JS API.
    copyFrom: require.resolve("v86/build/v86.wasm"),
    size: 2_084_417,
  },
  {
    name: "seabios.bin",
    url: "https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin",
    size: 131_072,
  },
  {
    name: "vgabios.bin",
    url: "https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin",
    size: 36_352,
  },
  {
    name: "buildroot-bzimage68.bin",
    url: "https://i.copy.sh/buildroot-bzimage68.bin",
    size: 10_068_480,
    sha256: "507a759c70ab7a490a233be454d0b5b88bc667956a410b531cb4edc091e2eb1c",
  },
];

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const a of ASSETS) {
    const dest = join(outDir, a.name);
    if ((await fileSize(dest)) === a.size) {
      console.log(`ok    ${a.name} (cached)`);
      continue;
    }
    if (a.copyFrom) {
      await copyFile(a.copyFrom, dest);
    } else {
      process.stdout.write(`fetch ${a.name} … `);
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`GET ${a.url} -> HTTP ${res.status}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      console.log("done");
    }
    const got = await fileSize(dest);
    if (got !== a.size) throw new Error(`${a.name}: expected ${a.size} bytes, got ${got}`);
    if (a.sha256) {
      const digest = await sha256(dest);
      if (digest !== a.sha256) throw new Error(`${a.name}: sha256 mismatch (${digest})`);
    }
    console.log(`ok    ${a.name} (${got} bytes${a.sha256 ? ", sha256 verified" : ""})`);
  }
  console.log(`\nvendored v86 assets -> ${outDir}`);
}

main().catch((e) => {
  console.error("fetch-microvm-assets failed:", e.message);
  process.exit(1);
});
