// Pi portable session export command (bd-d30dd1).
//
// `/session-export <destination> [--redact] [--max-bytes N]` exports the
// active branch only. The bundle is transport-neutral JSON; importing it is a
// separate slice so export never mutates or switches the current session.

import { constants } from "node:fs";
import { access, link, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createPortableSessionManifest } from "./lib/portable-session.js";

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
}
