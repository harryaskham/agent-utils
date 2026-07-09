// pi-wasm S5 — git exposed as browser-clean `AgentTool`s (bd-3f7a4f, epic
// bd-f76cee).
//
// The browser build bypasses the node-coupled `pi-coding-agent` barrel (so no
// `defineTool`); custom tools are plain `AgentTool` objects — name + description
// + typebox `parameters` + `execute` returning an `AgentToolResult` — passed
// into the Agent via `initialState.tools` / `AgentContext.tools`. Because these
// git tools drive the SAME shared VFS as the S4 file tools, a clone/checkout is
// immediately readable/editable by the rest of the loop.

import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { BrowserGit, CloneResult, LogEntry } from "./git";

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  const content: TextContent[] = [{ type: "text", text }];
  return { content, details };
}

/**
 * Erase a fully-typed tool to the runtime `AgentTool` list element type. Each
 * tool is authored with concrete parameter/detail generics (real type-safety on
 * `params` and `details`); this boundary helper keeps the returned array clean.
 */
function asAgentTool<P extends TSchema, D>(tool: AgentTool<P, D>): AgentTool {
  return tool as unknown as AgentTool;
}

const CloneParams = Type.Object({
  url: Type.String({ description: "Git remote URL to clone (https)." }),
  dir: Type.Optional(Type.String({ description: "Target directory in the VFS. Defaults to /work." })),
  ref: Type.Optional(Type.String({ description: "Branch, tag, or commit to check out after cloning." })),
  depth: Type.Optional(
    Type.Number({ description: "Shallow clone depth. Defaults to 1; use 0 for full history." }),
  ),
  singleBranch: Type.Optional(
    Type.Boolean({ description: "Fetch only the target branch. Defaults to true." }),
  ),
});

const CheckoutParams = Type.Object({
  ref: Type.String({ description: "Branch, tag, or commit to check out." }),
  dir: Type.Optional(Type.String({ description: "Repository directory in the VFS. Defaults to /work." })),
});

const ListFilesParams = Type.Object({
  dir: Type.Optional(Type.String({ description: "Repository directory in the VFS. Defaults to /work." })),
  ref: Type.Optional(Type.String({ description: "Ref to list files at. Defaults to the index/HEAD." })),
});

const LogParams = Type.Object({
  dir: Type.Optional(Type.String({ description: "Repository directory in the VFS. Defaults to /work." })),
  depth: Type.Optional(Type.Number({ description: "Maximum commits to return. Defaults to 20." })),
});

/**
 * Build the git tool set bound to a {@link BrowserGit}. Pass the returned array
 * into the Agent's `tools` (typically merged with the S4 file tools).
 */
export function createGitTools(repo: BrowserGit): AgentTool[] {
  const gitClone: AgentTool<typeof CloneParams, CloneResult> = {
    name: "git_clone",
    label: "Git clone",
    description:
      "Clone a git repository into the in-browser virtual filesystem so its files can be read and edited. Network fetch goes through a CORS git proxy.",
    parameters: CloneParams,
    async execute(_toolCallId, params) {
      const result = await repo.clone({
        url: params.url,
        dir: params.dir,
        ref: params.ref,
        depth: params.depth,
        singleBranch: params.singleBranch,
      });
      return textResult(
        `Cloned ${result.url} into ${result.dir} (${result.files.length} tracked file(s)).`,
        result,
      );
    },
  };

  const gitCheckout: AgentTool<typeof CheckoutParams, { dir: string; ref: string }> = {
    name: "git_checkout",
    label: "Git checkout",
    description: "Check out a branch, tag, or commit in a repository already present in the VFS.",
    parameters: CheckoutParams,
    async execute(_toolCallId, params) {
      const dir = params.dir ?? repo.dir;
      await repo.checkout({ ref: params.ref, dir: params.dir });
      return textResult(`Checked out ${params.ref} in ${dir}.`, { dir, ref: params.ref });
    },
  };

  const gitListFiles: AgentTool<typeof ListFilesParams, { dir: string; files: string[] }> = {
    name: "git_list_files",
    label: "Git list files",
    description: "List the tracked files of a repository in the VFS.",
    parameters: ListFilesParams,
    async execute(_toolCallId, params) {
      const dir = params.dir ?? repo.dir;
      const files = await repo.listFiles({ dir: params.dir, ref: params.ref });
      const listing = files.length ? files.join("\n") : "(no tracked files)";
      return textResult(`${files.length} tracked file(s) in ${dir}:\n${listing}`, { dir, files });
    },
  };

  const gitLog: AgentTool<typeof LogParams, { dir: string; commits: LogEntry[] }> = {
    name: "git_log",
    label: "Git log",
    description: "Show recent commit history of a repository in the VFS (newest first).",
    parameters: LogParams,
    async execute(_toolCallId, params) {
      const dir = params.dir ?? repo.dir;
      const commits = await repo.log({ dir: params.dir, depth: params.depth });
      const summary = commits.length
        ? commits
            .map((c) => `${c.oid.slice(0, 7)} ${c.message.split("\n")[0]} (${c.author.name})`)
            .join("\n")
        : "(no commits)";
      return textResult(`${commits.length} commit(s) in ${dir}:\n${summary}`, { dir, commits });
    },
  };

  return [
    asAgentTool(gitClone),
    asAgentTool(gitCheckout),
    asAgentTool(gitListFiles),
    asAgentTool(gitLog),
  ];
}
