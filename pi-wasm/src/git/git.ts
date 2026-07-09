// pi-wasm S5 — real in-browser git over the shared VFS (bead bd-3f7a4f, epic
// bd-f76cee).
//
// Uses isomorphic-git (pure JS, browser-compatible) driving the SAME
// lightning-fs / IndexedDB store that backs `BrowserExecutionEnv` (S2,
// bd-56130e). Because git writes through `LightningFsVfs.fs`, a cloned/checked-
// out repo is immediately visible to the file tools (S4) and the agent loop —
// there is one filesystem, not two.
//
// NETWORK / CORS: browsers cannot open raw TCP or hit arbitrary git hosts, so
// smart-http fetch/clone goes through isomorphic-git's `http/web` client against
// a **CORS git proxy** (`corsProxy`). See ./README.md for the proxy contract.
// Local-only operations (init/add/commit/log/listFiles/checkout of an existing
// repo) need no network and no proxy.

import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { LightningFsVfs } from "../vfs/vfs";

/** The injectable http transport shape (isomorphic-git/http/web). Swappable in tests. */
export type GitHttpClient = typeof http;

/** Default public CORS git proxy used by isomorphic-git's docs/demos. */
export const DEFAULT_CORS_PROXY = "https://cors.isomorphic-git.org";
/** Default working directory for repositories inside the VFS. */
export const DEFAULT_GIT_DIR = "/work";
/** Fallback commit author (real app should pass the user's identity from S6). */
export const DEFAULT_GIT_AUTHOR: GitAuthor = {
  name: "pi-wasm",
  email: "pi-wasm@agent-utils.local",
};

export interface GitAuthor {
  name: string;
  email: string;
}

export interface GitProgress {
  phase: string;
  loaded?: number;
  total?: number;
}
export type GitProgressCallback = (progress: GitProgress) => void;

export interface CreateBrowserGitOptions {
  /** Shared VFS whose raw lightning-fs instance (`.fs`) git drives directly. */
  vfs: LightningFsVfs;
  /** Default repo working dir. Defaults to `/work`. */
  dir?: string;
  /**
   * CORS git proxy for fetch/clone (browsers can't reach arbitrary git hosts).
   * Defaults to the public isomorphic-git proxy; set to `""` to disable (e.g.
   * a same-origin host or a proxy already baked into the URL).
   */
  corsProxy?: string;
  /** Injectable http transport (default `isomorphic-git/http/web`). */
  http?: GitHttpClient;
  /** Default commit author. */
  author?: GitAuthor;
}

export interface CloneOptions {
  url: string;
  dir?: string;
  ref?: string;
  /** Shallow depth. Defaults to 1 (fast, browser-friendly). Pass 0 for full. */
  depth?: number;
  singleBranch?: boolean;
  /** Per-call CORS proxy override. */
  corsProxy?: string;
  onProgress?: GitProgressCallback;
}

export interface CloneResult {
  dir: string;
  url: string;
  ref?: string;
  /** Tracked files present after checkout. */
  files: string[];
}

export interface CheckoutOptions {
  ref: string;
  dir?: string;
  /** Restrict checkout to these paths. */
  filepaths?: string[];
  force?: boolean;
}

export interface ListFilesOptions {
  dir?: string;
  ref?: string;
}

export interface LogOptions {
  dir?: string;
  depth?: number;
  ref?: string;
}

export interface LogEntry {
  oid: string;
  message: string;
  author: GitAuthor;
  timestamp: number;
}

export interface InitOptions {
  dir?: string;
  defaultBranch?: string;
}

export interface AddOptions {
  filepath: string | string[];
  dir?: string;
}

export interface CommitOptions {
  message: string;
  dir?: string;
  author?: GitAuthor;
}

/**
 * Real git over the browser VFS. All methods resolve absolute POSIX dirs inside
 * the shared lightning-fs store, so results are visible to `BrowserExecutionEnv`
 * and the file tools without any copy.
 */
