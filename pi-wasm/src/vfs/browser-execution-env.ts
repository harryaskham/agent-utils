// BrowserExecutionEnv — a browser implementation of the Pi SDK's `ExecutionEnv`
// seam, backed by an IndexedDB virtual filesystem. pi-wasm S2 (bead bd-56130e,
// epic bd-f76cee).
//
// WHY THIS IS THE LOAD-BEARING SLICE (from the S1 derisk,
// scratch: pi-wasm:sdk-node-surface-findings + pi-wasm/FEASIBILITY.md §5):
// The Pi `Agent` loop (@earendil-works/pi-agent-core, the import-time
// browser-clean `.` entry) does NOT take an ExecutionEnv in its constructor —
// filesystem/exec coupling lives only inside each tool's `execute`. The node
// build uses `NodeExecutionEnv` (behind the `/node` subpath, real node:fs). The
// browser build injects THIS `BrowserExecutionEnv` into the S4 tools' execute
// closures instead. It imports zero node builtins.
//
// CONTRACT (pi-agent-core harness/types `FileSystem` + `Shell`): every method
// returns a `Result<T, FileError|ExecutionError>` and MUST NEVER throw/reject —
// all failures are encoded in the Result. Error codes + edge behaviors mirror
// `NodeExecutionEnv` (ENOENT→not_found, EISDIR→is_directory, writeFile creates
// parent dirs, fileInfo does not follow symlinks, exists→not_found→false, ...).
//
// EXEC SEAM: `exec()` returns `shell_unavailable` in this no-bash MVP. It is the
// single seam where a real shell plugs in later (pi-wasm S10 / Harry's
// 2026-07-09 direction): a JS bash emulator / WebContainer / emscripten-busybox
// mounting this same VFS, a wasm x86 microVM, or an ssh-out / MCP bridge for
// heavy work on a real host. Swapping it never touches the Agent loop or tools.

