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
  `onSerialData()`, `available`, `dispose?()`. The real **v86 adapter**
  (`V86Machine`, `./v86-machine.ts`) implements this over copy/v86's serial API
  (`serial0_send` / `add_listener("serial0-output-byte")`); it boots a vendored
  Buildroot bzimage entirely in the tab (increment 4a, landed + validated). The
  `handle9p` bridge sharing the S2 `LightningFsVfs` into the guest at `/mnt` is
  increment 4b (landed; see below).
  Tests use a mock guest; `V86Machine` dynamically imports `v86` so it stays
  Node/vitest-safe.
- **serial protocol** (`frameCommand` / `parseSerialResult`, exported + unit
  tested): frames a command as
  ```sh
  <env exports>; cd <cwd> 2>/dev/null
  printf 'PIWASM_OUT_%s\n' '<token>'
  { <command>
  } 2>/tmp/.piwasm_err_<token>
  __piwasm_rc=$?
  printf 'PIWASM_ERR_%s\n' '<token>'
  cat /tmp/.piwasm_err_<token>; rm -f /tmp/.piwasm_err_<token>
  printf 'PIWASM_END_%s:%d\n' '<token>' "$__piwasm_rc"
  ```
  The unique token is passed as a printf **argument**, so the marker strings
  (`PIWASM_OUT_<token>` / `PIWASM_ERR_<token>` / `PIWASM_END_<token>:<rc>`) only
  ever appear in the command's **output**, never in the console **echo** of the
  injected line — making extraction robust to echo and shell prompts. **stdout**
  is the bytes between the OUT and ERR markers; the command's **stderr** is
  redirected to a temp file and replayed between the ERR and END markers, so the
  two streams are cleanly separated (matching Shell/Node exec semantics); the
  exit code is the END marker's captured integer.
- **`MicrovmExecBackend`** — boots the machine lazily on first exec, honors
  `abortSignal` (sends Ctrl-C to the guest) + `timeout`, streams via `onStdout`,
  and **never throws** — all failures map to `ExecutionError`
  (`shell_unavailable` / `aborted` / `timeout` / `spawn_error`).

## Usage

```ts
import { createMicrovmExecBackend } from "./exec";
import { V86Machine } from "./exec/v86-machine"; // browser only

const machine = new V86Machine();               // vendored assets under /microvm/
const backend = createMicrovmExecBackend({ machine });
// env.setExecBackend(backend)  // wired per-session by S13 registry / S11
const r = await backend.exec("echo hi", { cwd: "/" });
```

`backend.available` is `false` until the machine is loadable, so `exec()`
degrades to the stable `shell_unavailable` error rather than throwing.

### Vendored guest assets (v86)

`V86Machine` loads four binaries served from `/microvm/` (≈12MB total): the v86
wasm, a Buildroot bzimage, and SeaBIOS/VGA BIOS. They are **gitignored**, fetched
on demand by `node scripts/fetch-microvm-assets.mjs` (pinned by size + the
bzimage by sha256). The browser demo lives at `/microvm-demo.html`
(`src/microvm-demo.ts`) and exposes `window.__PI_WASM_MICROVM__ =
{ ready, exec, seedWorkFile, env }` for the S8 Playwright harness.

The real-v86 E2E (`e2e/microvm.spec.ts`) is **opt-in** via `PIWASM_E2E_MICROVM=1`
(needs the vendored assets) and skips otherwise, so the bare CI gate stays green:

```
node scripts/fetch-microvm-assets.mjs && PIWASM_E2E_MICROVM=1 npm run test:e2e
```

## Sharing the browser VFS into the guest (9p bridge, increment 4b)

`V86Machine` accepts a `handle9p` callback; v86 hands it full 9p2000.L request
frames and expects reply frames (`filesystem: { handle9p }`). `Vfs9pServer`
(`./ninep/server.ts`, codec in `./ninep/marshall.ts`) is a minimal 9p2000.L
server that answers those frames from a `Vfs` — so a guest and the in-browser
file tools share ONE filesystem tree.

The Buildroot guest **auto-mounts** the `host9p` device at **`/mnt`** during
boot (`host9p /mnt 9p rw,…,access=client,trans=virtio`), so no manual mount is
needed. `Vfs9pServer` maps the 9p root to a VFS path (default `/work`), i.e.
guest `/mnt/<f>` ⇄ VFS `/work/<f>`. Because the auto-mount is `cache=none`,
every lookup/read hits the server, so a file a tool writes mid-session is
immediately visible to the guest (and guest writes appear in the VFS).

```ts
import { V86Machine, Vfs9pServer, createMicrovmExecBackend } from "./exec";
const vfs = new LightningFsVfs("pi-wasm-microvm");
const ninep = new Vfs9pServer({ vfs, root: "/work" });
const machine = new V86Machine({ handle9p: async (req, reply) => reply(await ninep.handle(req)) });
const backend = createMicrovmExecBackend({ machine });
// tool writes VFS /work/data.json  →  guest sees /mnt/data.json
```

The codec + full `cat` message sequence (version → attach → walk → getattr →
lopen → read) plus write-back and readdir are unit-tested
(`test/vfs9p-server.test.ts`) against a real `LightningFsVfs`, and the whole
bridge is proven against real v86 in `e2e/microvm.spec.ts` (host→guest,
guest→host, and mid-session write visibility). The message layouts are ported
1:1 from copy/v86's `lib/9p.js` + `lib/marshall.js` so they interop exactly with
v86's guest device. Implemented ops: version, attach, statfs, walk, getattr,
lopen, read, readdir, write, lcreate, mkdir, unlinkat, setattr(size), clunk,
flush, fsync; other ops return `Rlerror(ENOSYS)`.

## Limitations / next increments

- **stdout/stderr are separated, not interleaved.** Each is captured as its own
  stream (stderr via the temp-file replay between the ERR/END markers), matching
  Shell/Node exec semantics; the original console interleaving order is not
  preserved. Requires a writable `/tmp` in the guest (any Linux guest has one).
- **The v86 adapter + 9p bridge have landed (increments 4a + 4b)**: v86 boots a
  real Buildroot Linux guest in the tab, runs shell through the serial exec
  protocol, and shares the S2 `LightningFsVfs` into the guest at `/mnt` over a
  minimal 9p2000.L server — all validated end-to-end by `e2e/microvm.spec.ts`
  (echo/stderr/exit code; and a bidirectional `/mnt` file round-trip incl.
  mid-session write visibility). The 9p `root` (default `/work`) is the VFS path
  the guest's `/mnt` maps to.
- **Networking** (`relay_url` WebSocket → the S15 remote/ssh proxy) is a later
  slice, gated behind a session setting.
