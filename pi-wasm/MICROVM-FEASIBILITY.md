# pi-wasm microVM exec backend — feasibility (S14, bd-c6ffc3)

Spike deliverable for **S14** (epic bd-f76cee): can we run a *miniscule* full
Linux microVM entirely in the browser as a real `exec()` backend — giving the
in-browser Pi agent genuine bash/coreutils/toolchains client-side — and if so,
which of **v86 / CheerpX-WebVM / container2wasm** is the smallest viable option?

Operator direction (Harry, 2026-07-09): *"we should definitely have a version
able to run a full miniscule microvm backend"* + *"support ALL of these
options"* + Pi may *ssh into localhost*. So this is **spike-then-build**: pick
the smallest viable candidate and ship it as a selectable backend.

**Bottom line: viable. Recommend v86.** It is the only candidate that is
simultaneously (a) permissively licensed + self-hostable, (b) miniscule (~2.3 MB
core + a few-MB Buildroot image), and (c) able to **share our IndexedDB VFS** via
its 9p JS handler so the guest and the S4 file tools see the same tree. CheerpX
has the nicest API but its runtime is proprietary/commercial and cannot share our
VFS; container2wasm embeds the rootfs into wasm (78–200 MB) and fails "miniscule".

---

## 0. The seam this plugs into (already landed — no wait)

S14 does **not** need to wait on S13: the pluggable exec seam already landed.

- **`ExecBackend`** (`src/exec/exec-backend.ts`, S13a bd-4d085a). A backend is:
  ```ts
  interface ExecBackend {
    readonly id: string;         // "microvm"
    readonly available: boolean; // getter: true once the VM has booted
    exec(command: string, options: ShellExecOptions & { cwd: string }):
      Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>;
    dispose?(): Promise<void>;
  }
  ```
  Contract: **never throw** — encode failures in the `Result`; honor
  `abortSignal` + `timeout`.
- **`BrowserExecutionEnv.setExecBackend()`** (S2 bd-56130e) selects it per
  session; the `bash` AgentTool (`src/tools/bash-tool.ts`) routes through
  `env.exec()`, so the backend lights up with zero Agent-loop changes.
- **`Vfs`** (`src/vfs/vfs.ts`) — the shared filesystem seam (`readFile`,
  `writeFile`, `mkdir`, `rmdir`, `unlink`, `readdir`, `lstat`), implemented by
  `LightningFsVfs` over IndexedDB (`@isomorphic-git/lightning-fs`). A
  file-operating backend must bridge THIS so shell + tools + isomorphic-git (S5)
  all see one tree.

So the microVM backend is `class MicrovmExecBackend implements ExecBackend`,
`id="microvm"`, that boots a VM, bridges the VFS, and implements `exec()`.

## 1. The core problem: a microVM is a *boot*, not a *process*

The single biggest design fact. `NodeExecutionEnv.exec()` spawns a process per
call; a microVM is a long-lived booted kernel. So `exec(command)` must:

1. **Boot once, reuse** — boot the guest on first `available`/first `exec`, keep
   it warm, and *inject* each command into the running guest (not boot-per-call,
   which would be seconds of latency per command).
2. **Capture stdout/stderr + exit code** out of a running guest.
3. **Bridge the VFS** so files the S4 tools wrote are visible to the command and
   vice-versa.

Candidates differ most in how cleanly they answer (2) and (3).

## 2. Candidate comparison (2026 measurements)

