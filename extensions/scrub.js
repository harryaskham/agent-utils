// Pi extension: `/scrub` slash command & `scrub_session` tool.
//
// Cleans stale Responses API item signatures (thinkingSignature, textSignature,
// thoughtSignature) and foreign tool-call item IDs ("callId|itemId" -> "callId")
// from session JSONL and live context entries.
//
// This enables sessions to continue across Copilot account switches or
// model/transport migrations without failing upstream with:
// "401/400: input item ID does not belong to this connection" (earendil-works/pi#3139).
//
// Supports:
// - `/scrub` (or `/scrub current`): scrubs the active session in-memory and on-disk
// - `/scrub <path>`: scrubs a specific session file
// - `/scrub undo`: restores the session file from before the last scrub
// - `/scrub status`: reports whether signatures/foreign IDs are present in the current session
// - Idempotent: running `/scrub` when already clean creates no undo backup and makes no changes.
// - Safe undo: `/scrub` never overwrites an existing undo file if the session is already scrubbed.

import fs from "node:fs";
import path from "node:path";
import { ToolSchema } from "./lib/tool-schema.js";

const FALSE_RE = /^(0|false|off|no|disabled)$/i;

function envBool(name, fallback = true) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !FALSE_RE.test(String(value).trim());
}

/**
 * Sanitizes an AgentMessage object in-place or returns a cleaned clone.
 * Returns { message, changed, stats }.
 */
export function sanitizeMessage(msg) {
  if (!msg || typeof msg !== "object") {
    return { message: msg, changed: false, stats: { thinkingSignatures: 0, textSignatures: 0, thoughtSignatures: 0, toolCallIds: 0 } };
  }

  let changed = false;
  const stats = {
    thinkingSignatures: 0,
    textSignatures: 0,
    thoughtSignatures: 0,
    toolCallIds: 0,
  };

  const role = msg.role;
  const content = msg.content;

  if (role === "assistant" && Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;

      if ("thinkingSignature" in block) {
        delete block.thinkingSignature;
        stats.thinkingSignatures++;
        changed = true;
      }
      if ("textSignature" in block) {
        delete block.textSignature;
        stats.textSignatures++;
        changed = true;
      }
      if ("thoughtSignature" in block) {
        delete block.thoughtSignature;
        stats.thoughtSignatures++;
        changed = true;
      }

      if (block.type === "toolCall" && typeof block.id === "string" && block.id.includes("|")) {
        block.id = block.id.split("|")[0];
        stats.toolCallIds++;
        changed = true;
      }
    }
  } else if (role === "toolResult") {
    if (typeof msg.toolCallId === "string" && msg.toolCallId.includes("|")) {
      msg.toolCallId = msg.toolCallId.split("|")[0];
      stats.toolCallIds++;
      changed = true;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if ("thinkingSignature" in block) {
          delete block.thinkingSignature;
          stats.thinkingSignatures++;
          changed = true;
        }
        if ("textSignature" in block) {
          delete block.textSignature;
          stats.textSignatures++;
          changed = true;
        }
        if ("thoughtSignature" in block) {
          delete block.thoughtSignature;
          stats.thoughtSignatures++;
          changed = true;
        }
      }
    }
  }

  return { message: msg, changed, stats };
}

/**
 * Sanitizes a session entry object.
 */
export function sanitizeSessionEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return { entry, changed: false, stats: { thinkingSignatures: 0, textSignatures: 0, thoughtSignatures: 0, toolCallIds: 0 } };
  }

  let changed = false;
  const totalStats = {
    thinkingSignatures: 0,
    textSignatures: 0,
    thoughtSignatures: 0,
    toolCallIds: 0,
  };

  function accumulate(s) {
    totalStats.thinkingSignatures += s.thinkingSignatures;
    totalStats.textSignatures += s.textSignatures;
    totalStats.thoughtSignatures += s.thoughtSignatures;
    totalStats.toolCallIds += s.toolCallIds;
  }

  if (entry.type === "message" && entry.message) {
    const res = sanitizeMessage(entry.message);
    if (res.changed) {
      changed = true;
      accumulate(res.stats);
    }
  } else if (entry.type === "compaction" && Array.isArray(entry.retainedTail)) {
    for (const msg of entry.retainedTail) {
      const res = sanitizeMessage(msg);
      if (res.changed) {
        changed = true;
        accumulate(res.stats);
      }
    }
  }

  return { entry, changed, stats: totalStats };
}

export function undoPathFor(sessionFilePath) {
  return `${sessionFilePath}.scrub-undo`;
}

