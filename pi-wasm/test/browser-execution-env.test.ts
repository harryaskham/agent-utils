import { beforeEach, describe, expect, it } from "vitest";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import {
  BrowserExecutionEnv,
  createBrowserExecutionEnv,
} from "../src/vfs/browser-execution-env";
import { LightningFsVfs, type Vfs } from "../src/vfs/vfs";
import { InMemoryVfs } from "./in-memory-vfs";

// Run the full ExecutionEnv contract against two backends: a dependency-free
// in-memory Vfs (deterministic logic proof) and lightning-fs over fake-indexeddb
// (proves the fs methods work over a real IndexedDB backing store).
const backends: Array<{ name: string; make: () => Vfs }> = [
  { name: "InMemoryVfs", make: () => new InMemoryVfs() },
  {
    name: "LightningFsVfs(fake-indexeddb)",
    make: () => new LightningFsVfs(`pi-wasm-test-${Math.random().toString(36).slice(2)}`, { wipe: true }),
  },
];

describe.each(backends)("BrowserExecutionEnv over $name", ({ make }) => {
  let env: BrowserExecutionEnv;

  beforeEach(async () => {
    env = await createBrowserExecutionEnv({ vfs: make(), cwd: "/work" });
  });

  it("satisfies the ExecutionEnv interface (type + runtime)", () => {
    const asEnv: ExecutionEnv = env; // compile-time structural check
    expect(asEnv.cwd).toBe("/work");
    expect(typeof asEnv.exec).toBe("function");
  });

  it("seeds the base directory layout", async () => {
    const home = await env.exists("/home/.pi/agent");
    const work = await env.exists("/work");
    expect(home).toEqual({ ok: true, value: true });
    expect(work).toEqual({ ok: true, value: true });
  });

  it("round-trips text (write creates parent dirs)", async () => {
    const written = await env.writeFile("notes/todo.txt", "hello\nworld\n");
    expect(written.ok).toBe(true);
    const read = await env.readTextFile("notes/todo.txt");
    expect(read).toEqual({ ok: true, value: "hello\nworld\n" });
    // relative path resolved against cwd:
    const info = await env.fileInfo("/work/notes/todo.txt");
    expect(info.ok).toBe(true);
    if (info.ok) {
      expect(info.value.kind).toBe("file");
      expect(info.value.name).toBe("todo.txt");
      expect(info.value.size).toBe(new TextEncoder().encode("hello\nworld\n").length);
    }
  });

  it("round-trips binary", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await env.writeFile("/work/blob.bin", bytes);
    const read = await env.readBinaryFile("/work/blob.bin");
    expect(read.ok).toBe(true);
    if (read.ok) expect(Array.from(read.value)).toEqual([0, 1, 2, 250, 255]);
  });

  it("appendFile creates then appends", async () => {
    const created = await env.appendFile("log.txt", "a");
    expect(created.ok).toBe(true);
    await env.appendFile("log.txt", "b");
    await env.appendFile("log.txt", "c");
    const read = await env.readTextFile("log.txt");
    expect(read).toEqual({ ok: true, value: "abc" });
  });

  it("readTextLines: splits, drops final-newline empty, honours maxLines", async () => {
    await env.writeFile("multi.txt", "l1\nl2\nl3\n");
    const all = await env.readTextLines("multi.txt");
    expect(all).toEqual({ ok: true, value: ["l1", "l2", "l3"] });
    const capped = await env.readTextLines("multi.txt", { maxLines: 2 });
    expect(capped).toEqual({ ok: true, value: ["l1", "l2"] });
    const zero = await env.readTextLines("multi.txt", { maxLines: 0 });
    expect(zero).toEqual({ ok: true, value: [] });
  });

  it("readTextLines: CRLF normalized, no-trailing-newline kept, empty file is []", async () => {
    await env.writeFile("crlf.txt", "a\r\nb");
    expect(await env.readTextLines("crlf.txt")).toEqual({ ok: true, value: ["a", "b"] });
    await env.writeFile("empty.txt", "");
    expect(await env.readTextLines("empty.txt")).toEqual({ ok: true, value: [] });
  });

  it("listDir returns children with kinds", async () => {
    await env.writeFile("/work/dir/f1.txt", "1");
    await env.createDir("/work/dir/sub");
    const listed = await env.listDir("/work/dir");
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const byName = new Map(listed.value.map((i) => [i.name, i.kind]));
      expect(byName.get("f1.txt")).toBe("file");
      expect(byName.get("sub")).toBe("directory");
    }
  });

  it("exists: true / false / not error for missing", async () => {
    await env.writeFile("here.txt", "x");
    expect(await env.exists("here.txt")).toEqual({ ok: true, value: true });
    expect(await env.exists("nope.txt")).toEqual({ ok: true, value: false });
  });

  it("fileInfo on a missing path returns not_found", async () => {
    const info = await env.fileInfo("does/not/exist");
    expect(info.ok).toBe(false);
    if (!info.ok) expect(info.error.code).toBe("not_found");
  });

  it("createDir recursive builds the whole chain", async () => {
    const made = await env.createDir("/work/a/b/c", { recursive: true });
    expect(made.ok).toBe(true);
    expect(await env.exists("/work/a/b/c")).toEqual({ ok: true, value: true });
    expect(await env.exists("/work/a/b")).toEqual({ ok: true, value: true });
  });

  it("remove: file, recursive dir, non-recursive non-empty errors, force-missing ok", async () => {
    await env.writeFile("/work/rm/f.txt", "x");
    const rmFile = await env.remove("/work/rm/f.txt");
    expect(rmFile.ok).toBe(true);
    expect(await env.exists("/work/rm/f.txt")).toEqual({ ok: true, value: false });

    await env.writeFile("/work/tree/a/b.txt", "y");
    const nonRecursive = await env.remove("/work/tree");
    expect(nonRecursive.ok).toBe(false); // ENOTEMPTY-ish
    const recursive = await env.remove("/work/tree", { recursive: true });
    expect(recursive.ok).toBe(true);
    expect(await env.exists("/work/tree")).toEqual({ ok: true, value: false });

    const forceMissing = await env.remove("/work/ghost", { force: true });
    expect(forceMissing.ok).toBe(true);
  });

  it("canonicalPath: existing normalizes, missing is not_found", async () => {
    await env.writeFile("/work/c/f.txt", "x");
    const canon = await env.canonicalPath("/work/c/../c/f.txt");
    expect(canon).toEqual({ ok: true, value: "/work/c/f.txt" });
    const missing = await env.canonicalPath("/work/c/missing");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("not_found");
  });

  it("createTempDir / createTempFile create real, distinct entries", async () => {
    const d1 = await env.createTempDir();
    const d2 = await env.createTempDir();
    expect(d1.ok && d2.ok).toBe(true);
    if (d1.ok && d2.ok) {
      expect(d1.value).not.toBe(d2.value);
      expect(await env.exists(d1.value)).toEqual({ ok: true, value: true });
    }
    const f = await env.createTempFile({ prefix: "pre-", suffix: ".txt" });
    expect(f.ok).toBe(true);
    if (f.ok) {
      expect(f.value.endsWith(".txt")).toBe(true);
      expect(await env.exists(f.value)).toEqual({ ok: true, value: true });
    }
  });

  it("absolutePath / joinPath", async () => {
    expect(await env.absolutePath("rel/x")).toEqual({ ok: true, value: "/work/rel/x" });
    expect(await env.absolutePath("/abs/y")).toEqual({ ok: true, value: "/abs/y" });
    expect(await env.joinPath(["/a", "b", "..", "c"])).toEqual({ ok: true, value: "/a/c" });
  });

  it("exec is unavailable (no-bash MVP) and reports shell_unavailable", async () => {
    const result = await env.exec("echo hi");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("shell_unavailable");
  });
});
