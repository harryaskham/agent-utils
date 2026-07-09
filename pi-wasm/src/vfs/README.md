# pi-wasm VFS + `BrowserExecutionEnv` (S2 — bead bd-56130e)

The in-browser filesystem/exec layer the Pi agent tools run on. Backs the SDK's
`ExecutionEnv` seam (`@earendil-works/pi-agent-core` `harness/types`) with an
IndexedDB virtual filesystem, so read/write/edit/ls/grep/find (pi-wasm S4) work
entirely client-side with **zero node builtins**.

## Why this exists

Per the S1 derisk (`scratch: pi-wasm:sdk-node-surface-findings`, `FEASIBILITY.md`
§5): the Pi `Agent` loop takes no `ExecutionEnv` in its constructor — fs/exec
coupling lives only inside each tool's `execute`. The node build injects
`NodeExecutionEnv` (real `node:fs`); the browser build injects
`BrowserExecutionEnv` (this module) into the S4 tools instead.

## The two seams (why no design churn lands on S2)

1. **Backend seam — `Vfs`** (`vfs.ts`): a tiny async fs subset. `BrowserExecutionEnv`
   is written only against `Vfs`, so the backing store is swappable behind one
   interface:
   - `LightningFsVfs` — IndexedDB via `@isomorphic-git/lightning-fs` (default;
     the raw instance `.fs` is shared with isomorphic-git in pi-wasm S5).
   - An **OPFS**-backed or **in-memory** `Vfs` drops in with no change to
     `BrowserExecutionEnv`, the Agent loop, or the tools.
2. **Exec seam — `BrowserExecutionEnv.exec()`**: returns `shell_unavailable` in
   this no-bash MVP. It is the single plug point for the exec ladder (JS bash
   emulator / WebContainer / emscripten-busybox mounting this same VFS, a wasm
   x86 microVM, or an ssh-out / MCP bridge) in pi-wasm S10 — again with no change
   to the loop or tools.

## Usage

```ts
import { createBrowserExecutionEnv } from "./vfs";

const env = await createBrowserExecutionEnv({ cwd: "/work" });
await env.writeFile("notes/todo.txt", "hello\n");   // creates parent dirs
const read = await env.readTextFile("notes/todo.txt");
if (read.ok) console.log(read.value); // "hello\n"
// env satisfies ExecutionEnv → inject into the S4 tools' execute closures.
```

Every method returns `Result<T, FileError | ExecutionError>` and never throws;
error codes mirror `NodeExecutionEnv` (`ENOENT`→`not_found`, `EISDIR`→
`is_directory`, `exists`→`not_found`→`false`, `writeFile` creates parent dirs,
`fileInfo` does not follow symlinks, …).

## Tests

`npm test` (vitest). The full `ExecutionEnv` contract runs against **both** an
in-memory `Vfs` and `LightningFsVfs` over `fake-indexeddb`, proving the fs
methods work over IndexedDB and that the logic is backend-independent.
