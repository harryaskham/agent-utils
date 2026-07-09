import { beforeEach, describe, expect, it } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBrowserExecutionEnv, type BrowserExecutionEnv } from "../src/vfs/browser-execution-env";
import { InMemoryVfs } from "./in-memory-vfs";
import {
  createBrowserFileTools,
  fileToolsSmoke,
} from "../src/tools/browser-tools";

// Drive the AgentTools directly (as the Agent loop would) over a fresh VFS.
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

describe("browser file tools (S4) over the VFS", () => {
  let env: BrowserExecutionEnv;
  let tools: Map<string, AgentTool>;

  beforeEach(async () => {
    env = await createBrowserExecutionEnv({ vfs: new InMemoryVfs(), cwd: "/work" });
    tools = new Map(createBrowserFileTools(env).map((t) => [t.name, t]));
  });

  it("exposes exactly read/write/edit/ls/grep/find and NO bash", () => {
    expect([...tools.keys()].sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
    expect(tools.has("bash")).toBe(false);
  });

  it("write then read round-trips (relative paths resolved against cwd)", async () => {
    const w = await tools.get("write")!.execute("1", { path: "notes/a.txt", content: "line1\nline2\n" });
    expect(textOf(w)).toContain("Successfully wrote");
    const r = await tools.get("read")!.execute("2", { path: "notes/a.txt" });
    expect(textOf(r)).toContain("line1\nline2");
  });

  it("read honours offset/limit and errors past EOF", async () => {
    await env.writeFile("/work/f.txt", "l1\nl2\nl3\nl4\n");
    const r = await tools.get("read")!.execute("1", { path: "/work/f.txt", offset: 2, limit: 2 });
    const t = textOf(r);
    expect(t).toContain("l2\nl3");
    expect(t).not.toContain("l1");
    await expect(tools.get("read")!.execute("2", { path: "/work/f.txt", offset: 999 })).rejects.toThrow(/beyond end of file/);
  });

  it("edit applies an exact, unique replacement and preserves line endings", async () => {
    await env.writeFile("/work/code.txt", "alpha\nbeta\ngamma\n");
    const e = await tools.get("edit")!.execute("1", {
      path: "/work/code.txt",
      edits: [{ oldText: "beta", newText: "BETA" }],
    });
    expect(textOf(e)).toBe("Successfully replaced 1 block(s) in /work/code.txt.");
    expect(await env.readTextFile("/work/code.txt")).toEqual({ ok: true, value: "alpha\nBETA\ngamma\n" });
  });

  it("edit rejects a non-unique oldText, a missing oldText, and a no-op", async () => {
    await env.writeFile("/work/dup.txt", "x\nx\ny\n");
    await expect(
      tools.get("edit")!.execute("1", { path: "/work/dup.txt", edits: [{ oldText: "x", newText: "z" }] }),
    ).rejects.toThrow(/must be unique/);
    await expect(
      tools.get("edit")!.execute("2", { path: "/work/dup.txt", edits: [{ oldText: "nope", newText: "z" }] }),
    ).rejects.toThrow(/Could not find the exact text/);
    await expect(
      tools.get("edit")!.execute("3", { path: "/work/dup.txt", edits: [{ oldText: "y", newText: "y" }] }),
    ).rejects.toThrow(/No changes made/);
  });

  it("edit applies multiple disjoint edits and rejects overlaps", async () => {
    await env.writeFile("/work/multi.txt", "one two three four\n");
    await tools.get("edit")!.execute("1", {
      path: "/work/multi.txt",
      edits: [
        { oldText: "one", newText: "1" },
        { oldText: "four", newText: "4" },
      ],
    });
    expect(await env.readTextFile("/work/multi.txt")).toEqual({ ok: true, value: "1 two three 4\n" });
    await env.writeFile("/work/ov.txt", "abcdef\n");
    await expect(
      tools.get("edit")!.execute("2", {
        path: "/work/ov.txt",
        edits: [
          { oldText: "abc", newText: "X" },
          { oldText: "cde", newText: "Y" },
        ],
      }),
    ).rejects.toThrow(/overlap/);
  });

  it("edit accepts legacy {oldText,newText} and stringified edits via prepareArguments", async () => {
    const edit = tools.get("edit")!;
    await env.writeFile("/work/legacy.txt", "foo\n");
    const prepared = edit.prepareArguments!({ path: "/work/legacy.txt", oldText: "foo", newText: "bar" });
    await edit.execute("1", prepared);
    expect(await env.readTextFile("/work/legacy.txt")).toEqual({ ok: true, value: "bar\n" });

    await env.writeFile("/work/stredits.txt", "cat\n");
    const prepared2 = edit.prepareArguments!({
      path: "/work/stredits.txt",
      edits: JSON.stringify([{ oldText: "cat", newText: "dog" }]),
    });
    await edit.execute("2", prepared2);
    expect(await env.readTextFile("/work/stredits.txt")).toEqual({ ok: true, value: "dog\n" });
  });

  it("ls lists sorted entries with dir suffixes and reports empty dirs", async () => {
    await env.writeFile("/work/proj/b.txt", "b");
    await env.writeFile("/work/proj/a.txt", "a");
    await env.createDir("/work/proj/zsub");
    const l = await tools.get("ls")!.execute("1", { path: "/work/proj" });
    expect(textOf(l)).toBe("a.txt\nb.txt\nzsub/");
    await env.createDir("/work/emptydir");
    const empty = await tools.get("ls")!.execute("2", { path: "/work/emptydir" });
    expect(textOf(empty)).toBe("(empty directory)");
  });

  it("grep finds matching lines with path:line and honours literal/ignoreCase/glob", async () => {
    await env.writeFile("/work/g/a.ts", "const x = 1;\nTODO: fix\n");
    await env.writeFile("/work/g/b.md", "todo later\n");
    const g = await tools.get("grep")!.execute("1", { pattern: "TODO", path: "/work/g" });
    expect(textOf(g)).toContain("a.ts:2:");
    expect(textOf(g)).toContain("TODO: fix");
    const ci = await tools.get("grep")!.execute("2", { pattern: "todo", path: "/work/g", ignoreCase: true });
    expect(textOf(ci)).toContain("a.ts:2:");
    expect(textOf(ci)).toContain("b.md:1:");
    const globbed = await tools.get("grep")!.execute("3", { pattern: "todo", path: "/work/g", ignoreCase: true, glob: "*.md" });
    expect(textOf(globbed)).toContain("b.md:1:");
    expect(textOf(globbed)).not.toContain("a.ts");
    const none = await tools.get("grep")!.execute("4", { pattern: "zzz", path: "/work/g" });
    expect(textOf(none)).toBe("No matches found");
  });

  it("find matches by glob and returns relative paths", async () => {
    await env.writeFile("/work/s/src/main.ts", "1");
    await env.writeFile("/work/s/src/util.ts", "2");
    await env.writeFile("/work/s/readme.md", "3");
    const f = await tools.get("find")!.execute("1", { pattern: "**/*.ts", path: "/work/s" });
    expect(textOf(f).split("\n").sort()).toEqual(["src/main.ts", "src/util.ts"]);
    const none = await tools.get("find")!.execute("2", { pattern: "**/*.rs", path: "/work/s" });
    expect(textOf(none)).toBe("No files found matching pattern");
  });

  it("fileToolsSmoke drives read+edit+write and confirms bash is blocked", async () => {
    const result = await fileToolsSmoke(env);
    expect(result.ok).toBe(true);
    expect(result.steps).toContain("edit applied exact replacement");
    expect(result.steps.some((s) => s.startsWith("bash blocked cleanly"))).toBe(true);
  });

  it("installs into the Agent (Path A): tools land on agent.state.tools", async () => {
    const agent = new Agent({ getApiKey: async () => undefined, initialState: { tools: createBrowserFileTools(env) } });
    const names = agent.state.tools.map((t) => t.name).sort();
    expect(names).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
  });
});
