// The internal VFS seam for pi-wasm (bead bd-56130e, epic bd-f76cee).
//
// `Vfs` is a tiny async filesystem subset that BrowserExecutionEnv is written
// against, so the concrete backing store is swappable and — importantly — can be
// SHARED with other consumers:
//   - pi-wasm S5 (isomorphic-git) consumes the raw lightning-fs instance
//     (`LightningFsVfs.fs`) directly for real in-browser git checkouts.
//   - A future JS bash emulator / wasm shell (pi-wasm S10, per Harry's
//     2026-07-09 direction) would MOUNT this same VFS so `exec` does real work
//     over the same files the tools see; heavy work can ssh-out or route via MCP.
//
// Keeping the surface small (the node:fs-ish calls BrowserExecutionEnv needs)
// means an in-memory implementation (tests) and lightning-fs (browser) both
// satisfy it.

import LightningFS from "@isomorphic-git/lightning-fs";

export interface VfsStat {
  type: "file" | "dir" | "symlink";
  size: number;
  mtimeMs: number;
}

/**
 * Minimal async filesystem. All paths are absolute, normalized POSIX paths.
 * Errors are thrown as node-style errors carrying a `.code` (e.g. `ENOENT`,
 * `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`) which BrowserExecutionEnv maps
 * onto the SDK's stable `FileError` codes.
 */
export interface Vfs {
  readFile(path: string): Promise<Uint8Array>;
  readFileText(path: string): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** Create a single directory level. Throws `EEXIST` if it already exists. */
  mkdir(path: string): Promise<void>;
  /** Remove an empty directory. Throws `ENOTEMPTY` if it has children. */
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  /** Stat without following symlinks. Throws `ENOENT` if missing. */
  lstat(path: string): Promise<VfsStat>;
}

/**
 * IndexedDB-backed VFS via @isomorphic-git/lightning-fs. This is the browser
 * backing store for BrowserExecutionEnv and the shared store for isomorphic-git
 * (S5). In tests it runs against `fake-indexeddb`.
 */
export class LightningFsVfs implements Vfs {
  /** Raw lightning-fs instance — pass `.fs` to isomorphic-git (pi-wasm S5). */
  readonly fs: LightningFS;
  private readonly p: LightningFS["promises"];

  constructor(name = "pi-wasm", options?: { wipe?: boolean }) {
    this.fs = new LightningFS(name, options?.wipe ? { wipe: true } : undefined);
    this.p = this.fs.promises;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const data = await this.p.readFile(path);
    return typeof data === "string" ? new TextEncoder().encode(data) : data;
  }

  async readFileText(path: string): Promise<string> {
    const data = await this.p.readFile(path, { encoding: "utf8" });
    return typeof data === "string" ? data : new TextDecoder().decode(data);
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await this.p.writeFile(path, data);
  }

  async mkdir(path: string): Promise<void> {
    await this.p.mkdir(path);
  }

  async rmdir(path: string): Promise<void> {
    await this.p.rmdir(path);
  }

  async unlink(path: string): Promise<void> {
    await this.p.unlink(path);
  }

  async readdir(path: string): Promise<string[]> {
    return this.p.readdir(path);
  }

  async lstat(path: string): Promise<VfsStat> {
    const stat = await this.p.lstat(path);
    const type: VfsStat["type"] = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "dir"
        : "file";
    return { type, size: stat.size ?? 0, mtimeMs: stat.mtimeMs ?? 0 };
  }
}
