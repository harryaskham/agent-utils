// Ambient types for @isomorphic-git/lightning-fs (which ships no bundled .d.ts).
// Only the promises-API surface the pi-wasm VFS uses is declared. lightning-fs
// is IndexedDB-backed in the browser and pairs with isomorphic-git (pi-wasm S5),
// which consumes the raw FS instance exposed via LightningFsVfs.fs.

declare module "@isomorphic-git/lightning-fs" {
  export interface LightningFSStat {
    type: "file" | "dir" | "symlink";
    size: number;
    mtimeMs: number;
    ino: number;
    mode: number;
    ctimeMs: number;
    uid: number;
    gid: number;
    dev: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }

  export interface LightningFSPromises {
    readFile(path: string, options?: { encoding?: "utf8" } | "utf8"): Promise<Uint8Array | string>;
    writeFile(path: string, data: string | Uint8Array, options?: unknown): Promise<void>;
    mkdir(path: string, mode?: unknown): Promise<void>;
    rmdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<LightningFSStat>;
    lstat(path: string): Promise<LightningFSStat>;
    rename(oldPath: string, newPath: string): Promise<void>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
  }

  export interface LightningFSOptions {
    wipe?: boolean;
    fileDbName?: string;
    fileStoreName?: string;
  }

  export default class FS {
    constructor(name?: string, options?: LightningFSOptions);
    init(name: string, options?: LightningFSOptions): void;
    readonly promises: LightningFSPromises;
  }
}
