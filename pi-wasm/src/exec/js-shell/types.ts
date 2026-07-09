// pi-wasm js-shell — shared types + a ShellFs adapter over the SDK ExecutionEnv
// (pi-wasm S10, bead bd-ef8f24).
//
// The js-shell backend implements coreutils PURELY via the ExecutionEnv's
// Result-returning fs methods (ms2-2's S13a pairing guidance), so the shell and
// the S4 file tools are guaranteed to see the SAME tree over ANY VFS backend
// (lightning-fs in the browser, InMemoryVfs in unit tests). The env methods
// resolve relative paths against env.cwd, so ShellFs always passes ABSOLUTE,
// normalized paths (which env.resolve returns unchanged) — keeping the shell's
// own `cd`-mutated cwd independent of env.cwd.

import type { ExecutionEnv, FileError, FileInfo, Result } from "@earendil-works/pi-agent-core";
import * as path from "../../vfs/posix-path";

export interface CommandIO {
  /** Full argv; argv[0] is the command name. */
  readonly argv: string[];
  /** Piped stdin (empty string when the command is first in a pipeline). */
  readonly stdin: string;
  /** Current absolute shell working directory. */
  readonly cwd: string;
  /** Shell environment variables. */
  readonly env: Readonly<Record<string, string>>;
  /** Absolute-path filesystem over the shared ExecutionEnv. */
  readonly fs: ShellFs;
}

export interface CommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** `cd` reports a new absolute cwd to apply to subsequent commands. */
  newCwd?: string;
}

export type Builtin = (io: CommandIO) => Promise<CommandOutcome>;

/** Resolve a command argument against the shell cwd → absolute normalized path. */
export function resolveArg(io: CommandIO, arg: string): string {
  return path.resolve(io.cwd, arg);
}

/**
 * A minimal absolute-path filesystem the builtins operate on. Every method
 * delegates to the ExecutionEnv with an already-absolute path, so behavior is
 * identical to what the S4 tools see and independent of env.cwd.
 */
export interface ShellFs {
  readTextFile(abs: string): Promise<Result<string, FileError>>;
  writeFile(abs: string, content: string): Promise<Result<void, FileError>>;
  appendFile(abs: string, content: string): Promise<Result<void, FileError>>;
  listDir(abs: string): Promise<Result<FileInfo[], FileError>>;
  fileInfo(abs: string): Promise<Result<FileInfo, FileError>>;
  exists(abs: string): Promise<Result<boolean, FileError>>;
  createDir(abs: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>>;
  remove(abs: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>>;
}

/** Build a ShellFs bound to an ExecutionEnv (only ever called with absolute paths). */
export function makeShellFs(env: ExecutionEnv): ShellFs {
  return {
    readTextFile: (abs) => env.readTextFile(abs),
    writeFile: (abs, content) => env.writeFile(abs, content),
    appendFile: (abs, content) => env.appendFile(abs, content),
    listDir: (abs) => env.listDir(abs),
    fileInfo: (abs) => env.fileInfo(abs),
    exists: (abs) => env.exists(abs),
    createDir: (abs, options) => env.createDir(abs, options),
    remove: (abs, options) => env.remove(abs, options),
  };
}

/** Render a unix-ish message for a FileError code (for shell stderr). */
export function fileErrorText(code: FileError["code"]): string {
  switch (code) {
    case "not_found":
      return "No such file or directory";
    case "is_directory":
      return "Is a directory";
    case "not_directory":
      return "Not a directory";
    case "permission_denied":
      return "Permission denied";
    case "aborted":
      return "Interrupted";
    default:
      return "I/O error";
  }
}
