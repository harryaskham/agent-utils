// pi-wasm js-shell — command-line runner (pi-wasm S10, bead bd-ef8f24).
//
// Executes a parsed CommandLine over the shared ExecutionEnv: threads stdin
// through `|` pipelines, applies `>`/`>>` stdout redirects, and honors
// `;`/`&&`/`||` connectors with normal short-circuit semantics. `cd` mutates the
// shell's own cwd (independent of env.cwd) so `cd sub && ls` works within one
// invocation. Never throws — a builtin fault becomes stderr + a nonzero exit.

import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import * as path from "../../vfs/posix-path";
import { BUILTINS } from "./coreutils";
import { parse, type Pipeline, type Redirect, type SimpleCommand } from "./parse";
import { type CommandIO, type CommandOutcome, fileErrorText, makeShellFs } from "./types";

export interface ShellState {
  /** Absolute working directory; mutated by `cd`. */
  cwd: string;
  env: Record<string, string>;
}

export interface RunHooks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommandLine(
  line: string,
  env: ExecutionEnv,
  state: ShellState,
  hooks: RunHooks = {},
): Promise<RunResult> {
  const parsed = parse(line);
  if (!parsed.ok) {
    const msg = `sh: ${parsed.error}\n`;
    hooks.onStderr?.(msg);
    return { stdout: "", stderr: msg, exitCode: 2 };
  }

  const fs = makeShellFs(env);
  let stdout = "";
  let stderr = "";
  let lastExit = 0;

  const emitStderr = (chunk: string) => {
    if (!chunk) return;
    stderr += chunk;
    hooks.onStderr?.(chunk);
  };
  const emitStdout = (chunk: string) => {
    if (!chunk) return;
    stdout += chunk;
    hooks.onStdout?.(chunk);
  };

  const runSimple = async (cmd: SimpleCommand, stdin: string): Promise<CommandOutcome> => {
    if (cmd.argv.length === 0) return { stdout: "", stderr: "", exitCode: 0 }; // redirect-only
    const name = cmd.argv[0];
    const builtin = BUILTINS[name];
    if (!builtin) return { stdout: "", stderr: `sh: ${name}: command not found\n`, exitCode: 127 };
    const io: CommandIO = { argv: cmd.argv, stdin, cwd: state.cwd, env: state.env, fs };
    try {
      return await builtin(io);
    } catch (error) {
      // Defensive: a builtin should never throw, but if one does, encode it.
      return { stdout: "", stderr: `sh: ${name}: ${(error as Error).message}\n`, exitCode: 1 };
    }
  };

  const applyRedirects = async (redirects: Redirect[], out: string): Promise<string | undefined> => {
    for (const r of redirects) {
      const abs = path.resolve(state.cwd, r.target);
      const res = r.op === ">>" ? await fs.appendFile(abs, out) : await fs.writeFile(abs, out);
      if (!res.ok) return `sh: ${r.target}: ${fileErrorText(res.error.code)}\n`;
    }
    return undefined;
  };

  const runPipeline = async (pipeline: Pipeline): Promise<void> => {
    let input = "";
    let pipeExit = 0;
    for (let i = 0; i < pipeline.commands.length; i += 1) {
      if (hooks.signal?.aborted) return;
      const cmd = pipeline.commands[i];
      const isLast = i === pipeline.commands.length - 1;
      const res = await runSimple(cmd, input);
      emitStderr(res.stderr);
      pipeExit = res.exitCode;
      if (res.newCwd) state.cwd = res.newCwd;
      let out = res.stdout;
      if (cmd.redirects.length > 0) {
        const rerr = await applyRedirects(cmd.redirects, out);
        if (rerr) {
          emitStderr(rerr);
          pipeExit = 1;
        }
        out = ""; // redirected: nothing flows downstream or to the terminal
      }
      if (isLast) emitStdout(out);
      else input = out;
    }
    lastExit = pipeExit;
  };

  const seq: Array<{ op: "start" | ";" | "&&" | "||"; pipeline: Pipeline }> = [
    { op: "start", pipeline: parsed.value.first },
    ...parsed.value.rest,
  ];
  for (const node of seq) {
    if (hooks.signal?.aborted) break;
    if (node.op === "&&" && lastExit !== 0) continue;
    if (node.op === "||" && lastExit === 0) continue;
    await runPipeline(node.pipeline);
  }

  return { stdout, stderr, exitCode: lastExit };
}
