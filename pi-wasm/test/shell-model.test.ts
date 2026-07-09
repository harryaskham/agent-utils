import { describe, it, expect } from "vitest";
import {
  deriveTimeline,
  conversationItems,
  toolItems,
  sortDirEntries,
  formatBytes,
  truncate,
  diffLines,
  deriveEdits,
  type MessageLike,
} from "../src/shell/model";

describe("S12 shell model — deriveTimeline", () => {
  it("renders user + assistant text rows", () => {
    const msgs: MessageLike[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ];
    const tl = deriveTimeline(msgs);
    expect(tl).toEqual([
      { role: "user", text: "hello", streaming: false },
      { role: "assistant", text: "hi there", streaming: false },
    ]);
  });

  it("emits a tool-call row for a toolCall content block", () => {
    const msgs: MessageLike[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "writing" },
          { type: "toolCall", name: "write", arguments: { path: "/work/a.txt" } },
        ],
      },
    ];
    const tl = deriveTimeline(msgs);
    expect(tl[0]).toEqual({ role: "assistant", text: "writing", streaming: false });
    expect(tl[1].role).toBe("tool-call");
    expect(tl[1].text).toContain("write(");
    expect(tl[1].text).toContain("/work/a.txt");
  });

  it("maps toolResult messages to tool-result / tool-error rows", () => {
    const ok: MessageLike[] = [{ role: "toolResult", toolName: "read", content: "file contents" }];
    expect(deriveTimeline(ok)[0]).toMatchObject({ role: "tool-result", tool: "read" });
    const bad: MessageLike[] = [
      { role: "toolResult", toolName: "read", isError: true, content: "ENOENT" },
    ];
    expect(deriveTimeline(bad)[0].role).toBe("tool-error");
  });

  it("includes a streaming row flagged streaming=true", () => {
    const tl = deriveTimeline([], { role: "assistant", content: [{ type: "text", text: "typ" }] });
    expect(tl).toEqual([{ role: "assistant", text: "typ", streaming: true }]);
  });

  it("splits into conversation vs tool items", () => {
    const msgs: MessageLike[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "toolCall", name: "ls", arguments: {} }] },
      { role: "toolResult", toolName: "ls", content: "a\nb" },
    ];
    const tl = deriveTimeline(msgs);
    expect(conversationItems(tl).map((i) => i.role)).toEqual(["user"]);
    expect(toolItems(tl).map((i) => i.role)).toEqual(["tool-call", "tool-result"]);
  });
});

describe("S12 shell model — VFS helpers", () => {
  it("sorts directories before symlinks before files, alpha within", () => {
    const sorted = sortDirEntries([
      { name: "z.txt", kind: "file" },
      { name: "src", kind: "directory" },
      { name: "a.txt", kind: "file" },
      { name: "link", kind: "symlink" },
      { name: "abc", kind: "directory" },
    ]);
    expect(sorted.map((e) => e.name)).toEqual(["abc", "src", "link", "a.txt", "z.txt"]);
  });

  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(-5)).toBe("");
  });

  it("truncates long strings with an ellipsis", () => {
    expect(truncate("abcdef", 3)).toBe("abc\u2026");
    expect(truncate("ab", 3)).toBe("ab");
  });
});

describe("S12 shell model — diffLines", () => {
  it("diffs a fresh write as all-add", () => {
    expect(diffLines("", "a\nb")).toEqual([
      { type: "add", text: "a" },
      { type: "add", text: "b" },
    ]);
  });

  it("keeps context and marks a changed middle line", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "B" },
      { type: "context", text: "c" },
    ]);
  });

  it("handles pure insertion and pure deletion", () => {
    expect(diffLines("a\nc", "a\nb\nc")).toEqual([
      { type: "context", text: "a" },
      { type: "add", text: "b" },
      { type: "context", text: "c" },
    ]);
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "context", text: "c" },
    ]);
  });

  it("returns empty for identical / both-empty", () => {
    expect(diffLines("x", "x")).toEqual([{ type: "context", text: "x" }]);
    expect(diffLines("", "")).toEqual([]);
  });
});

describe("S12 shell model — deriveEdits", () => {
  it("extracts a write as an all-new record", () => {
    const msgs: MessageLike[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "write", arguments: { path: "/work/a.txt", content: "hello" } }],
      },
    ];
    expect(deriveEdits(msgs)).toEqual([
      { path: "/work/a.txt", kind: "write", oldText: "", newText: "hello" },
    ]);
  });

  it("extracts edit blocks (edits[] form)", () => {
    const msgs: MessageLike[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "edit",
            arguments: {
              path: "/work/a.txt",
              edits: [
                { oldText: "foo", newText: "bar" },
                { oldText: "x", newText: "y" },
              ],
            },
          },
        ],
      },
    ];
    expect(deriveEdits(msgs)).toEqual([
      { path: "/work/a.txt", kind: "edit", oldText: "foo", newText: "bar" },
      { path: "/work/a.txt", kind: "edit", oldText: "x", newText: "y" },
    ]);
  });

  it("extracts the legacy top-level edit form and ignores non-mutating tools", () => {
    const msgs: MessageLike[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "edit", arguments: { path: "/work/a.txt", oldText: "a", newText: "b" } },
          { type: "toolCall", name: "read", arguments: { path: "/work/a.txt" } },
          { type: "text", text: "done" },
        ],
      },
    ];
    expect(deriveEdits(msgs)).toEqual([
      { path: "/work/a.txt", kind: "edit", oldText: "a", newText: "b" },
    ]);
  });
});