| Axis | **v86** (copy/v86) | **CheerpX / WebVM** (leaningtech) | **container2wasm** (ktock) |
|---|---|---|---|
| Version (2026-07) | npm `0.5.424` | CheerpX runtime (CDN) / WebVM repo | `v0.8.4` (Mar 2026) |
| License | **BSD-2-Clause** (self-host OK) | **Proprietary runtime**; community=free for personal/FOSS/eval, **commercial for business/OEM/self-host (~£100/dev/mo)**. WebVM repo is Apache-2 but the CheerpX runtime it loads is not. | **Apache-2.0** (self-host OK) |
| Core bundle | `libv86.js` ~344 KB + `v86.wasm` **~1.99 MB** (release) | "~under 6 MB" (2022 figure; no exact 2026 number); Debian image streamed on demand | **No fixed size — embeds the container rootfs into wasm**: demos **78 MB (riscv vim) – 200 MB (amd64 Debian)**; `--external-bundle` to avoid embedding |
| Guest image | Bring-your-own; minimal **Buildroot i386** = a few MB, fastest first shell | Prebuilt Debian ext2 (large, HTTP-range streamed) | Whatever container you compile in (size ∝ image) |
| Boot | Buildroot minimal boots in ~seconds | Streams; first boot slower, cached after | Browser path **not** wizer-preboot'd → slower; WASI path uses wizer |
| **exec() shape** | Serial console: `serial0_send()` + `serial0-output-byte` listener → inject `cmd; echo __rc$?__` and scrape to a sentinel | **`CheerpX.Linux.run("/bin/bash",["-c",cmd]) → {status}`** (cleanest — real exit code) | Override cmd/entrypoint at runtime; stdin supported; no clean per-call exit-code API in browser |
| **VFS bridge to our LightningFsVfs** | **9p `handle9p` JS handler** (or `filesystem.proxy_url`) → proxy 9p2000.L ops to `Vfs`. Genuine shared tree. | Own FS model: `HttpBytesDevice`+`IDBDevice`(its own ext2-in-IndexedDB)+`OverlayDevice`. **Cannot share our lightning-fs** — would need file-by-file sync | WASI `--mapdir` → virtio-9p; in-browser FS bridge is limited/awkward |
| Networking / ssh-out | `net_device:{type:"virtio",relay_url:"wss://…"}` — WebSocket relay to a real network (pairs with S15) | Tailscale wasm module (+ exit node for public internet) | Browser: Fetch proxy (**HTTP/HTTPS only, CORS-limited**); delegate: WebSocket to host daemon |
| Miniscule? | **Yes** (~2.3 MB + small image) | Medium (runtime + streamed Debian) | **No** (tens–hundreds of MB) |
| Shippable as default? | **Yes** | No (license + can't share VFS) | Only for "run this specific container" niche |

Sources: v86 README/filesystem.md/networking.md/`v86.d.ts`/examples/serial.html,
jsDelivr package listing; cheerpx.io docs (licensing, File-System-support,
Networking, `CheerpX.Linux/run`) + leaningtech/webvm LICENSE; container2wasm
README + networking/fetch example + demo bundle sizes.

## 3. Why v86 wins for the *default* miniscule tier

1. **Smallest + self-hostable.** ~2.3 MB core + a Buildroot image we control;
   BSD-2 so we can vendor + serve it from our own nix build (S9) with no runtime
   license fee. CheerpX's proprietary/commercial runtime is a non-starter for a
   default, always-on product tier; container2wasm's 78–200 MB fails "miniscule".
2. **It can actually share our VFS.** The `handle9p` hook lets us implement a
   9p2000.L handler backed 1:1 by the `Vfs` seam — `Tread`→`vfs.readFile`,
   `Twrite`→`vfs.writeFile`, `Treaddir`→`vfs.readdir`, `Tgetattr`→`vfs.lstat`,
   etc. Files the S4 tools write land in IndexedDB and are immediately visible to
   the guest, and shell output persists back. CheerpX cannot do this (separate
   ext2); container2wasm's browser FS bridge is weak.
3. **Networking is a clean WebSocket relay** (`relay_url`) that dovetails with
   the S15 remote/ssh tier and Harry's "ssh into localhost": point the relay at a
   small WS↔TCP proxy on the host.

CheerpX's `run()→{status}` API is genuinely nicer than serial scraping — so
**CheerpX is worth keeping as an *optional, separately-licensed* premium tier**
(`id="cheerpx"`), not the default. container2wasm stays a niche "boot a specific
OCI image" escape hatch, not a general bash backend.

## 4. Recommended build architecture (the "then build" for S14)

`class MicrovmExecBackend implements ExecBackend` in `src/exec/microvm/`:

- **Lazy + opt-in.** Dynamic-`import()` v86 only when a session selects
  `microvm` (keeps it out of the MVP bundle; `available` is a getter that is
  `false` until booted). Never in the default tool set.
- **Boot once.** On first use, boot a vendored minimal **Buildroot i386** image
  (kernel+initrd) with `virtio` + `9p` + serial getty on `ttyS0`. Root can be a
  small embedded/base9p image; **mount `/work` (and the agent home) via a second
  9p tag bridged to `LightningFsVfs`** so the OS root stays read-only/cacheable
  and only the agent's tree is shared+writable.
- **VFS bridge.** A `Vfs`→9p2000.L adapter behind `handle9p`. Small surface; the
  `Vfs` interface already matches the ops we need. Reuses the *same* lightning-fs
  instance the tools use (`LightningFsVfs.fs`), like S5's isomorphic-git.
- **exec() over serial.** Maintain a serial line reader; per call write
  `printf '\n'; <command>; printf '\n__PIWASM_RC_%s__=%d\n' "$id" "$?"` and read
  stdout until the unique `__PIWASM_RC_<id>__` sentinel; parse the exit code;
  split the captured bytes into stdout (and stderr via `2>` redirection or a
  merged stream in v1). Honor `timeout`/`abortSignal` by racing a timer and
  sending `Ctrl-C` on abort. Never throw — map failures to `ExecutionError`.
- **Networking (later slice).** Wire `relay_url` to the S15 WS↔TCP proxy so the
  guest can `ssh` / fetch; gate behind a session setting.

**A harder-but-more-robust v2** replaces serial scraping with a tiny guest agent
(a static musl binary in the image) that reads commands from a virtio-serial or
9p control channel and returns framed `{stdout,stderr,exitCode}` — eliminating
console-scrape fragility. v1 serial-scrape is fine to prove the seam.

## 5. Acceptance mapping + risks

- **Spike acceptance** ("recommend an approach, or a clear negative, with
  bundle/boot measurements") — **met**: positive recommendation (v86) with 2026
  size/boot/licensing measurements and a concrete architecture; CheerpX &
  container2wasm documented negatives *for the default tier* with rationale.
- **Build acceptance** ("one candidate boots in-browser and can read a file
  placed in the VFS") — the next increment: land `MicrovmExecBackend` + the
  9p↔Vfs bridge behind a lazy import, boot Buildroot, and assert
  `bash -c 'cat /work/<file>'` returns a file written via the S4 tools.

**Risks / unknowns to derisk in the build:**
- Guest image production (Buildroot config with virtio-9p + serial getty) is the
  main artifact to build + vendor; keep it in the S9 nix build so it's pinned.
- Serial-scrape correctness with binary output / partial reads / concurrent
  calls → serialize `exec()` calls per VM and use unique sentinels; move to the
  guest-agent channel if fragile.
- x86 emulation throughput is fine for agent shell use but not for heavy
  compilation — that is exactly what the S15 ssh-out tier is for. The tiers are
  complementary, per Harry's "support ALL of these options."

## 6. Recommendation

Ship **v86** as the `microvm` `ExecBackend` (smallest viable, permissive,
VFS-shareable). Keep **CheerpX** as an optional separately-licensed premium tier
and **container2wasm** as a niche "run a specific OCI image" escape hatch. Build
order: 9p↔`Vfs` bridge + serial `exec()` behind a lazy import → boot Buildroot →
prove `cat /work/<file>` → wire `relay_url` networking (with S15). Coordinate the
backend interface with S13a (ms2-0); the VFS bridge with the S2 owner (ms2-2).
