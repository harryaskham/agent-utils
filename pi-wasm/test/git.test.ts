import { describe, expect, it } from "vitest";
import { createBrowserExecutionEnv } from "../src/vfs/browser-execution-env";
import { LightningFsVfs } from "../src/vfs/vfs";
import { createBrowserGit, createGitTools, type GitHttpClient } from "../src/git";

// Deterministic, network-free coverage for pi-wasm S5 (bd-3f7a4f):
//  - real git (init/add/commit/log/listFiles/checkout) over the shared VFS;
//  - the S2<->S5 integration: git and BrowserExecutionEnv see ONE filesystem;
//  - clone transport wiring (fs + http + CORS proxy) via an injected http stub.
// A real network clone is a browser/S8 check (see src/git/README.md).

function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

async function freshRepo() {
  const vfs = new LightningFsVfs(uniqueName("pi-wasm-git-test"), { wipe: true });
  // Same vfs handed to BOTH layers -> proves they share one IndexedDB store.
  const env = await createBrowserExecutionEnv({ vfs, cwd: "/work" });
  const git = createBrowserGit({ vfs, dir: "/work" });
  await git.init();
  return { vfs, env, git };
}

describe("BrowserGit over the shared VFS (pi-wasm S5)", () => {
  it("init/add/commit/log/listFiles round-trip; files written via the file layer are committed", async () => {
    const { env, git } = await freshRepo();

    // Write through the S2 file layer, then stage+commit through git — one store.
    await env.writeFile("/work/README.md", "# hello\n");
    await env.writeFile("/work/src/index.ts", "export const x = 1;\n");
    await git.add({ filepath: ["README.md", "src/index.ts"] });
    const sha = await git.commit({ message: "initial commit" });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const files = await git.listFiles();
    expect(files).toContain("README.md");
    expect(files).toContain("src/index.ts");

    const log = await git.log();
    expect(log).toHaveLength(1);
    expect(log[0].oid).toBe(sha);
    expect(log[0].message).toContain("initial commit");
    expect(log[0].author.name).toBe("pi-wasm");
    expect(typeof log[0].timestamp).toBe("number");

    const branch = await git.currentBranch();
    expect(branch).toBe("main");
  });

  it("checkout mutates the shared VFS and BrowserExecutionEnv observes it", async () => {
    const { env, git } = await freshRepo();

    await env.writeFile("/work/f.txt", "v1\n");
    await git.add({ filepath: "f.txt" });
    const c1 = await git.commit({ message: "c1" });

    await env.writeFile("/work/f.txt", "v2\n");
    await git.add({ filepath: "f.txt" });
    await git.commit({ message: "c2" });

    // Detached checkout of the first commit rewinds the working file...
    await git.checkout({ ref: c1, force: true });
    expect(await env.readTextFile("/work/f.txt")).toEqual({ ok: true, value: "v1\n" });

    // ...and returning to the branch restores the latest content.
    await git.checkout({ ref: "main", force: true });
    expect(await env.readTextFile("/work/f.txt")).toEqual({ ok: true, value: "v2\n" });
  });

  it("clone routes through the injected http client and applies the CORS proxy (no network)", async () => {
    const vfs = new LightningFsVfs(uniqueName("pi-wasm-clone-test"), { wipe: true });
    await createBrowserExecutionEnv({ vfs, cwd: "/work" }); // seed /work

    const requestedUrls: string[] = [];
    const stubHttp = {
      async request({ url }: { url: string }) {
        requestedUrls.push(url);
        throw new Error("stub-http: no network in tests");
      },
    } as unknown as GitHttpClient;

    const git = createBrowserGit({
      vfs,
      dir: "/work",
      http: stubHttp,
      corsProxy: "https://proxy.example",
    });

    await expect(
      git.clone({ url: "https://github.com/octocat/hello" }),
    ).rejects.toThrow();

    // The very first smart-http request must carry both the repo URL and proxy.
    expect(requestedUrls.length).toBeGreaterThan(0);
    expect(requestedUrls[0]).toContain("github.com/octocat/hello");
    expect(requestedUrls[0]).toContain("proxy.example");
  });
});

describe("createGitTools (pi-wasm S5)", () => {
  it("exposes the git_* tool set", async () => {
    const { git } = await freshRepo();
    const tools = createGitTools(git);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "git_checkout",
      "git_clone",
      "git_list_files",
      "git_log",
    ]);
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("git_list_files and git_log tools operate on the shared repo", async () => {
    const { env, git } = await freshRepo();
    await env.writeFile("/work/a.txt", "a\n");
    await git.add({ filepath: "a.txt" });
    await git.commit({ message: "add a" });

    const tools = createGitTools(git);
    const listTool = tools.find((t) => t.name === "git_list_files");
    const logTool = tools.find((t) => t.name === "git_log");
    expect(listTool && logTool).toBeTruthy();

    const listed = await listTool!.execute("call-1", {});
    expect(listed.content[0]?.type).toBe("text");
    expect((listed.details as { files: string[] }).files).toContain("a.txt");

    const logged = await logTool!.execute("call-2", {});
    const details = logged.details as { commits: Array<{ message: string }> };
    expect(details.commits[0]?.message).toContain("add a");
  });
});
