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
