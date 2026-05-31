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

export function pluralizeImages(count) {
  return count === 1 ? "image" : "images";
}

export function truncatePlainText(value, width, ellipsis = "…") {
  const text = String(value ?? "");
  const max = Math.max(0, Math.trunc(width || 0));
  if (max <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= ellipsis.length) return ellipsis.slice(0, max);
  return `${chars.slice(0, max - ellipsis.length).join("")}${ellipsis}`;
}

// Pure blank/placeholder line block: `rows` lines of `width` spaces, with an
// optional leading `text` overlaid on the first line. Extracted from
// kitty-image-preview.js (bd-e1914a).
export function renderPlaceholderLines(width, rows, text) {
  const line = " ".repeat(Math.max(1, width));
  const output = Array.from({ length: Math.max(1, rows) }, () => line);
  if (text) output[0] = `${text}${line}`.slice(0, Math.max(1, width));
  return output;
}
