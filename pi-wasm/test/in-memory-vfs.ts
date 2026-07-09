// In-memory Vfs for tests — a deterministic, dependency-free backend that throws
// node-style errors (`.code`) so it exercises the exact same BrowserExecutionEnv
// error mapping as lightning-fs. Used alongside the lightning-fs/fake-indexeddb
// backend to prove the ExecutionEnv logic is backend-independent.

import * as path from "../src/vfs/posix-path";
import type { Vfs, VfsStat } from "../src/vfs/vfs";

interface Entry {
  type: "file" | "dir";
  data: Uint8Array;
  mtimeMs: number;
}

function fsError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

export class InMemoryVfs implements Vfs {
  private readonly entries = new Map<string, Entry>();

  constructor() {
    this.entries.set("/", { type: "dir", data: new Uint8Array(0), mtimeMs: Date.now() });
  }

  private requireDirParent(target: string): void {
    const parent = path.dirname(target);
    const entry = this.entries.get(parent);
    if (!entry) throw fsError("ENOENT", parent);
    if (entry.type !== "dir") throw fsError("ENOTDIR", parent);
  }

  private children(dir: string): string[] {
    const out: string[] = [];
    for (const key of this.entries.keys()) {
      if (key === dir) continue;
      if (path.dirname(key) === dir) out.push(path.basename(key));
    }
    return out;
  }

  async readFile(p: string): Promise<Uint8Array> {
    const norm = path.normalize(p);
    const entry = this.entries.get(norm);
    if (!entry) throw fsError("ENOENT", norm);
    if (entry.type === "dir") throw fsError("EISDIR", norm);
    return entry.data.slice();
  }

  async readFileText(p: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(p));
  }

  async writeFile(p: string, data: string | Uint8Array): Promise<void> {
    const norm = path.normalize(p);
    this.requireDirParent(norm);
    const existing = this.entries.get(norm);
    if (existing?.type === "dir") throw fsError("EISDIR", norm);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data.slice();
    this.entries.set(norm, { type: "file", data: bytes, mtimeMs: Date.now() });
  }

  async mkdir(p: string): Promise<void> {
    const norm = path.normalize(p);
    if (norm === "/") throw fsError("EEXIST", norm);
    if (this.entries.has(norm)) throw fsError("EEXIST", norm);
    this.requireDirParent(norm);
    this.entries.set(norm, { type: "dir", data: new Uint8Array(0), mtimeMs: Date.now() });
  }

  async rmdir(p: string): Promise<void> {
    const norm = path.normalize(p);
    const entry = this.entries.get(norm);
    if (!entry) throw fsError("ENOENT", norm);
    if (entry.type !== "dir") throw fsError("ENOTDIR", norm);
    if (this.children(norm).length > 0) throw fsError("ENOTEMPTY", norm);
    this.entries.delete(norm);
  }

  async unlink(p: string): Promise<void> {
    const norm = path.normalize(p);
    const entry = this.entries.get(norm);
    if (!entry) throw fsError("ENOENT", norm);
    if (entry.type === "dir") throw fsError("EISDIR", norm);
    this.entries.delete(norm);
  }

  async readdir(p: string): Promise<string[]> {
    const norm = path.normalize(p);
    const entry = this.entries.get(norm);
    if (!entry) throw fsError("ENOENT", norm);
    if (entry.type !== "dir") throw fsError("ENOTDIR", norm);
    return this.children(norm);
  }

  async lstat(p: string): Promise<VfsStat> {
    const norm = path.normalize(p);
    const entry = this.entries.get(norm);
    if (!entry) throw fsError("ENOENT", norm);
    return {
      type: entry.type,
      size: entry.type === "file" ? entry.data.length : 0,
      mtimeMs: entry.mtimeMs,
    };
  }
}
