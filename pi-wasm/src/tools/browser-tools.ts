// Browser file tools for the Pi agent (pi-wasm S4, bead bd-a30bc2).
//
// The SDK's file tools (read/write/edit/ls/grep/find/bash) live ONLY in the
// node-coupled `@earendil-works/pi-coding-agent` barrel (`core/tools/*`, which
// import node:fs/child_process). Per the S4 recon (scratch: pi-wasm:s4-tools-recon)
// we author FRESH `AgentTool` objects whose `execute` closes over the S2
// `BrowserExecutionEnv` (bd-56130e) — zero node deps. bash is EXCLUDED (the env's
// exec() is the no-bash MVP seam; a real shell lands in S10).
//
// Contract (verified against pi-agent-core dist .d.ts): `AgentTool` =
// { name, description, parameters (typebox TSchema), label, prepareArguments?,
// execute, executionMode? }. `execute(toolCallId, params, signal?, onUpdate?)`
// returns `AgentToolResult` = { content: (TextContent|ImageContent)[], details }
// and MUST THROW on failure (do not encode errors in content). The env methods
// return `Result` (never throw), so each tool maps Result-err → throw via
// `unwrap`. Install via `new Agent({ initialState: { tools: createBrowserFileTools(env) } })`.

import { Type } from "typebox";
import type { AgentTool, ExecutionEnv, FileError, Result } from "@earendil-works/pi-agent-core";
import * as path from "../vfs/posix-path";
import {
  applyEdits,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type EditReplacement,
} from "./edit-core";
import { matchesGlob } from "./glob";

const DEFAULT_READ_MAX_LINES = 2000;
const DEFAULT_LS_LIMIT = 500;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const GREP_MAX_LINE_LENGTH = 250;

/** Map an env `Result` (err-as-value) onto a throw, as AgentTool.execute requires. */
function unwrap<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateLine(line: string): string {
  return line.length > GREP_MAX_LINE_LENGTH ? line.slice(0, GREP_MAX_LINE_LENGTH) + "…" : line;
}

function relativeTo(root: string, file: string): string {
  if (file === root) return path.basename(file);
  if (root === "/") return file.replace(/^\//, "");
  if (file.startsWith(root + "/")) return file.slice(root.length + 1);
  return file;
}

/** Collect file paths under `root` (or `[root]` if it is a file). Bounded. */
async function collectFiles(env: ExecutionEnv, root: string, cap = 5000): Promise<string[]> {
  const info = await env.fileInfo(root);
  if (info.ok && info.value.kind === "file") return [root];
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && files.length < cap) {
    const dir = stack.pop()!;
    const listed = await env.listDir(dir);
    if (!listed.ok) continue;
    for (const entry of listed.value) {
      if (entry.kind === "directory") stack.push(entry.path);
      else if (entry.kind === "file") files.push(entry.path);
    }
  }
  return files;
}

function prepareEditArguments(input: unknown): any {
  if (!input || typeof input !== "object") return input;
  const args = input as Record<string, unknown>;
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      /* leave as-is; validateEditInput will reject */
    }
  }
  if (typeof args.oldText !== "string" || typeof args.newText !== "string") return args;
  const edits = Array.isArray(args.edits) ? [...(args.edits as unknown[])] : [];
  edits.push({ oldText: args.oldText, newText: args.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = args;
  return { ...rest, edits };
}

export function createBrowserReadTool(env: ExecutionEnv): AgentTool {
  const parameters = Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  });
  return {
    name: "read",
    label: "Read",
    description:
      "Read the contents of a text file from the virtual filesystem. Use offset (1-indexed start line) and limit for large files.",
    parameters,
    execute: async (_toolCallId, params) => {
      const { path: p, offset, limit } = params as { path: string; offset?: number; limit?: number };
      const abs = unwrap(await env.absolutePath(p));
      const content = unwrap(await env.readTextFile(abs));
      const allLines = content.split("\n");
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
      }
      const endByLimit = limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length;
      const end = Math.min(endByLimit, startLine + DEFAULT_READ_MAX_LINES);
      const selected = allLines.slice(startLine, end);
      let text = selected.join("\n");
      const shownEnd = startLine + selected.length;
      if (shownEnd < allLines.length) {
        const remaining = allLines.length - shownEnd;
        text += `\n\n[Showing lines ${startLine + 1}-${shownEnd} of ${allLines.length}. ${remaining} more line(s); use offset=${shownEnd + 1} to continue.]`;
      }
      return { content: [{ type: "text", text }], details: { path: abs, totalLines: allLines.length } };
    },
  };
}

