// Minimal browser-safe POSIX path helpers for the pi-wasm VFS (pi-wasm S2,
// bead bd-56130e). Deliberately does NOT import node:path — the whole point of
// BrowserExecutionEnv is to run with zero node builtins. Semantics mirror
// node:path.posix closely enough for the ExecutionEnv contract (absolute paths,
// "." / ".." resolution, no symlink following).

export function isAbsolute(p: string): boolean {
  return p.startsWith("/");
}

/**
 * Normalize a POSIX path: collapse `//`, resolve `.`/`..`, preserve a leading
 * `/`. A normalized absolute path never has a trailing slash (except root `/`).
 * A normalized relative path is `.` when it collapses to empty.
 */
export function normalize(p: string): string {
  const absolute = isAbsolute(p);
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const top = out[out.length - 1];
      if (out.length > 0 && top !== "..") out.pop();
      else if (!absolute) out.push("..");
      // ".." at the root of an absolute path is a no-op.
      continue;
    }
    out.push(segment);
  }
  const joined = out.join("/");
  if (absolute) return "/" + joined;
  return joined === "" ? "." : joined;
}

/** Resolve `path` against `cwd`, returning a normalized absolute path. */
export function resolve(cwd: string, path: string): string {
  return normalize(isAbsolute(path) ? path : cwd + "/" + path);
}

/** Join path segments and normalize, mirroring node:path.posix.join. */
export function join(...parts: string[]): string {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) return ".";
  return normalize(filtered.join("/"));
}

/** Return the parent directory of a normalized path. */
export function dirname(p: string): string {
  const normalized = normalize(p);
  if (normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return normalized.slice(0, idx);
}

/** Return the final path segment of a normalized path. */
export function basename(p: string): string {
  const normalized = normalize(p);
  if (normalized === "/") return "";
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}
