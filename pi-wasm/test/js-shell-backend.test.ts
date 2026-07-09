import { describe, expect, it } from "vitest";
import { JsShellBackend, createJsShellBackend } from "../src/exec/js-shell-backend";
import { createBrowserExecutionEnv, type BrowserExecutionEnv } from "../src/vfs/browser-execution-env";
import { InMemoryVfs } from "./in-memory-vfs";

async function makeShell(): Promise<BrowserExecutionEnv> {
  const env = await createBrowserExecutionEnv({ vfs: new InMemoryVfs(), cwd: "/work" });
  env.setExecBackend(new JsShellBackend(env));
  return env;
}

/** Run a command through env.exec (the real S13a delegation path) and unwrap. */
async function run(env: BrowserExecutionEnv, command: string) {
  const r = await env.exec(command);
  if (!r.ok) throw new Error(`unexpected ExecutionError: ${r.error.code}`);
  return r.value;
}

describe("JsShellBackend — identity + wiring (S10, bd-ef8f24)", () => {
  it("has id 'js-shell' and is always available", () => {
    const env = { cwd: "/work" } as unknown as Parameters<typeof createJsShellBackend>[0];
    const backend = createJsShellBackend(env);
    expect(backend.id).toBe("js-shell");
    expect(backend.available).toBe(true);
  });

  it("lights up the bash path: env.exec delegates to the shell", async () => {
    const env = await makeShell();
    const r = await run(env, "echo hi");
    expect(r).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 });
  });
});

describe("JsShellBackend — coreutils over the shared VFS", () => {
  it("echo, echo -n, pwd", async () => {
    const env = await makeShell();
    expect((await run(env, "echo hello world")).stdout).toBe("hello world\n");
    expect((await run(env, "echo -n hi")).stdout).toBe("hi");
    expect((await run(env, "pwd")).stdout).toBe("/work\n");
  });

  it("cat reads files the S4 tools wrote (same tree), errors on missing", async () => {
    const env = await makeShell();
    await env.writeFile("/work/hello.txt", "hello world\n");
    expect((await run(env, "cat hello.txt")).stdout).toBe("hello world\n");
    expect((await run(env, "cat /work/hello.txt")).stdout).toBe("hello world\n");
    const miss = await run(env, "cat nope.txt");
    expect(miss.exitCode).toBe(1);
    expect(miss.stderr).toContain("cat: nope.txt: No such file or directory");
  });

  it("ls: sorted names, -a adds . .., -l long form, missing path exits 2", async () => {
    const env = await makeShell();
    await env.writeFile("/work/b.txt", "b");
    await env.writeFile("/work/a.txt", "aa");
    await env.createDir("/work/sub");
    expect((await run(env, "ls")).stdout).toBe("a.txt\nb.txt\nsub\n");
    const la = await run(env, "ls -la");
    expect(la.stdout).toContain("drwxr-xr-x 0 .\n");
    expect(la.stdout).toContain("-rw-r--r-- 2 a.txt");
    expect(la.stdout).toContain("drwxr-xr-x 0 sub");
    const miss = await run(env, "ls /nope");
    expect(miss.exitCode).toBe(2);
    expect(miss.stderr).toContain("ls: cannot access '/nope': No such file or directory");
  });

  it("mkdir -p, then the new dir is visible to ls + the file tools", async () => {
    const env = await makeShell();
    expect((await run(env, "mkdir -p a/b/c")).exitCode).toBe(0);
    expect((await run(env, "ls a/b")).stdout).toBe("c\n");
    // The S4 tools see the shell-created dir.
    const info = await env.fileInfo("/work/a/b/c");
    expect(info.ok && info.value.kind).toBe("directory");
  });

  it("rm: force-missing is 0, missing is 1, dir needs -r", async () => {
    const env = await makeShell();
    await env.writeFile("/work/f.txt", "x");
    await env.createDir("/work/d");
    expect((await run(env, "rm f.txt")).exitCode).toBe(0);
    expect((await env.exists("/work/f.txt")).ok && (await env.exists("/work/f.txt"))).toBeTruthy();
    expect((await run(env, "rm nope")).exitCode).toBe(1);
    expect((await run(env, "rm -f nope")).exitCode).toBe(0);
    expect((await run(env, "rm d")).exitCode).toBe(1); // is a directory
    expect((await run(env, "rm -r d")).exitCode).toBe(0);
  });

  it("head/tail/wc/grep", async () => {
    const env = await makeShell();
    await env.writeFile("/work/lines.txt", "one\ntwo\nthree\nfour\n");
    expect((await run(env, "head -n 2 lines.txt")).stdout).toBe("one\ntwo\n");
    expect((await run(env, "tail -n 1 lines.txt")).stdout).toBe("four\n");
    expect((await run(env, "wc -l lines.txt")).stdout).toBe("4 lines.txt\n");
    const g = await run(env, "grep t lines.txt");
    expect(g.stdout).toBe("two\nthree\n");
    expect(g.exitCode).toBe(0);
    const gv = await run(env, "grep -v t lines.txt");
    expect(gv.stdout).toBe("one\nfour\n");
    expect((await run(env, "grep zzz lines.txt")).exitCode).toBe(1);
  });
});