export function createBrowserWriteTool(env: ExecutionEnv): AgentTool {
  const parameters = Type.Object({
    path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
    content: Type.String({ description: "Content to write to the file" }),
  });
  return {
    name: "write",
    label: "Write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters,
    execute: async (_toolCallId, params) => {
      const { path: p, content } = params as { path: string; content: string };
      const abs = unwrap(await env.absolutePath(p));
      unwrap(await env.writeFile(abs, content));
      return {
        content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${p}` }],
        details: undefined,
      };
    },
  };
}

export function createBrowserEditTool(env: ExecutionEnv): AgentTool {
  const replacement = Type.Object(
    {
      oldText: Type.String({
        description:
          "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
      }),
      newText: Type.String({ description: "Replacement text for this targeted edit." }),
    },
    { additionalProperties: false },
  );
  const parameters = Type.Object(
    {
      path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
      edits: Type.Array(replacement, {
        description:
          "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.",
      }),
    },
    { additionalProperties: false },
  );
  return {
    name: "edit",
    label: "Edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file.",
    parameters,
    prepareArguments: prepareEditArguments,
    execute: async (_toolCallId, params) => {
      const input = params as { path: string; edits: EditReplacement[] };
      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
      }
      const abs = unwrap(await env.absolutePath(input.path));
      const readResult = await env.readTextFile(abs);
      if (!readResult.ok) {
        throw new Error(`Could not edit file: ${input.path}. ${readResult.error.code}.`);
      }
      const { bom, text: content } = stripBom(readResult.value);
      const ending = detectLineEnding(content);
      const normalized = normalizeToLF(content);
      const newContent = applyEdits(normalized, input.edits, input.path);
      const finalContent = bom + restoreLineEndings(newContent, ending);
      unwrap(await env.writeFile(abs, finalContent));
      return {
        content: [{ type: "text", text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.` }],
        details: { path: abs, edits: input.edits.length },
      };
    },
  };
}

export function createBrowserLsTool(env: ExecutionEnv): AgentTool {
  const parameters = Type.Object({
    path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
  });
  return {
    name: "ls",
    label: "List",
    description:
      "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles.",
    parameters,
    execute: async (_toolCallId, params) => {
      const { path: p, limit } = params as { path?: string; limit?: number };
      const dir = unwrap(await env.absolutePath(p ?? env.cwd));
      const entries = unwrap(await env.listDir(dir));
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
      }
      const names = entries
        .map((entry) => (entry.kind === "directory" ? entry.name + "/" : entry.name))
        .sort((a, b) => a.localeCompare(b));
      const cap = limit ?? DEFAULT_LS_LIMIT;
      const shown = names.slice(0, cap);
      let text = shown.join("\n");
      if (names.length > cap) {
        text += `\n... (${names.length - cap} more entries, ${names.length} total; raise limit to see more)`;
      }
      return { content: [{ type: "text", text }], details: { entries: names.length } };
    },
  };
}

export function createBrowserGrepTool(env: ExecutionEnv): AgentTool {
  const parameters = Type.Object({
    pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
    glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
    context: Type.Optional(Type.Number({ description: "Lines of context before and after each match (default: 0)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
  });
  return {
    name: "grep",
    label: "Grep",
    description:
      "Search file contents for a pattern across the virtual filesystem. Returns matching lines with file paths and line numbers.",
    parameters,
    execute: async (_toolCallId, params) => {
      const {
        pattern,
        path: searchPath,
        glob,
        ignoreCase,
        literal,
        context,
        limit,
      } = params as {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
      };
      const root = unwrap(await env.absolutePath(searchPath ?? env.cwd));
      const flags = ignoreCase ? "i" : "";
      const regex = literal ? new RegExp(escapeRegExp(pattern), flags) : new RegExp(pattern, flags);
      const max = limit ?? DEFAULT_GREP_LIMIT;
      const ctx = Math.max(0, context ?? 0);
      const files = await collectFiles(env, root);
      const out: string[] = [];
      let matches = 0;
      for (const file of files) {
        const rel = relativeTo(root, file);
        if (glob && !matchesGlob(glob, rel, { ignoreCase }) && !matchesGlob(glob, path.basename(file), { ignoreCase })) {
          continue;
        }
        const readResult = await env.readTextFile(file);
        if (!readResult.ok) continue; // skip unreadable/binary
        const lines = readResult.value.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i]!)) continue;
          for (let c = Math.max(0, i - ctx); c < i; c++) out.push(`${rel}-${c + 1}- ${truncateLine(lines[c]!)}`);
          out.push(`${rel}:${i + 1}: ${truncateLine(lines[i]!)}`);
          for (let c = i + 1; c <= Math.min(lines.length - 1, i + ctx); c++) {
            out.push(`${rel}-${c + 1}- ${truncateLine(lines[c]!)}`);
          }
          matches++;
          if (matches >= max) break;
        }
        if (matches >= max) break;
      }
      if (matches === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
      let text = out.join("\n");
      if (matches >= max) text += `\n... (truncated at ${max} matches; raise limit to see more)`;
      return { content: [{ type: "text", text }], details: { matches } };
    },
  };
}

