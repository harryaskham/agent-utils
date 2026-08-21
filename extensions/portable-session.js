// Pi portable session export/import commands (bd-d30dd1, bd-23f673).
//
// `/session-export <destination> [--redact] [--max-bytes N]` exports the
// active branch only. `/session-import <bundle> [--cwd path]` validates and
// translates that transport-neutral bundle into a new local session file.
// Neither command mutates or switches the current session.

import { constants } from "node:fs";
import { access, link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createImportedSessionProvenance,
  createPortableSessionManifest,
  translatePortableValue,
  validatePortableSessionManifest,
} from "./lib/portable-session.js";

export const DEFAULT_EXPORT_MAX_BYTES = 50 * 1024 * 1024;
const SECRET_KEY_RE = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
];

function parsePositiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function parseSessionExportArgs(raw = "") {
  const tokens = String(raw).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return token.slice(1, -1);
    return token;
  }) ?? [];
  const options = { destination: null, redact: false, maxBytes: DEFAULT_EXPORT_MAX_BYTES, help: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--redact") options.redact = true;
    else if (token === "--max-bytes") options.maxBytes = parsePositiveInteger(tokens[++index], "--max-bytes");
    else if (token.startsWith("--max-bytes=")) options.maxBytes = parsePositiveInteger(token.slice(12), "--max-bytes");
    else if (token.startsWith("-")) throw new Error(`unknown session-export option: ${token}`);
    else if (options.destination) throw new Error("session-export accepts exactly one destination");
    else options.destination = token;
  }
  if (!options.help && !options.destination) throw new Error("session-export requires an explicit destination");
  return options;
}

export function redactPortableValue(value) {
  let replacements = 0;
  function visit(current, key = "") {
    if (SECRET_KEY_RE.test(key) && (typeof current === "string" || typeof current === "number")) {
      replacements += 1;
      return "[REDACTED]";
    }
    if (typeof current === "string") {
      let result = current;
      for (const pattern of SECRET_VALUE_PATTERNS) {
        result = result.replace(pattern, () => {
          replacements += 1;
          return "[REDACTED]";
        });
      }
      return result;
    }
    if (Array.isArray(current)) return current.map((item) => visit(item));
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([childKey, item]) => [childKey, visit(item, childKey)]));
    }
    return current;
  }
  return { value: visit(value), replacements };
}

export function inspectPortableSessionEntries(entries) {
  const customTypes = new Set();
  let imageCount = 0;
  let imageBase64Bytes = 0;
  let latestModel = null;

  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (value.type === "image" && typeof value.data === "string") {
      imageCount += 1;
      imageBase64Bytes += Buffer.byteLength(value.data, "utf8");
    }
    if ((value.type === "custom" || value.type === "custom_message") && typeof value.customType === "string") {
      customTypes.add(value.customType);
    }
    if (value.type === "model_change" && typeof value.provider === "string" && typeof value.modelId === "string") {
      latestModel = { provider: value.provider, id: value.modelId };
    }
    if (value.role === "assistant" && typeof value.provider === "string" && typeof value.model === "string") {
      latestModel = { provider: value.provider, id: value.model };
    }
    for (const child of Object.values(value)) walk(child);
  }
  for (const entry of entries) walk(entry);
  return { customTypes: [...customTypes].sort(), imageCount, imageBase64Bytes, latestModel };
}

export function buildPortableSessionBundle({ header, entries, host, home, repository = null, model = null, createdAt, redact = false }) {
  if (!header || header.type !== "session") throw new Error("active session header is unavailable or invalid");
  if (!Array.isArray(entries)) throw new Error("active session branch is unavailable");
  const inspection = inspectPortableSessionEntries(entries);
  const manifest = createPortableSessionManifest({
    origin: { sessionId: header.id, host, home, cwd: header.cwd },
    repository,
    model: model ?? inspection.latestModel,
    customTypes: inspection.customTypes,
    createdAt,
  });
  const raw = { manifest, session: { header, entries }, images: { count: inspection.imageCount, base64Bytes: inspection.imageBase64Bytes } };
  if (!redact) return { bundle: raw, redactions: 0 };
  const result = redactPortableValue(raw);
  return { bundle: result.value, redactions: result.replacements };
}

export async function writePortableSessionBundle(destination, bundle, { maxBytes = DEFAULT_EXPORT_MAX_BYTES, nonce = randomUUID } = {}) {
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxBytes) throw new Error(`portable session bundle is ${bytes} bytes, exceeding --max-bytes ${maxBytes}`);
  try {
    await access(destination, constants.F_OK);
    throw new Error(`refusing to overwrite existing destination: ${destination}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${nonce()}`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await link(temporary, destination);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`refusing to overwrite existing destination: ${destination}`);
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { destination, bytes };
}