export class BrowserGit {
  /** Raw lightning-fs instance handed to isomorphic-git (shared with the VFS). */
  private readonly fs: LightningFsVfs["fs"];
  readonly dir: string;
  readonly corsProxy: string;
  private readonly http: GitHttpClient;
  private readonly author: GitAuthor;

  constructor(options: CreateBrowserGitOptions) {
    this.fs = options.vfs.fs;
    this.dir = options.dir ?? DEFAULT_GIT_DIR;
    this.corsProxy = options.corsProxy ?? DEFAULT_CORS_PROXY;
    this.http = options.http ?? http;
    this.author = options.author ?? DEFAULT_GIT_AUTHOR;
  }

  /** Clone a real repo into the VFS over smart-http (needs the CORS proxy). */
  async clone(options: CloneOptions): Promise<CloneResult> {
    const dir = options.dir ?? this.dir;
    const corsProxy = options.corsProxy ?? this.corsProxy;
    await git.clone({
      fs: this.fs,
      http: this.http,
      dir,
      url: options.url,
      ...(corsProxy ? { corsProxy } : {}),
      ...(options.ref ? { ref: options.ref } : {}),
      depth: options.depth ?? 1,
      singleBranch: options.singleBranch ?? true,
      ...(options.onProgress
        ? {
            onProgress: (event) =>
              options.onProgress?.({
                phase: event.phase,
                loaded: event.loaded,
                total: event.total,
              }),
          }
        : {}),
    });
    const files = await this.listFiles({ dir });
    return { dir, url: options.url, ref: options.ref, files };
  }

  /** Check out a ref (branch/tag/oid) in an existing repo. */
  async checkout(options: CheckoutOptions): Promise<void> {
    await git.checkout({
      fs: this.fs,
      dir: options.dir ?? this.dir,
      ref: options.ref,
      ...(options.filepaths ? { filepaths: options.filepaths } : {}),
      ...(options.force ? { force: true } : {}),
    });
  }

  /** List tracked files (optionally at a ref). */
  async listFiles(options: ListFilesOptions = {}): Promise<string[]> {
    return git.listFiles({
      fs: this.fs,
      dir: options.dir ?? this.dir,
      ...(options.ref ? { ref: options.ref } : {}),
    });
  }

  /** Read commit history, newest first. */
  async log(options: LogOptions = {}): Promise<LogEntry[]> {
    const commits = await git.log({
      fs: this.fs,
      dir: options.dir ?? this.dir,
      depth: options.depth ?? 20,
      ...(options.ref ? { ref: options.ref } : {}),
    });
    return commits.map((entry) => ({
      oid: entry.oid,
      message: entry.commit.message,
      author: {
        name: entry.commit.author.name,
        email: entry.commit.author.email,
      },
      timestamp: entry.commit.author.timestamp,
    }));
  }

  /** Current branch name (or undefined in detached HEAD). */
  async currentBranch(dir = this.dir): Promise<string | undefined> {
    const branch = await git.currentBranch({ fs: this.fs, dir, fullname: false });
    return branch ?? undefined;
  }

  // --- Local authoring (no network); also the deterministic test surface. ---

  async init(options: InitOptions = {}): Promise<void> {
    await git.init({
      fs: this.fs,
      dir: options.dir ?? this.dir,
      defaultBranch: options.defaultBranch ?? "main",
    });
  }

  async add(options: AddOptions): Promise<void> {
    const dir = options.dir ?? this.dir;
    const filepaths = Array.isArray(options.filepath) ? options.filepath : [options.filepath];
    for (const filepath of filepaths) {
      await git.add({ fs: this.fs, dir, filepath });
    }
  }

  async commit(options: CommitOptions): Promise<string> {
    return git.commit({
      fs: this.fs,
      dir: options.dir ?? this.dir,
      message: options.message,
      author: options.author ?? this.author,
    });
  }
}

/** Construct a {@link BrowserGit} bound to the shared VFS. */
export function createBrowserGit(options: CreateBrowserGitOptions): BrowserGit {
  return new BrowserGit(options);
}
