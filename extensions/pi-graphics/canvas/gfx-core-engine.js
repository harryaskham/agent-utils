// renderer=gfx: draw Pi's canvas with gfx-core (the Rust renderer shared
// with gfxsh, compiled to WebAssembly) instead of the TypeScript renderer.
//
// Pi already knows its screen (ANSI rows) and semantics (the provenance
// markers of semantics.js), so no terminal emulation is involved: each frame
// becomes rows of styled runs plus blocks (messages, tool calls, the editor
// as the live input card), and gfx-core returns the Kitty graphics
// escape sequences that bring the terminal up to date (scene-diffed).
//
// The module is self-contained (node builtins only): it provides the few
// system calls gfx-core makes, so it needs neither node:wasi nor a
// filesystem inside WebAssembly; fonts are passed as bytes.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT, unpackRgb } from "./ansi-cells.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Where gfx_wasm.wasm is: the explicit setting, $PI_GFX_WASM, else from the
 * gfxsh on PATH — `share/gfxsh/gfx_wasm.wasm` beside it when installed that
 * way (Nix), otherwise `gfxsh wasm`, which writes the copy embedded in the
 * binary to its cache once per gfxsh build (cargo install, copied binaries).
 * `run` is injectable for tests.
 */
export function findGfxWasm(explicit = "", env = process.env, run = spawnSync) {
  for (const path of [explicit, env.PI_GFX_WASM]) {
    if (path && existsSync(path)) return path;
  }
  for (const dir of String(env.PATH || "").split(":")) {
    const exe = join(dir || ".", "gfxsh");
    if (!existsSync(exe)) continue;
    try {
      const beside = join(dirname(realpathSync(exe)), "..", "share", "gfxsh", "gfx_wasm.wasm");
      if (existsSync(beside)) return beside;
    } catch {}
    try {
      const r = run(exe, ["wasm"], { encoding: "utf8", timeout: 5000, env });
      const path = r.status === 0 ? String(r.stdout || "").trim().split("\n").pop() : "";
      if (path && existsSync(path)) return path;
    } catch {}
    break;
  }
  return "";
}

function fcMatch(pattern) {
  try {
    const r = spawnSync("fc-match", ["-f", "%{file}", pattern], { encoding: "utf8", timeout: 1500 });
    return r.status === 0 ? String(r.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

function systemImports(memory) {
  const view = () => new DataView(memory().buffer);
  const bytes = () => new Uint8Array(memory().buffer);
  const EBADF = 8;
  const ENOSYS = 52;
  let stderr = "";
  const imports = {
    clock_time_get(id, _precision, out) {
      const nanos = id === 0 ? BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)) : process.hrtime.bigint();
      view().setBigUint64(out, nanos, true);
      return 0;
    },
    random_get(ptr, len) { crypto.getRandomValues(bytes().subarray(ptr, ptr + len)); return 0; },
    fd_write(fd, iovs, count, written) {
      let total = 0;
      for (let i = 0; i < count; i += 1) {
        const base = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        if (fd === 2) stderr = (stderr + decoder.decode(bytes().subarray(base, base + len))).slice(-4000);
        total += len;
      }
      view().setUint32(written, total, true);
      return 0;
    },
    environ_sizes_get(c, s) { view().setUint32(c, 0, true); view().setUint32(s, 0, true); return 0; },
    environ_get() { return 0; },
    args_sizes_get(c, s) { view().setUint32(c, 0, true); view().setUint32(s, 0, true); return 0; },
    args_get() { return 0; },
    proc_exit(code) { throw new Error(`gfx-core exited (${code})`); },
    sched_yield() { return 0; },
    fd_close: () => EBADF, fd_fdstat_get: () => EBADF, fd_filestat_get: () => EBADF, fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF, fd_read: () => EBADF, fd_seek: () => EBADF,
    path_open: () => ENOSYS, poll_oneoff: () => ENOSYS,
  };
  return { imports, stderr: () => stderr };
}

/**
 * Load gfx-core and make a renderer for a cols × rows grid of cell × pixels.
 * @returns {Promise<{frame(frame): string, clear(): string, stats(): object, drop(): void}>}
 */
export async function createGfxCoreEngine({ wasmPath, font, cols, rows, cell, gutter = 1, effects = {}, theme = null }) {
  if (!wasmPath) throw new Error("gfx-core (gfx_wasm.wasm) not found: install gfxsh or set gfxWasm / $PI_GFX_WASM");
  let instance = null;
  const system = systemImports(() => instance.exports.memory);
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: system.imports });
  instance.exports._initialize?.();
  const x = instance.exports;
  const put = (data) => {
    const buf = typeof data === "string" ? encoder.encode(data) : data;
    const ptr = x.gfx_alloc(buf.length);
    new Uint8Array(x.memory.buffer, ptr, buf.length).set(buf);
    return [ptr, buf.length];
  };
  const out = (ptr) => decoder.decode(new Uint8Array(x.memory.buffer, ptr, x.gfx_out_len()));
  const guard = (fn) => {
    try { return fn(); } catch (error) {
      const detail = system.stderr().trim().split("\n").slice(-2).join(" ");
      throw new Error(detail ? `${error.message}: ${detail}` : error.message);
    }
  };
  const files = [font, fcMatch("Symbols Nerd Font Mono"), fcMatch("DejaVu Sans Mono")]
    .filter((p, i, all) => p && existsSync(p) && all.indexOf(p) === i)
    .map((p) => readFileSync(p));
  if (!files.length) throw new Error("gfx-core: no font file found");
  const joined = Buffer.concat(files);
  const config = { cols, rows, cell, gutter, effects, fonts: files.map((f) => f.length), ...(theme ? { theme } : {}) };
  const [cfgPtr, cfgLen] = put(JSON.stringify(config));
  const [fontPtr, fontLen] = put(joined);
  const handle = guard(() => x.gfx_new(cfgPtr, cfgLen, fontPtr, fontLen));
  x.gfx_free(cfgPtr, cfgLen);
  x.gfx_free(fontPtr, fontLen);
  if (!handle) throw new Error(`gfx-core: ${out(x.gfx_last())}`);
  return {
    frame(frame) {
      const [ptr, len] = put(JSON.stringify(frame));
      const text = guard(() => out(x.gfx_frame(handle, ptr, len)));
      x.gfx_free(ptr, len);
      if (text.startsWith("ERR ")) throw new Error(`gfx-core: ${text.slice(4)}`);
      return text;
    },
    clear() {
      return x.gfx_clear ? guard(() => out(x.gfx_clear(handle))) : "\x1b_Ga=d,d=A,q=2\x1b\\";
    },
    effects(next) {
      const [ptr, len] = put(JSON.stringify(next));
      const text = guard(() => out(x.gfx_effects(handle, ptr, len)));
      x.gfx_free(ptr, len);
      if (text.startsWith("ERR ")) throw new Error(`gfx-core: ${text.slice(4)}`);
    },
    stats() {
      try { return JSON.parse(out(x.gfx_stats(handle))); } catch { return {}; }
    },
    drop() { x.gfx_drop(handle); },
  };
}

