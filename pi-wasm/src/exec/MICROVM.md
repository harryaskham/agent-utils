# pi-wasm microVM exec backend (S14, bd-c6ffc3)

The **microVM tier** of the pluggable exec-backend seam (S13, bd-6ebbf6): a
miniscule Linux guest running **in the tab** so the agent gets real
bash/coreutils client-side. Recommended engine: **v86** (smallest viable,
permissive, and the only candidate that can share our IndexedDB VFS) — see the
full comparison in [`../../MICROVM-FEASIBILITY.md`](../../MICROVM-FEASIBILITY.md).

`MicrovmExecBackend` implements the landed `ExecBackend` interface (S13a,
`src/exec/exec-backend.ts`), registers as `id: "microvm"` through the S13
id→backend factory (bd-6ebbf6), and is selected per session by S11.

## The key difference from other tiers

A microVM is a **persistent boot**, not a process-per-call. So exec() cannot
"spawn"; it must inject each command into the *running* guest over its serial
console and parse stdout + the exit code back out. Because a serial console is a
single shared line, **concurrent exec() calls are serialized** (queued) so their
output cannot interleave.

## Layers (all v86-agnostic)

- **`MicrovmMachine`** — the machine seam (like the relay tier's `RelayTransport`):
  `boot()` (idempotent, resolves when a serial shell is ready), `writeSerial()`,
  `onSerialData()`, `available`, `dispose?()`. The real **v86 adapter** (boot a
  vendored Buildroot image; bridge `/work` to the S2 `LightningFsVfs` via a 9p
  `handle9p` handler) implements this — that is the next increment. Tests use a
  mock guest.
- **serial protocol** (`frameCommand` / `parseSerialResult`, exported + unit
  tested): frames a command as
  ```sh
  <env exports>; cd <cwd> 2>/dev/null
  printf 'PIWASM_BEGIN_%s\n' '<token>'
  <command>
  __piwasm_rc=$?; printf 'PIWASM_END_%s:%d\n' '<token>' "$__piwasm_rc"
  ```
  The unique token is passed as a printf **argument**, so the marker strings
  (`PIWASM_BEGIN_<token>` / `PIWASM_END_<token>:<rc>`) only ever appear in the
  command's **output**, never in the console **echo** of the injected line —
  making stdout extraction robust to echo and shell prompts. stdout is the bytes
  between the two markers; the exit code is the END marker's captured integer.
- **`MicrovmExecBackend`** — boots the machine lazily on first exec, honors
  `abortSignal` (sends Ctrl-C to the guest) + `timeout`, streams via `onStdout`,
  and **never throws** — all failures map to `ExecutionError`
  (`shell_unavailable` / `aborted` / `timeout` / `spawn_error`).

## Usage (once the v86 adapter lands)

```ts
import { createMicrovmExecBackend } from "./exec";
// const machine = await createV86Machine({ image, vfs });  // next increment
const backend = createMicrovmExecBackend({ machine });
// env.setExecBackend(backend)  // wired per-session by S13 registry / S11
```

`backend.available` is `false` until the machine is loadable, so `exec()`
degrades to the stable `shell_unavailable` error rather than throwing.

## v1 limitations / next increments

- **stderr** is currently `""` — v1 captures the combined serial console as
  stdout. v2 will split stderr (redirect to a temp file read back over the shared
  VFS, or a framed guest-agent channel).
- **The v86 `MicrovmMachine` adapter + guest image + 9p↔`Vfs` bridge** are the
  next increment; the acceptance target is booting the image and proving
  `bash -c 'cat /work/<file>'` sees a file written by the S4 file tools.
- **Networking** (`relay_url` WebSocket → the S15 remote/ssh proxy) is a later
  slice, gated behind a session setting.