/**
 * Archive path for a previous undo backup that would otherwise be clobbered.
 *
 * `/scrub` must never destroy an existing undo file. When a second REAL scrub
 * happens (new dirty turns arrived after an earlier scrub), the prior
 * `.scrub-undo` is rotated to a timestamped sibling instead of being
 * overwritten, so every pre-scrub state stays recoverable on disk.
 */
export function archiveUndoPathFor(sessionFilePath, stamp) {
  return `${undoPathFor(sessionFilePath)}.${stamp}`;
}

function timestampSuffix(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Rotate an existing undo file out of the way rather than overwriting it.
 * Returns the archive path, or null when there was nothing to preserve.
 */
function rotateExistingUndo(resolved, undoPath, now) {
  if (!fs.existsSync(undoPath)) return null;
  let archivePath = archiveUndoPathFor(resolved, timestampSuffix(now));
  let counter = 1;
  while (fs.existsSync(archivePath)) {
    archivePath = `${archiveUndoPathFor(resolved, timestampSuffix(now))}-${counter}`;
    counter++;
  }
  fs.renameSync(undoPath, archivePath);
  return archivePath;
}

/**
 * Reads a JSONL session file, checks if scrubbing is needed, saves a .scrub-undo backup
 * only if changes are made, and writes the sanitized lines back.
 *
 * Idempotence contract:
 *   - A scrub that finds nothing to change writes NOTHING: not the session file,
 *     and crucially not the undo file. Running `/scrub` twice can never replace a
 *     real pre-scrub backup with an already-clean copy of itself.
 *   - A scrub that DOES change something rotates any existing `.scrub-undo` to a
 *     timestamped archive before writing the new one, so no undo state is lost.
 */
export function scrubSessionFile(filePath, { now = new Date() } = {}) {
  if (!filePath || typeof filePath !== "string") {
    return { ok: false, error: "Missing session file path" };
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `Session file not found: ${resolved}` };
  }

  const raw = fs.readFileSync(resolved, "utf8");
  const lines = raw.split("\n");
  const outLines = [];
  let fileChanged = false;
  const totalStats = {
    entriesScrubbed: 0,
    thinkingSignatures: 0,
    textSignatures: 0,
    thoughtSignatures: 0,
    toolCallIds: 0,
  };

  for (const line of lines) {
    if (!line.trim()) {
      outLines.push(line);
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      outLines.push(line);
      continue;
    }

    const { entry: sanitized, changed, stats } = sanitizeSessionEntry(entry);
    if (changed) {
      fileChanged = true;
      totalStats.entriesScrubbed++;
      totalStats.thinkingSignatures += stats.thinkingSignatures;
      totalStats.textSignatures += stats.textSignatures;
      totalStats.thoughtSignatures += stats.thoughtSignatures;
      totalStats.toolCallIds += stats.toolCallIds;
    }
    outLines.push(JSON.stringify(sanitized));
  }

  const undoPath = undoPathFor(resolved);

  if (!fileChanged) {
    return {
      ok: true,
      filePath: resolved,
      changed: false,
      undoPath: fs.existsSync(undoPath) ? undoPath : null,
      stats: totalStats,
      message: "Session is already clean (no stale Responses API signatures or foreign item IDs found).",
    };
  }

  // Never clobber an existing undo file: rotate it to a timestamped archive
  // first, then record this scrub's pre-change state as the current undo.
  const archivedUndoPath = rotateExistingUndo(resolved, undoPath, now);
  fs.writeFileSync(undoPath, raw, { mode: 0o600 });

  // Write scrubbed file
  fs.writeFileSync(resolved, outLines.join("\n"), { mode: 0o600 });

  const archivedNote = archivedUndoPath
    ? ` Previous undo preserved as ${path.basename(archivedUndoPath)}.`
    : "";

  return {
    ok: true,
    filePath: resolved,
    changed: true,
    undoPath,
    archivedUndoPath,
    stats: totalStats,
    message: `Scrubbed ${totalStats.entriesScrubbed} entries: ${totalStats.thinkingSignatures} thinking signatures, ${totalStats.textSignatures} text signatures, ${totalStats.thoughtSignatures} thought signatures, ${totalStats.toolCallIds} tool call item IDs stripped. Undo backup saved to ${path.basename(undoPath)}.${archivedNote}`,
  };
}

/**
 * List archived undo backups for a session, newest first.
 */
export function listArchivedUndos(sessionFilePath) {
  const resolved = path.resolve(sessionFilePath);
  const dir = path.dirname(resolved);
  const prefix = `${path.basename(undoPathFor(resolved))}.`;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()
    .map((name) => path.join(dir, name));
}

/**
 * Undoes the last scrub for a session file by restoring its .scrub-undo backup.
 *
 * Undo behaves like popping a stack: after restoring, the most recent archived
 * undo (if any) is promoted back to `.scrub-undo`, so a session scrubbed several
 * times can be walked back one scrub at a time instead of stranding older
 * backups as orphaned files.
 */