import { err, ExecutionError, FileError, ok } from "@earendil-works/pi-agent-core";
import type {
  ExecutionEnv,
  FileInfo,
  FileKind,
  Result,
  ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import * as path from "./posix-path";
import { LightningFsVfs, type Vfs, type VfsStat } from "./vfs";

interface NodeLikeError {
  code?: string;
  message?: string;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Map a node-style error (`.code`) onto the SDK's stable `FileError` codes. */
function toFileError(value: unknown, filePath?: string): FileError {
  if (value instanceof FileError) return value;
  const cause = toError(value);
  const code = (value as NodeLikeError | undefined)?.code;
  switch (code) {
    case "ABORT_ERR":
      return new FileError("aborted", cause.message, filePath, cause);
    case "ENOENT":
      return new FileError("not_found", cause.message, filePath, cause);
    case "EACCES":
    case "EPERM":
      return new FileError("permission_denied", cause.message, filePath, cause);
    case "ENOTDIR":
      return new FileError("not_directory", cause.message, filePath, cause);
    case "EISDIR":
      return new FileError("is_directory", cause.message, filePath, cause);
    case "EINVAL":
      return new FileError("invalid", cause.message, filePath, cause);
    default:
      return new FileError("unknown", cause.message, filePath, cause);
  }
}

function abortedResult(
  signal: AbortSignal | undefined,
  filePath?: string,
): Result<never, FileError> | undefined {
  return signal?.aborted ? err(new FileError("aborted", "aborted", filePath)) : undefined;
}

function kindFromVfs(type: VfsStat["type"]): FileKind {
  return type === "dir" ? "directory" : type === "symlink" ? "symlink" : "file";
}

function randomToken(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

export interface BrowserExecutionEnvOptions {
  /** Working directory for relative paths. Defaults to `/work`. */
  cwd?: string;
}

export class BrowserExecutionEnv implements ExecutionEnv {
  cwd: string;
  private readonly vfs: Vfs;

  constructor(vfs: Vfs, options?: BrowserExecutionEnvOptions) {
    this.vfs = vfs;
    this.cwd = path.normalize(options?.cwd ?? "/work");
  }

  private resolve(p: string): string {
    return path.resolve(this.cwd, p);
  }

  /** Create a directory and all missing parents (mkdir -p over the VFS). */
  private async mkdirp(dir: string): Promise<void> {
    const parts = dir.split("/").filter((segment) => segment.length > 0);
    let current = "";
    for (const segment of parts) {
      current += "/" + segment;
      try {
        await this.vfs.mkdir(current);
      } catch (error) {
        if ((error as NodeLikeError | undefined)?.code !== "EEXIST") throw error;
      }
    }
  }

  private infoFrom(filePath: string, stat: VfsStat): FileInfo {
    return {
      name: path.basename(filePath) || filePath,
      path: filePath,
      kind: kindFromVfs(stat.type),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }

  async absolutePath(p: string): Promise<Result<string, FileError>> {
    return ok(this.resolve(p));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(path.join(...parts));
  }

  async readTextFile(p: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const resolved = this.resolve(p);
    const aborted = abortedResult(abortSignal, resolved);
    if (aborted) return aborted;
    try {
      return ok(await this.vfs.readFileText(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async readTextLines(
    p: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    const resolved = this.resolve(p);
    const aborted = abortedResult(options?.abortSignal, resolved);
    if (aborted) return aborted;
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    try {
      const text = await this.vfs.readFileText(resolved);
      if (text === "") return ok([]);
      let lines = text.split("\n");
      // Drop the empty trailing element produced by a final newline, matching
      // node readline semantics.
      if (text.endsWith("\n")) lines = lines.slice(0, -1);
      // Normalize CRLF (readline uses crlfDelay: Infinity).
      lines = lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
      if (options?.maxLines !== undefined) lines = lines.slice(0, options.maxLines);
      return ok(lines);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async readBinaryFile(
    p: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>> {
    const resolved = this.resolve(p);
    const aborted = abortedResult(abortSignal, resolved);
    if (aborted) return aborted;
    try {
      return ok(await this.vfs.readFile(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async writeFile(
    p: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(p);
    const aborted = abortedResult(abortSignal, resolved);
    if (aborted) return aborted;
    try {
      await this.mkdirp(path.dirname(resolved));
      await this.vfs.writeFile(resolved, content);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async appendFile(p: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const resolved = this.resolve(p);
    try {
      await this.mkdirp(path.dirname(resolved));
      let existing: Uint8Array;
      try {
        existing = await this.vfs.readFile(resolved);
      } catch (error) {
        if ((error as NodeLikeError | undefined)?.code === "ENOENT") existing = new Uint8Array(0);
        else throw error;
      }
      const addition = toBytes(content);
      const merged = new Uint8Array(existing.length + addition.length);
      merged.set(existing, 0);
      merged.set(addition, existing.length);
      await this.vfs.writeFile(resolved, merged);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async fileInfo(p: string): Promise<Result<FileInfo, FileError>> {
    const resolved = this.resolve(p);
    try {
      return ok(this.infoFrom(resolved, await this.vfs.lstat(resolved)));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async listDir(p: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    const resolved = this.resolve(p);
    const aborted = abortedResult(abortSignal, resolved);
    if (aborted) return aborted;
    try {
      const names = await this.vfs.readdir(resolved);
      const infos: FileInfo[] = [];
      for (const name of names) {
        const loopAborted = abortedResult(abortSignal, resolved);
        if (loopAborted) return loopAborted;
        const childPath = path.join(resolved, name);
        infos.push(this.infoFrom(childPath, await this.vfs.lstat(childPath)));
      }
      return ok(infos);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async canonicalPath(p: string): Promise<Result<string, FileError>> {
    const resolved = this.resolve(p);
    // The VFS MVP does not follow symlinks; require existence so the behavior
    // mirrors node realpath's ENOENT on a missing path.
    try {
      await this.vfs.lstat(resolved);
      return ok(resolved);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async exists(p: string): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(p);
    if (info.ok) return ok(true);
    if (info.error.code === "not_found") return ok(false);
    return err(info.error);
  }

  async createDir(
    p: string,
    options?: { recursive?: boolean },
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(p);
    try {
      if (options?.recursive ?? true) await this.mkdirp(resolved);
      else await this.vfs.mkdir(resolved);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async remove(
    p: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(p);
    const recursive = options?.recursive ?? false;
    const force = options?.force ?? false;
    try {
      let stat: VfsStat;
      try {
        stat = await this.vfs.lstat(resolved);
      } catch (error) {
        if (force && (error as NodeLikeError | undefined)?.code === "ENOENT") return ok(undefined);
        throw error;
      }
      await this.removeEntry(resolved, stat, recursive);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  private async removeEntry(entryPath: string, stat: VfsStat, recursive: boolean): Promise<void> {
    if (stat.type === "dir") {
      if (recursive) {
        for (const name of await this.vfs.readdir(entryPath)) {
          const child = path.join(entryPath, name);
          await this.removeEntry(child, await this.vfs.lstat(child), true);
        }
      }
      await this.vfs.rmdir(entryPath);
    } else {
      await this.vfs.unlink(entryPath);
    }
  }

  async createTempDir(prefix = "tmp-"): Promise<Result<string, FileError>> {
    const dir = path.join("/tmp", `${prefix}${randomToken()}`);
    try {
      await this.mkdirp(dir);
      return ok(dir);
    } catch (error) {
      return err(toFileError(error, dir));
    }
  }

  async createTempFile(options?: {
    prefix?: string;
    suffix?: string;
  }): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir("tmp-");
    if (!dir.ok) return dir;
    const filePath = path.join(dir.value, `${options?.prefix ?? ""}${randomToken()}${options?.suffix ?? ""}`);
    try {
      await this.vfs.writeFile(filePath, "");
      return ok(filePath);
    } catch (error) {
      return err(toFileError(error, filePath));
    }
  }

  async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    if (options?.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    // No-bash MVP: the exec seam is intentionally unavailable. A real shell
    // (JS bash emulator / WebContainer / emscripten-busybox mounting this VFS,
    // a wasm microVM, or an ssh-out / MCP bridge) plugs in here in pi-wasm S10
    // without touching the Agent loop or the file tools. `command` is accepted
    // and ignored so the signature is stable for that future backend.
    void command;
    return err(
      new ExecutionError(
        "shell_unavailable",
        "exec/bash is unavailable in the browser VFS environment (pi-wasm no-bash MVP; a shell backend lands in S10)",
      ),
    );
  }

  async cleanup(): Promise<void> {
    // IndexedDB persists across reloads; nothing to release. Best-effort no-op
    // as required by the FileSystem/Shell contract (must not throw).
  }
}

export interface CreateBrowserExecutionEnvOptions extends BrowserExecutionEnvOptions {
  /** Provide a custom VFS backend (tests / OPFS / memory). Defaults to lightning-fs. */
  vfs?: Vfs;
  /** IndexedDB database name when using the default lightning-fs backend. */
  fsName?: string;
  /** Wipe the lightning-fs store on construction (default backend only). */
  wipe?: boolean;
  /**
   * Directories to ensure exist on init. Defaults to the Pi agent home and a
   * project workdir. S6 (settings/keys) seeds files under `/home/.pi/agent`.
   */
  seedDirs?: string[];
}

/**
 * Construct a BrowserExecutionEnv over an IndexedDB VFS (lightning-fs) and seed
 * the base directory layout. The backend is swappable via `options.vfs` — the
 * same `Vfs` seam accepts an OPFS-backed or in-memory implementation without any
 * change to BrowserExecutionEnv, the Agent loop, or the tools.
 */
export async function createBrowserExecutionEnv(
  options: CreateBrowserExecutionEnvOptions = {},
): Promise<BrowserExecutionEnv> {
  const vfs = options.vfs ?? new LightningFsVfs(options.fsName ?? "pi-wasm", { wipe: options.wipe });
  const env = new BrowserExecutionEnv(vfs, { cwd: options.cwd });
  const seedDirs = options.seedDirs ?? ["/home/.pi/agent", "/work"];
  for (const dir of seedDirs) {
    const result = await env.createDir(dir, { recursive: true });
    if (!result.ok) throw result.error;
  }
  return env;
}
