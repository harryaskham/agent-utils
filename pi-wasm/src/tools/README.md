# pi-wasm browser file tools (S4 — bead bd-a30bc2)

The Pi agent's `read` / `write` / `edit` / `ls` / `grep` / `find` tools,
reimplemented as fresh `AgentTool` objects over the S2 `BrowserExecutionEnv`
(`../vfs`). **bash is excluded** — there is no `node:child_process` in the
browser; `env.exec()` is the no-bash MVP seam (a real shell backend lands in
S10). Zero node builtins.

## Why fresh tools (not the SDK's)

The SDK's file tools live only in the node-coupled `@earendil-works/pi-coding-agent`
barrel (`core/tools/*`, which import `node:fs`). Per the S1/S4 recon we build on
the import-clean `Agent` (Path A) and author tools whose `execute` closes over
the injected `ExecutionEnv`. `Agent`'s constructor takes no env, so the tools are
the only thing that touch the filesystem.

## Contract

`AgentTool` = `{ name, description, parameters (typebox), label, prepareArguments?, execute }`.
`execute(toolCallId, params, signal?, onUpdate?)` returns
`{ content: [{ type: "text", text }], details }` and **throws on failure**. The
env methods return `Result` (never throw), so each tool maps `Result`-err → throw
via `unwrap`. `edit` uses the ported exact/fuzzy replacement core (`edit-core.ts`)
with the SDK's uniqueness / overlap / not-found / no-op error messages.

## Usage (installs into the Agent — Path A)

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { createBrowserExecutionEnv } from "../vfs";
import { createBrowserFileTools } from "./";

const env = await createBrowserExecutionEnv({ cwd: "/work" });
const agent = new Agent({
  getApiKey,                 // S6 settings screen
  streamFn,                  // S3 pi-ai provider stream
  initialState: { tools: createBrowserFileTools(env), systemPrompt, model },
});
```

`fileToolsSmoke(env)` is a reusable read→edit→write acceptance check (also
asserts bash is blocked) for the S7 app shell / S8 Playwright harness to surface
(e.g. `window.__PI_WASM_S4__`).

## Tests

`npm test` covers write/read round-trips, offset/limit + EOF, edit
uniqueness/overlap/no-op/legacy-args, ls sorting + empty dirs, grep
literal/ignoreCase/glob, find globbing, the smoke, and installing the tool set
into a real `Agent` — all over the in-memory VFS (backend-independent).