export function undoScrubFile(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return { ok: false, error: "Missing session file path" };
  }

  const resolved = path.resolve(filePath);
  const undoPath = undoPathFor(resolved);

  if (!fs.existsSync(undoPath)) {
    return { ok: false, error: `No undo file found at ${undoPath}` };
  }

  const backupContent = fs.readFileSync(undoPath, "utf8");
  fs.writeFileSync(resolved, backupContent, { mode: 0o600 });
  fs.unlinkSync(undoPath);

  // Promote the next-newest archived undo, if one exists, so repeated undos
  // unwind the scrub history instead of leaving archives unreachable.
  const [nextArchive] = listArchivedUndos(resolved);
  let promotedFrom = null;
  if (nextArchive) {
    fs.renameSync(nextArchive, undoPath);
    promotedFrom = nextArchive;
  }

  const promotedNote = promotedFrom
    ? ` Promoted ${path.basename(promotedFrom)} as the next undo step.`
    : "";

  return {
    ok: true,
    filePath: resolved,
    promotedFrom,
    remainingUndo: promotedFrom ? undoPath : null,
    message: `Restored session from ${path.basename(undoPath)} and removed undo backup.${promotedNote}`,
  };
}

/**
 * Inspects a session file to check how many signatures/foreign IDs are present.
 */
export function inspectSessionFile(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return { ok: false, error: "Missing session file path" };
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `Session file not found: ${resolved}` };
  }

  const raw = fs.readFileSync(resolved, "utf8");
  const lines = raw.split("\n");
  const totalStats = {
    entriesNeedingScrub: 0,
    thinkingSignatures: 0,
    textSignatures: 0,
    thoughtSignatures: 0,
    toolCallIds: 0,
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const { changed, stats } = sanitizeSessionEntry(entry);
      if (changed) {
        totalStats.entriesNeedingScrub++;
        totalStats.thinkingSignatures += stats.thinkingSignatures;
        totalStats.textSignatures += stats.textSignatures;
        totalStats.thoughtSignatures += stats.thoughtSignatures;
        totalStats.toolCallIds += stats.toolCallIds;
      }
    } catch {}
  }

  const undoPath = undoPathFor(resolved);
  const hasUndo = fs.existsSync(undoPath);
  const archivedUndos = listArchivedUndos(resolved);

  return {
    ok: true,
    filePath: resolved,
    clean: totalStats.entriesNeedingScrub === 0,
    stats: totalStats,
    hasUndo,
    undoPath: hasUndo ? undoPath : null,
    archivedUndos,
  };
}

/**
 * Scrubs live in-memory SessionManager entries if available in the extension context.
 */
export function scrubInMemorySession(ctx) {
  const sm = ctx?.sessionManager;
  if (!sm) return { inMemoryScrubbed: false };

  let changed = false;
  const totalStats = {
    entriesScrubbed: 0,
    thinkingSignatures: 0,
    textSignatures: 0,
    thoughtSignatures: 0,
    toolCallIds: 0,
  };

  const entries = typeof sm.getEntries === "function" ? sm.getEntries() : [];
  for (const entry of entries) {
    const { changed: entryChanged, stats } = sanitizeSessionEntry(entry);
    if (entryChanged) {
      changed = true;
      totalStats.entriesScrubbed++;
      totalStats.thinkingSignatures += stats.thinkingSignatures;
      totalStats.textSignatures += stats.textSignatures;
      totalStats.thoughtSignatures += stats.thoughtSignatures;
      totalStats.toolCallIds += stats.toolCallIds;
    }
  }

  return { inMemoryScrubbed: changed, stats: totalStats };
}