function tokenizeArgs(raw) {
  return String(raw).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return token.slice(1, -1);
    return token;
  }) ?? [];
}

export function parseSessionImportArgs(raw = "") {
  const tokens = tokenizeArgs(raw);
  const options = {
    bundlePath: null,
    targetCwd: null,
    sessionDir: null,
    maxBytes: DEFAULT_EXPORT_MAX_BYTES,
    help: false,
  };
  const takeValue = (index, name) => {
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
    return value;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--cwd") options.targetCwd = takeValue(index++, "--cwd");
    else if (token.startsWith("--cwd=")) options.targetCwd = token.slice(6);
    else if (token === "--session-dir") options.sessionDir = takeValue(index++, "--session-dir");
    else if (token.startsWith("--session-dir=")) options.sessionDir = token.slice(14);
    else if (token === "--max-bytes") options.maxBytes = parsePositiveInteger(tokens[++index], "--max-bytes");
    else if (token.startsWith("--max-bytes=")) options.maxBytes = parsePositiveInteger(token.slice(12), "--max-bytes");
    else if (token.startsWith("-")) throw new Error(`unknown session-import option: ${token}`);
    else if (options.bundlePath) throw new Error("session-import accepts exactly one bundle path");
    else options.bundlePath = token;
  }
  if (!options.help && !options.bundlePath) throw new Error("session-import requires a bundle path");
  if (!options.help && options.targetCwd === "") throw new Error("--cwd requires a path");
  if (!options.help && options.sessionDir === "") throw new Error("--session-dir requires a path");
  return options;
}

export function validatePortableSessionBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("portable session bundle must be an object");
  }
  validatePortableSessionManifest(bundle.manifest);
  if (bundle.manifest.model != null) {
    const model = bundle.manifest.model;
    if (!model || typeof model !== "object" || typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) {
      throw new Error("portable session manifest model must contain non-empty provider and id strings");
    }
  }
  const session = bundle.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new Error("portable session bundle requires session data");
  }
  const header = session.header;
  if (!header || typeof header !== "object" || header.type !== "session") {
    throw new Error("portable session bundle requires a valid session header");
  }
  if (header.id !== bundle.manifest.origin.sessionId) {
    throw new Error("portable session header id does not match manifest origin.sessionId");
  }
  if (header.cwd !== bundle.manifest.origin.cwd) {
    throw new Error("portable session header cwd does not match manifest origin.cwd");
  }
  if (!Number.isInteger(header.version) || header.version < 1 || header.version > 3) {
    throw new Error(`unsupported Pi session version: ${String(header.version)}`);
  }
  if (!Array.isArray(session.entries)) {
    throw new Error("portable session bundle session.entries must be an array");
  }
  const ids = new Set();
  for (const [index, entry] of session.entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`portable session entry ${index} must be an object`);
    }
    if (typeof entry.type !== "string" || typeof entry.id !== "string" || !entry.id) {
      throw new Error(`portable session entry ${index} requires type and id`);
    }
    if (ids.has(entry.id)) throw new Error(`portable session contains duplicate entry id: ${entry.id}`);
    ids.add(entry.id);
  }
  for (const [index, entry] of session.entries.entries()) {
    if (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId))) {
      throw new Error(`portable session entry ${index} has an unresolved parentId`);
    }
  }
  return bundle;
}