describe("JsShellBackend — pipelines, redirects, connectors", () => {
  it("pipes stdin through the pipeline", async () => {
    const env = await makeShell();
    await env.writeFile("/work/data.txt", "apple\nbanana\navocado\n");
    expect((await run(env, "cat data.txt | grep a | wc -l")).stdout).toBe("3\n");
    expect((await run(env, "echo hi | cat")).stdout).toBe("hi\n");
  });

  it("> writes and >> appends; the file tools read the shell's writes", async () => {
    const env = await makeShell();
    expect((await run(env, "echo one > out.txt")).exitCode).toBe(0);
    expect((await run(env, "echo two >> out.txt")).exitCode).toBe(0);
    const read = await env.readTextFile("/work/out.txt");
    expect(read.ok && read.value).toBe("one\ntwo\n");
    // Redirect swallows stdout (nothing flows to the terminal).
    expect((await run(env, "echo hidden > out.txt")).stdout).toBe("");
  });

  it("&& / || / ; short-circuit on exit code", async () => {
    const env = await makeShell();
    expect((await run(env, "true && echo yes")).stdout).toBe("yes\n");
    expect((await run(env, "false && echo no")).stdout).toBe("");
    expect((await run(env, "false || echo recovered")).stdout).toBe("recovered\n");
    expect((await run(env, "true || echo skip")).stdout).toBe("");
    expect((await run(env, "echo a ; echo b")).stdout).toBe("a\nb\n");
  });

  it("cd mutates the working dir within one invocation (S10 acceptance shape)", async () => {
    const env = await makeShell();
    await env.createDir("/work/proj");
    await env.writeFile("/work/proj/readme", "hi\n");
    expect((await run(env, "cd proj && pwd")).stdout).toBe("/work/proj\n");
    // Acceptance: `ls -la /work && cat file`.
    const acc = await run(env, "ls -la /work && cat proj/readme");
    expect(acc.exitCode).toBe(0);
    expect(acc.stdout).toContain("proj");
    expect(acc.stdout).toContain("hi\n");
    expect((await run(env, "cd nope")).exitCode).toBe(1);
  });
});

describe("JsShellBackend — contract (never throw, unknown cmd, abort)", () => {
  it("unknown command → exitCode 127, never rejects", async () => {
    const env = await makeShell();
    const r = await run(env, "definitelynotacommand");
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toContain("command not found");
  });

  it("a failing command is ok:true with a nonzero exit (not an ExecutionError)", async () => {
    const env = await makeShell();
    const r = await env.exec("cat /does/not/exist");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.exitCode).toBe(1);
  });

  it("a pre-aborted signal returns ExecutionError('aborted')", async () => {
    const env = await makeShell();
    const backend = env.getExecBackend()!;
    const controller = new AbortController();
    controller.abort();
    const r = await backend.exec("echo hi", { cwd: "/work", abortSignal: controller.signal });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("aborted");
  });

  it("streams stdout/stderr via callbacks", async () => {
    const env = await makeShell();
    const backend = env.getExecBackend()!;
    let out = "";
    let errs = "";
    await backend.exec("echo streamed", {
      cwd: "/work",
      onStdout: (c) => (out += c),
      onStderr: (c) => (errs += c),
    });
    expect(out).toBe("streamed\n");
    await backend.exec("nope-cmd", { cwd: "/work", onStderr: (c) => (errs += c) });
    expect(errs).toContain("command not found");
  });
});