export default function scrubExtension(pi) {
  if (!envBool("PI_SCRUB_TOOL", true)) return;

  function resolveCurrentSessionPath(ctx) {
    const sm = ctx?.sessionManager;
    if (typeof sm?.getSessionFile === "function") {
      const file = sm.getSessionFile();
      if (file) return file;
    }
    return null;
  }

  // Register the /scrub slash command
  pi.registerCommand?.("scrub", {
    description: "Scrub stale Responses API item IDs and signatures from session history to allow account switching. Usage: /scrub [undo|status|<file>]. Idempotent: a clean session is left untouched and its undo backup is never replaced.",
    handler: async (args, ctx) => {
      const trimmed = String(args || "").trim();
      const firstArg = trimmed.split(/\s+/)[0]?.toLowerCase();

      if (firstArg === "undo") {
        const rest = trimmed.slice(firstArg.length).trim();
        const sessionPath = rest || resolveCurrentSessionPath(ctx);
        if (!sessionPath) {
          ctx.ui?.notify?.("Cannot undo: current session is ephemeral or has no file path.", "error");
          return;
        }
        const res = undoScrubFile(sessionPath);
        if (!res.ok) {
          ctx.ui?.notify?.(res.error, "error");
        } else {
          ctx.ui?.notify?.(res.message, "info");
        }
        return;
      }

      if (firstArg === "status") {
        const rest = trimmed.slice(firstArg.length).trim();
        const sessionPath = rest || resolveCurrentSessionPath(ctx);
        if (!sessionPath) {
          ctx.ui?.notify?.("Current session is ephemeral; no file on disk.", "info");
          return;
        }
        const status = inspectSessionFile(sessionPath);
        if (!status.ok) {
          ctx.ui?.notify?.(status.error, "error");
          return;
        }
        const archiveMsg = status.archivedUndos?.length
          ? ` ${status.archivedUndos.length} older undo archive(s) retained.`
          : "";
        if (status.clean) {
          const undoMsg = status.hasUndo ? ` (Undo available: ${path.basename(status.undoPath)})` : "";
          ctx.ui?.notify?.(`Session is clean: 0 stale item IDs or signatures.${undoMsg}${archiveMsg}`, "info");
        } else {
          ctx.ui?.notify?.(
            `Session has stale signatures: ${status.stats.entriesNeedingScrub} entries (${status.stats.thinkingSignatures} thinking, ${status.stats.textSignatures} text, ${status.stats.toolCallIds} tool calls). Run /scrub to clean.${archiveMsg}`,
            "warning"
          );
        }
        return;
      }

      // Default or custom path
      const targetPath = trimmed && firstArg !== "current" ? trimmed : resolveCurrentSessionPath(ctx);
      if (!targetPath) {
        ctx.ui?.notify?.("Cannot scrub: no active session file. Pass a file path: /scrub <path.jsonl>", "error");
        return;
      }

      // Also scrub in-memory if targeting current session
      const isCurrent = targetPath === resolveCurrentSessionPath(ctx);
      if (isCurrent) {
        scrubInMemorySession(ctx);
      }

      const res = scrubSessionFile(targetPath);
      if (!res.ok) {
        ctx.ui?.notify?.(res.error, "error");
      } else {
        ctx.ui?.notify?.(res.message, res.changed ? "info" : "info");
      }
    },
  });

  // Register the agent-visible tool
  if (typeof pi.registerTool === "function") {
    pi.registerTool({
      name: "scrub_session",
      label: "Scrub Session",
      description:
        "Scrub stale Responses API item signatures (thinkingSignature, textSignature, thoughtSignature) and foreign tool-call item IDs (callId|itemId) from session history. Fixes '401/400: input item ID does not belong to this connection' after Copilot account switching. Supports action='scrub', 'undo', or 'status'.",
      parameters: ToolSchema.object({
        action: ToolSchema.stringEnum(["scrub", "undo", "status"], {
          description: "Action to perform: scrub (default), undo (restore from backup), or status (check for stale signatures).",
        }),
        sessionFile: ToolSchema.string({
          description: "Optional session JSONL file path. Defaults to the current active session file.",
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const action = params?.action || "scrub";
        const sessionPath = params?.sessionFile || resolveCurrentSessionPath(ctx);

        if (!sessionPath) {
          return {
            content: [{ type: "text", text: "No session file found: current session is ephemeral or sessionFile was not provided." }],
            details: { ok: false, error: "no_session_file" },
          };
        }

        if (action === "undo") {
          const res = undoScrubFile(sessionPath);
          return {
            content: [{ type: "text", text: res.ok ? res.message : `Error: ${res.error}` }],
            details: res,
          };
        }

        if (action === "status") {
          const res = inspectSessionFile(sessionPath);
          return {
            content: [
              {
                type: "text",
                text: res.ok
                  ? res.clean
                    ? `Session is clean. No stale signatures or item IDs found.${res.hasUndo ? " (Undo backup exists)" : ""}`
                    : `Session has stale signatures: ${res.stats.entriesNeedingScrub} entries need scrubbing (${res.stats.thinkingSignatures} thinking, ${res.stats.textSignatures} text, ${res.stats.toolCallIds} tool calls).`
                  : `Error: ${res.error}`,
              },
            ],
            details: res,
          };
        }

        // Scrub
        if (sessionPath === resolveCurrentSessionPath(ctx)) {
          scrubInMemorySession(ctx);
        }
        const res = scrubSessionFile(sessionPath);
        return {
          content: [{ type: "text", text: res.ok ? res.message : `Error: ${res.error}` }],
          details: res,
        };
      },
    });
  }
}