export function portableSessionDirectoryName(cwd) {
  const resolved = resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Match Pi's default per-cwd session placement, while preserving an explicitly
 * configured shared `--session-dir`. A custom current session directory must
 * remain custom; Pi filters its contents by header cwd during list/continue.
 */
export function resolvePortableSessionImportDir({
  targetCwd,
  currentCwd,
  currentSessionDir,
  targetHome = homedir(),
  sessionDir,
} = {}) {
  if (sessionDir) return resolve(sessionDir);
  const encodedCurrent = currentCwd ? portableSessionDirectoryName(currentCwd) : null;
  if (currentSessionDir && encodedCurrent && basename(currentSessionDir) === encodedCurrent) {
    return join(dirname(currentSessionDir), portableSessionDirectoryName(targetCwd));
  }
  if (currentSessionDir) return resolve(currentSessionDir);
  return join(resolve(targetHome), ".pi", "agent", "sessions", portableSessionDirectoryName(targetCwd));
}

export function buildImportedPortableSession({
  bundle,
  targetCwd,
  targetHome,
  sessionId = randomUUID(),
  importedAt = new Date().toISOString(),
  modelAvailable = null,
  knownCustomTypes = null,
} = {}) {
  validatePortableSessionBundle(bundle);
  if (typeof targetCwd !== "string" || !targetCwd) throw new Error("session import requires a target cwd");
  if (typeof targetHome !== "string" || !targetHome) throw new Error("session import requires a target HOME");
  if (typeof sessionId !== "string" || !sessionId) throw new Error("session import requires a new session id");

  const mappings = [
    { from: bundle.manifest.origin.cwd, to: targetCwd },
    { from: bundle.manifest.origin.home, to: targetHome },
  ];
  const translated = translatePortableValue(bundle.session, mappings);
  const provenance = createImportedSessionProvenance(bundle.manifest, { sessionId, importedAt });
  // `parentSession` is defined by Pi as a local session-file path. A portable
  // origin is not one, so do not copy or smuggle a URI into that field. The
  // explicit extension metadata below carries the cross-host parent identity.
  const { parentSession: _originLocalParent, ...translatedHeader } = translated.value.header;
  const header = {
    ...translatedHeader,
    type: "session",
    id: sessionId,
    timestamp: importedAt,
    cwd: targetCwd,
    portableImport: provenance,
  };
  const warnings = [];
  const model = bundle.manifest.model;
  if (model && modelAvailable === false) {
    warnings.push({ code: "model-unavailable", provider: model.provider, model: model.id });
  } else if (model && modelAvailable === null) {
    warnings.push({ code: "model-unverified", provider: model.provider, model: model.id });
  }
  const known = knownCustomTypes == null ? null : new Set(knownCustomTypes);
  for (const customType of bundle.manifest.customTypes) {
    if (known === null) warnings.push({ code: "custom-type-unverified", customType });
    else if (!known.has(customType)) warnings.push({ code: "custom-type-unavailable", customType });
  }
  return {
    header,
    entries: translated.value.entries,
    report: {
      mappings,
      translated: translated.report.translated,
      unresolved: translated.report.unresolved,
      warnings,
      provenance,
    },
  };
}

export function formatPortableSessionCompatibilityReport(report, { limit = 5 } = {}) {
  const unresolved = report?.unresolved ?? [];
  const warnings = report?.warnings ?? [];
  const lines = [
    `translated=${(report?.translated ?? []).reduce((sum, item) => sum + (item.count || 0), 0)}`,
    `unresolved=${unresolved.length}`,
    `warnings=${warnings.length}`,
  ];
  for (const item of unresolved.slice(0, limit)) {
    lines.push(`unresolved ${item.path} at ${item.location || "/"} (preserved)`);
  }
  if (unresolved.length > limit) lines.push(`... ${unresolved.length - limit} more unresolved path(s)`);
  for (const warning of warnings.slice(0, limit)) {
    if (warning.code.startsWith("model-")) lines.push(`${warning.code} ${warning.provider}/${warning.model}`);
    else lines.push(`${warning.code} ${warning.customType}`);
  }
  if (warnings.length > limit) lines.push(`... ${warnings.length - limit} more compatibility warning(s)`);
  return lines.join("\n");
}

export async function writeImportedPortableSession({
  sessionDir,
  header,
  entries,
  destination,
  nonce = randomUUID,
} = {}) {
  if (!sessionDir) throw new Error("session import requires a destination session directory");
  if (!header || header.type !== "session" || !Array.isArray(entries)) throw new Error("invalid imported session payload");
  const fileTimestamp = String(header.timestamp).replace(/[:.]/g, "-");
  const target = destination ?? join(sessionDir, `${fileTimestamp}_${header.id}.jsonl`);
  const serialized = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${nonce()}`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await link(temporary, target);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`refusing to overwrite existing imported session: ${target}`);
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { destination: target, bytes: Buffer.byteLength(serialized, "utf8") };
}

async function repositoryMetadata(pi, cwd) {
  if (typeof pi.exec !== "function") return null;
  const [remote, commit] = await Promise.all([
    pi.exec("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 5000 }),
    pi.exec("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 5000 }),
  ]);
  if (remote?.code !== 0 || commit?.code !== 0) return null;
  return { remote: remote.stdout.trim(), commit: commit.stdout.trim() };
}

export default function portableSessionExtension(pi) {
  pi.registerCommand("session-export", {
    description: "Export the active session branch as a portable, versioned bundle",
    handler: async (args, ctx) => {
      let options;
      try {
        options = parseSessionExportArgs(args);
      } catch (error) {
        ctx.ui.notify(error.message || String(error), "error");
        return;
      }
      if (options.help) {
        ctx.ui.notify("Usage: /session-export <destination> [--redact] [--max-bytes N]", "info");
        return;
      }
      const sessionManager = ctx.sessionManager;
      const sessionFile = sessionManager?.getSessionFile?.();
      if (!sessionFile) {
        ctx.ui.notify("Cannot export an in-memory or unsaved session.", "error");
        return;
      }
      try {
        const header = sessionManager.getHeader();
        const entries = sessionManager.getBranch();
        const repository = await repositoryMetadata(pi, ctx.cwd);
        const { bundle, redactions } = buildPortableSessionBundle({
          header,
          entries,
          host: hostname(),
          home: process.env.HOME || homedir(),
          repository,
          model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
          redact: options.redact,
        });
        const destination = resolve(ctx.cwd, options.destination);
        const result = await writePortableSessionBundle(destination, bundle, { maxBytes: options.maxBytes });
        ctx.ui.notify(
          `Exported ${entries.length} active-branch entries to ${result.destination} (${result.bytes} bytes, ${bundle.images.count} inline images${options.redact ? `, ${redactions} redactions` : ""}).`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Session export failed: ${error.message || error}`, "error");
      }
    },
  });

  pi.registerCommand("session-import", {
    description: "Import a portable session bundle under a local cwd without changing the active session",
    handler: async (args, ctx) => {
      let options;
      try {
        options = parseSessionImportArgs(args);
      } catch (error) {
        ctx.ui.notify(error.message || String(error), "error");
        return;
      }
      if (options.help) {
        ctx.ui.notify("Usage: /session-import <bundle> [--cwd PATH] [--session-dir PATH] [--max-bytes N]", "info");
        return;
      }
      try {
        const bundlePath = resolve(ctx.cwd, options.bundlePath);
        const bundleStat = await stat(bundlePath);
        if (!bundleStat.isFile()) throw new Error(`bundle is not a regular file: ${bundlePath}`);
        if (bundleStat.size > options.maxBytes) {
          throw new Error(`portable session bundle is ${bundleStat.size} bytes, exceeding --max-bytes ${options.maxBytes}`);
        }
        const sourceBytes = await readFile(bundlePath, "utf8");
        if (Buffer.byteLength(sourceBytes, "utf8") > options.maxBytes) {
          throw new Error(`portable session bundle exceeds --max-bytes ${options.maxBytes}`);
        }
        let bundle;
        try { bundle = JSON.parse(sourceBytes); }
        catch (error) { throw new Error(`bundle is not valid JSON: ${error.message || error}`); }
        validatePortableSessionBundle(bundle);

        const targetCwd = resolve(ctx.cwd, options.targetCwd || ctx.cwd);
        const targetStat = await stat(targetCwd).catch(() => null);
        if (!targetStat?.isDirectory()) throw new Error(`target cwd does not exist or is not a directory: ${targetCwd}`);
        const targetHome = process.env.HOME || homedir();

        let modelAvailable = null;
        if (bundle.manifest.model && typeof ctx.modelRegistry?.find === "function") {
          try {
            modelAvailable = !!ctx.modelRegistry.find(bundle.manifest.model.provider, bundle.manifest.model.id);
          } catch {
            // A broken or unavailable registry is compatibility information, not
            // a reason to strand otherwise valid conversation history.
            modelAvailable = null;
          }
        }
        const imported = buildImportedPortableSession({
          bundle,
          targetCwd,
          targetHome,
          modelAvailable,
        });
        const currentSessionDir = ctx.sessionManager?.getSessionDir?.();
        const currentCwd = ctx.sessionManager?.getCwd?.() || ctx.cwd;
        const sessionDir = resolvePortableSessionImportDir({
          targetCwd,
          currentCwd,
          currentSessionDir,
          targetHome,
          sessionDir: options.sessionDir ? resolve(ctx.cwd, options.sessionDir) : null,
        });
        const result = await writeImportedPortableSession({ sessionDir, ...imported });
        ctx.ui.notify(
          `Imported ${imported.entries.length} entries from ${bundle.manifest.origin.host}/${bundle.manifest.origin.sessionId} to ${result.destination} (${result.bytes} bytes).`,
          "info",
        );
        const compatibility = formatPortableSessionCompatibilityReport(imported.report);
        const hasConcerns = imported.report.unresolved.length > 0 || imported.report.warnings.length > 0;
        ctx.ui.notify(`Session import compatibility report:\n${compatibility}`, hasConcerns ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(`Session import failed: ${error.message || error}`, "error");
      }
    },
  });
}