export function createBrowserFindTool(env: ExecutionEnv): AgentTool {
  const parameters = Type.Object({
    pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json'" }),
    path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
  });
  return {
    name: "find",
    label: "Find",
    description: "Search for files by glob pattern. Returns matching file paths relative to the search directory.",
    parameters,
    execute: async (_toolCallId, params) => {
      const { pattern, path: searchPath, limit } = params as { pattern: string; path?: string; limit?: number };
      const root = unwrap(await env.absolutePath(searchPath ?? env.cwd));
      const files = await collectFiles(env, root);
      const max = limit ?? DEFAULT_FIND_LIMIT;
      const matches: string[] = [];
      for (const file of files) {
        const rel = relativeTo(root, file);
        if (matchesGlob(pattern, rel) || matchesGlob(pattern, path.basename(file))) {
          matches.push(rel);
          if (matches.length >= max) break;
        }
      }
      if (matches.length === 0) {
        return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
      }
      matches.sort((a, b) => a.localeCompare(b));
      return { content: [{ type: "text", text: matches.join("\n") }], details: { matches: matches.length } };
    },
  };
}

/**
 * The full browser file-tool set for the Pi agent — read/write/edit/ls/grep/find
 * over the S2 ExecutionEnv. bash is intentionally EXCLUDED (no node:child_process
 * in the browser; env.exec() is the no-bash MVP seam). Install into the Agent:
 * `new Agent({ initialState: { tools: createBrowserFileTools(env) } })`.
 */
export function createBrowserFileTools(env: ExecutionEnv): AgentTool[] {
  return [
    createBrowserReadTool(env),
    createBrowserWriteTool(env),
    createBrowserEditTool(env),
    createBrowserLsTool(env),
    createBrowserGrepTool(env),
    createBrowserFindTool(env),
  ];
}

/**
 * Reusable acceptance check (bd-a30bc2; reused by the S8 Playwright harness):
 * drives read + edit + write over the VFS via the actual AgentTools and confirms
 * bash is blocked cleanly. Returns a structured result rather than throwing so a
 * page/harness can render it (e.g. window.__PI_WASM_S4__).
 */
export async function fileToolsSmoke(
  env: ExecutionEnv,
): Promise<{ ok: boolean; steps: string[]; error?: string }> {
  const steps: string[] = [];
  try {
    const tools = new Map(createBrowserFileTools(env).map((tool) => [tool.name, tool]));
    const read = tools.get("read")!;
    const write = tools.get("write")!;
    const edit = tools.get("edit")!;

    unwrap(await env.writeFile("/work/smoke/greeting.txt", "hello world\n"));
    steps.push("seeded /work/smoke/greeting.txt");

    const readResult = await read.execute("t-read", { path: "/work/smoke/greeting.txt" });
    const readText = readResult.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    if (!readText.includes("hello world")) throw new Error("read did not return the seeded content");
    steps.push("read returned seeded content");

    await edit.execute("t-edit", {
      path: "/work/smoke/greeting.txt",
      edits: [{ oldText: "world", newText: "pi-wasm" }],
    });
    const edited = unwrap(await env.readTextFile("/work/smoke/greeting.txt"));
    if (edited !== "hello pi-wasm\n") throw new Error(`edit produced unexpected content: ${JSON.stringify(edited)}`);
    steps.push("edit applied exact replacement");

    await write.execute("t-write", { path: "/work/smoke/new.txt", content: "created in the browser\n" });
    const created = unwrap(await env.readTextFile("/work/smoke/new.txt"));
    if (created !== "created in the browser\n") throw new Error("write did not create the new file");
    steps.push("write created a new file");

    const exec = await env.exec("echo hi");
    if (exec.ok) throw new Error("exec should be unavailable in the no-bash MVP");
    steps.push(`bash blocked cleanly (${exec.error.code})`);

    return { ok: true, steps };
  } catch (error) {
    return { ok: false, steps, error: error instanceof Error ? error.message : String(error) };
  }
}
