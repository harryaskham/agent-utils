# pi-wasm exec-backend seam (S13a — bead bd-4d085a)

The pluggable shell/exec layer. `BrowserExecutionEnv.exec()` (S2) is the single
seam every exec tier plugs into; this defines the swappable backend and keeps the
no-bash default.

## Interface

```ts
interface ExecBackend {
  readonly id: string;         // "none" | "remote" | "js-shell" | "webcontainer" | "microvm"
  readonly available: boolean;
  exec(command, options: ShellExecOptions & { cwd }): Promise<Result<ExecResult, ExecutionError>>;
  dispose?(): Promise<void>;
}
```

`NullExecBackend` (the default) returns `shell_unavailable` — identical to the S2
MVP, so nothing regresses when no backend is configured.

> **Dynamic tiers:** `exec()` gates on `backend.available` at call time, so a
> backend whose reachability changes at runtime (remote / ssh-localhost
> especially) should implement `available` as a **getter**, not a
> construction-time snapshot. The `readonly available` field permits a getter.

## Wiring

`BrowserExecutionEnv` takes an optional `execBackend` (ctor option) and exposes
`setExecBackend()` / `getExecBackend()` for **per-session** selection (owned by
the S11 keyed-session layer). `exec()` delegates to the backend when present +
`available`, resolving `cwd` against `env.cwd`; otherwise it returns
`shell_unavailable`. The `bash` AgentTool (`../tools/bash-tool`) routes through
`exec()`, so it lights up automatically once a backend is set. Backends MUST obey
the SDK Shell contract: never throw — encode failures in the `Result` — and honor
`abortSignal` + `timeout`.

## Tiers that plug in here (separate beads)

- **S10 js-bash** (bd-ef8f24): coreutils-in-JS over the shared VFS. **Landed** —
  `JsShellBackend` (id `js-shell`); see `js-shell/README.md`.
- **S15 remote** (bd-ef14af): WS/HTTP → ssh-localhost / MCP bridge (Harry's escape hatch).
- **S14 microvm** (bd-c6ffc3): v86 / CheerpX / container2wasm. Feasibility +
  recommendation (**v86**, smallest viable + VFS-shareable) in
  [`../../MICROVM-FEASIBILITY.md`](../../MICROVM-FEASIBILITY.md).
- WebContainer (StackBlitz wasm) as a further tier.

A file-operating backend (js-shell/webcontainer/microvm) should share the S2 VFS
(`LightningFsVfs.fs` / the `Vfs` seam) so shell + tools see the same tree — the
same pattern S5 uses for isomorphic-git. See scratch `pi-wasm:exec-backend-seam`.