const LABELS = { user: "you", assistant: "", thinking: "thinking", tool: "", bash: "", custom: "", skill: "skill", summary: "summary" };

/**
 * One Pi frame → a gfx-core frame: rows of styled runs, blocks from the
 * semantic markers (each message/tool call a pane; tools get a header and
 * a status), the editor as the live input card.
 * @param parsed rows of cells from parseAnsiLine (with .sem)
 */
export function toGfxFrame(parsed, { cursor = null, editor = null } = {}) {
  const rows = [];
  for (let r = 0; r < parsed.length; r += 1) {
    const cells = parsed[r].cells || [];
    const inEditor = editor && r >= editor.y && r < editor.y + editor.height;
    const runs = [];
    let run = null;
    for (const c of cells) {
      if (c.cont) continue;
      // Pi's rule lines around the editor: the input card replaces them
      const ch = inEditor && /^[─━═]$/.test(c.ch) ? " " : (c.hidden ? " " : c.ch);
      const fg = c.fg === DEFAULT ? null : unpackRgb(c.fg);
      const bg = c.bg === DEFAULT ? null : unpackRgb(c.bg);
      const flags = (c.bold ? 1 : 0) | (c.italic ? 2 : 0) | (c.underline ? 4 : 0) | (c.strike ? 8 : 0) | (c.dim ? 16 : 0);
      const [f, b] = c.inverse ? [bg, fg ?? [216, 222, 233]] : [fg, bg];
      const key = `${f}|${b}|${flags}`;
      if (run && run.key === key) run.text += ch;
      else { run = { key, text: ch, f, b, flags }; runs.push(run); }
    }
    rows.push(runs.map((x) => [x.text, x.f, x.b, x.flags]));
  }
  // blocks: consecutive rows of the same semantic block
  const blocks = [];
  let current = null;
  for (let r = 0; r < parsed.length; r += 1) {
    const sem = (parsed[r].cells || []).find((c) => c.sem)?.sem || null;
    if (sem && current && current.id === sem.block) {
      current.last = r;
      if (sem.streaming) current.streaming = true;
      if (sem.error) current.failed = true;
      continue;
    }
    if (current) blocks.push(current);
    current = sem ? { id: sem.block, role: sem.role, kind: sem.kind, first: r, last: r, streaming: !!sem.streaming, failed: !!sem.error } : null;
  }
  if (current) blocks.push(current);
  const out = blocks
    .filter((b) => !(editor && b.first >= editor.y && b.first < editor.y + editor.height))
    .map((b) => {
      const tool = b.role === "tool" || b.role === "bash";
      const status = b.streaming ? "running" : "done";
      return {
        prompt: b.first,
        // tools: a header row, then output; messages: all body
        output: tool && b.last > b.first ? b.first + 1 : b.first,
        end: b.last + 1,
        command: [b.role, b.kind].filter(Boolean).join(" "),
        status,
        exit: b.failed ? 1 : 0,
        badge: tool ? (b.failed ? "✗" : b.streaming ? "" : "✓") : (LABELS[b.role] ?? ""),
      };
    });
  if (editor) out.push({ prompt: editor.y, status: "prompt" });
  return { rows, blocks: out, cursor: cursor ? [cursor.col, cursor.row] : null };
}
