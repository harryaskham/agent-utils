// Pure path/string utilities extracted from kitty-image-preview.js (bd-e1914a).
// These depend only on their arguments plus node:path / node:os, with no
// preview state or terminal coupling. Behavior is unchanged from the original
// inline definitions.

import os from "node:os";
import path from "node:path";

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function normalizeMaybeAtPath(input) {
  if (typeof input !== "string") return input;
  return input.startsWith("@") ? input.slice(1) : input;
}

export function expandHome(inputPath) {
  if (!inputPath?.startsWith("~/")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(2));
}

export function resolveUserPath(cwd, inputPath) {
  const normalized = expandHome(normalizeMaybeAtPath(inputPath));
  return path.resolve(cwd, normalized);
}

export function relativeLabel(cwd, absolutePath) {
  const relative = path.relative(cwd, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}

export function sanitizeFilenamePart(value) {
  return String(value || "item")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
