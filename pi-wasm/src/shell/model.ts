// pi-wasm S12 (bd-254c94) — slick shell: pure, framework-free derivations.
//
// Kept SDK/DOM-free so it is unit-testable in node vitest. The slick shell
// (shell.ts) is a thin DOM renderer over these pure models; all the real logic
// (timeline derivation, VFS sorting, formatting) lives here and is tested.
//
// Additive to aurora's S7 MVP (chat-ui.ts): S12 is a separate app entry
// (shell.html) that reuses the same seams (PiWasmSession, env, tools, settings)
// — it does NOT modify the S7 chat page or its __PI_WASM__/data-pi-wasm-ready
// hooks that the S8 Playwright suite drives.

export type TimelineRole =
  | "user"
  | "assistant"
  | "system"
  | "tool-call"
  | "tool-result"
  | "tool-error";

export interface TimelineItem {
  role: TimelineRole;
  text: string;
  streaming: boolean;
  /** For tool rows: the "name(args)" / "name → result" summary. */
  tool?: string;
}

/** Structural shape of an agent message (avoids coupling to SDK types). */
export interface MessageLike {
  role?: string;
  content?: unknown;
  toolName?: string;
  isError?: boolean;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\u2026" : s;
}

/** Concatenate the text blocks of a message's content (string or block array). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      text += (part as { text?: string }).text ?? "";
    }
  }
  return text;
}

/** Split content into concatenated text + tool-call summaries. */
function partsOf(content: unknown): { text: string; tools: string[] } {
  const tools: string[] = [];
  if (typeof content === "string") return { text: content, tools };
  if (!Array.isArray(content)) return { text: "", tools };
  let text = "";
  for (const part of content) {
    if (!part || typeof part !== "object" || !("type" in part)) continue;
    const p = part as { type: string; text?: string; name?: string; arguments?: unknown };
    if (p.type === "text") text += p.text ?? "";
    else if (p.type === "toolCall") {
      let args = "";
      try {
        args = p.arguments ? JSON.stringify(p.arguments) : "";
      } catch {
        args = "";
      }
      tools.push(`${p.name ?? "tool"}(${truncate(args, 160)})`);
    }
  }
  return { text, tools };
}

function normalizeRole(role: string): TimelineRole {
  return role === "user" ? "user" : role === "system" ? "system" : "assistant";
}

/**
 * Derive an ordered timeline of conversation + tool rows from the session
 * state. Mirrors the S7 chat-ui row logic but as a pure, testable function that
 * powers both the conversation pane and the tool timeline pane.
 */
export function deriveTimeline(
  messages: readonly MessageLike[],
  streamingMessage?: MessageLike | null,
): TimelineItem[] {
  const rows: TimelineItem[] = [];
  for (const m of messages) {
    const role = m.role ?? "?";
    if (role === "toolResult") {
      const name = m.toolName ?? "tool";
      rows.push({
        role: m.isError ? "tool-error" : "tool-result",
        text: `${name} \u2192 ${textOf(m.content)}`,
        streaming: false,
        tool: name,
      });
      continue;
    }
    const { text, tools } = partsOf(m.content);
    if (text.trim()) rows.push({ role: normalizeRole(role), text, streaming: false });
    for (const t of tools) rows.push({ role: "tool-call", text: t, streaming: false, tool: t });
  }
  if (streamingMessage) {
    const { text, tools } = partsOf(streamingMessage.content);
    if (text.trim() || tools.length === 0) {
      rows.push({ role: normalizeRole(streamingMessage.role ?? "assistant"), text, streaming: true });
    }
    for (const t of tools) rows.push({ role: "tool-call", text: t, streaming: true, tool: t });
  }
  return rows;
}

export const isConversationRole = (r: TimelineRole): boolean =>
  r === "user" || r === "assistant" || r === "system";
export const isToolRole = (r: TimelineRole): boolean =>
  r === "tool-call" || r === "tool-result" || r === "tool-error";

export function conversationItems(timeline: readonly TimelineItem[]): TimelineItem[] {
  return timeline.filter((i) => isConversationRole(i.role));
}
export function toolItems(timeline: readonly TimelineItem[]): TimelineItem[] {
  return timeline.filter((i) => isToolRole(i.role));
}

// --- VFS explorer helpers -------------------------------------------------

/** Structural shape of a VFS directory entry (subset of the SDK FileInfo). */
export interface DirEntryLike {
  name: string;
  kind: string;
  size?: number;
}

/** Sort entries: directories first, then symlinks, then files; alpha within. */
export function sortDirEntries<T extends DirEntryLike>(entries: readonly T[]): T[] {
  const rank = (k: string) => (k === "directory" ? 0 : k === "symlink" ? 1 : 2);
  return [...entries].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name),
  );
}

/** Human-friendly byte size. */
export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// --- Diff view for edits (S12 increment 2) ------------------------------

export type DiffLineType = "context" | "add" | "remove";
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * Line-level diff via a longest-common-subsequence walk. Pure + deterministic.
 * Empty text ⇒ no lines (so a fresh write diffs as all-add). Small edit/write
 * payloads only, so the O(n·m) DP is fine.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "remove", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "remove", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

export interface EditRecord {
  path: string;
  kind: "edit" | "write";
  oldText: string;
  newText: string;
}

/**
 * Extract file mutations from the transcript's tool calls so the shell can
 * render before/after diffs. Handles the S4 `write` tool ({path, content}) and
 * `edit` tool ({path, edits:[{oldText,newText}]}, plus the legacy top-level
 * {path, oldText, newText} form the edit tool still normalizes).
 */
export function deriveEdits(messages: readonly MessageLike[]): EditRecord[] {
  const records: EditRecord[] = [];
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: string; name?: string; arguments?: unknown };
      if (p.type !== "toolCall") continue;
      const args = (p.arguments ?? {}) as Record<string, unknown>;
      const filePath =
        typeof args.path === "string"
          ? args.path
          : typeof args.file_path === "string"
            ? args.file_path
            : "";
      if (!filePath) continue;
      if (p.name === "write" && typeof args.content === "string") {
        records.push({ path: filePath, kind: "write", oldText: "", newText: args.content });
      } else if (p.name === "edit") {
        const blocks = Array.isArray(args.edits)
          ? args.edits
          : typeof args.oldText === "string" && typeof args.newText === "string"
            ? [{ oldText: args.oldText, newText: args.newText }]
            : [];
        for (const block of blocks) {
          if (!block || typeof block !== "object") continue;
          const b = block as { oldText?: unknown; newText?: unknown };
          if (typeof b.oldText === "string" && typeof b.newText === "string") {
            records.push({ path: filePath, kind: "edit", oldText: b.oldText, newText: b.newText });
          }
        }
      }
    }
  }
  return records;
}
