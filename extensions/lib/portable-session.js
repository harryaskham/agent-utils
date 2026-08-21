// Portable Pi session bundle primitives (bd-38421f).
//
// This module is deliberately pure. Export/import commands own filesystem and
// Pi integration; these helpers only validate manifests and translate declared
// host path prefixes while producing an auditable report.

export const PORTABLE_SESSION_BUNDLE_VERSION = 1;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function createPortableSessionManifest({
  origin,
  repository = null,
  model = null,
  customTypes = [],
  createdAt,
  bundleVersion = PORTABLE_SESSION_BUNDLE_VERSION,
} = {}) {
  const manifest = {
    bundleVersion,
    createdAt: createdAt ?? new Date().toISOString(),
    origin: cloneJson(origin),
    repository: cloneJson(repository),
    model: cloneJson(model),
    customTypes: [...new Set((customTypes || []).filter(nonEmptyString))].sort(),
  };
  validatePortableSessionManifest(manifest);
  return manifest;
}

export function validatePortableSessionManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("portable session manifest must be an object");
  }
  if (manifest.bundleVersion !== PORTABLE_SESSION_BUNDLE_VERSION) {
    throw new Error(`unsupported portable session bundle version: ${String(manifest.bundleVersion)}`);
  }
  if (!manifest.origin || typeof manifest.origin !== "object") {
    throw new Error("portable session manifest requires origin metadata");
  }
  for (const field of ["sessionId", "host", "home", "cwd"]) {
    if (!nonEmptyString(manifest.origin[field])) {
      throw new Error(`portable session manifest origin.${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(manifest.customTypes) || !manifest.customTypes.every(nonEmptyString)) {
    throw new Error("portable session manifest customTypes must be an array of non-empty strings");
  }
  return manifest;
}

function normalizePrefix(prefix) {
  if (!nonEmptyString(prefix)) throw new Error("path mapping prefixes must be non-empty strings");
  if (prefix === "/") return prefix;
  return prefix.replace(/[\\/]+$/, "");
}

function separatorFor(prefix) {
  return prefix.includes("\\") && !prefix.includes("/") ? "\\" : "/";
}

function isPathBoundaryBefore(char) {
  return char === undefined || /[\s"'`=:(\[{,;]/.test(char);
}

function isPathBoundaryAfter(char, separator) {
  return char === undefined
    || char === separator
    || char === "/"
    || char === "\\"
    || /[\s"'`),\]}:,;]/.test(char);
}

function replaceDeclaredPrefix(input, from, to) {
  const separator = separatorFor(from);
  let cursor = 0;
  let output = "";
  let replacements = 0;
  while (cursor < input.length) {
    const index = input.indexOf(from, cursor);
    if (index < 0) {
      output += input.slice(cursor);
      break;
    }
    const before = index === 0 ? undefined : input[index - 1];
    const afterIndex = index + from.length;
    const after = afterIndex >= input.length ? undefined : input[afterIndex];
    if (isPathBoundaryBefore(before) && isPathBoundaryAfter(after, separator)) {
      output += input.slice(cursor, index) + to;
      cursor = afterIndex;
      replacements += 1;
    } else {
      output += input.slice(cursor, afterIndex);
      cursor = afterIndex;
    }
  }
  return { value: output, replacements };
}

function absolutePathCandidates(input) {
  const candidates = [];
  const posix = /(^|[\s"'`=:(\[{,;])(\/(?!\/)[^\s"'`),\]} ;]+)/g;
  const windows = /(^|[\s"'`=:(\[{,;])([A-Za-z]:[\\/][^\s"'`),\]} ;]+)/g;
  for (const pattern of [posix, windows]) {
    let match;
    while ((match = pattern.exec(input)) !== null) candidates.push(match[2]);
  }
  return candidates;
}

/**
 * Translate declared path prefixes in every string leaf of JSON-compatible
 * data. Rewrites are boundary checked and every unresolved absolute path is
 * reported with its JSON pointer-like location.
 */
export function translatePortableValue(value, mappings = []) {
  const normalized = mappings.map((mapping) => ({
    from: normalizePrefix(mapping?.from),
    to: normalizePrefix(mapping?.to),
  })).sort((a, b) => b.from.length - a.from.length);
  const report = { translated: [], unresolved: [] };

  function visit(current, location) {
    if (typeof current === "string") {
      let translated = current;
      for (const mapping of normalized) {
        const result = replaceDeclaredPrefix(translated, mapping.from, mapping.to);
        if (result.replacements > 0) {
          report.translated.push({ location, from: mapping.from, to: mapping.to, count: result.replacements });
          translated = result.value;
        }
      }
      const unresolved = [...new Set(absolutePathCandidates(translated))];
      for (const path of unresolved) {
        if (!normalized.some(({ to }) => path === to || (path.startsWith(to) && ["/", "\\"].includes(path[to.length])))) {
          report.unresolved.push({ location, path });
        }
      }
      return translated;
    }
    if (Array.isArray(current)) return current.map((item, index) => visit(item, `${location}/${index}`));
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, visit(item, `${location}/${escapePointer(key)}`)]));
    }
    return current;
  }

  return { value: visit(value, ""), report };
}

function escapePointer(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

export function createImportedSessionProvenance(manifest, { sessionId, importedAt } = {}) {
  validatePortableSessionManifest(manifest);
  if (!nonEmptyString(sessionId)) throw new Error("imported session provenance requires a new sessionId");
  return {
    sessionId,
    importedAt: importedAt ?? new Date().toISOString(),
    parentSession: {
      id: manifest.origin.sessionId,
      host: manifest.origin.host,
      bundleVersion: manifest.bundleVersion,
    },
  };
}
