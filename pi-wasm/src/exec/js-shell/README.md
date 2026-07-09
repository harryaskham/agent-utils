# pi-wasm js-shell backend (S10 — bead bd-ef8f24)

The **js-shell reference ExecBackend**: a dependency-free, browser-clean
coreutils-in-JS shell that implements ms2-2's landed `ExecBackend` seam (S13a,
`../exec-backend.ts`) over the session's shared `ExecutionEnv` VFS. It is the
lightweight "prove the seam" exec tier — the same tree the S4 file tools see,
with zero node builtins, so `bash` works fully in-browser (or over `InMemoryVfs`
in tests) with no server.

## Wiring

```ts
const env = await createBrowserExecutionEnv({ vfs });   // LightningFsVfs or InMemoryVfs
env.setExecBackend(new JsShellBackend(env));            // id "js-shell", always available
// the S13a `bash` tool now routes real commands through env.exec()
```

`JsShellBackend(env)` closes over the `ExecutionEnv` and drives coreutils purely
through its Result-returning fs methods (`readTextFile`/`writeFile`/`listDir`/…),
so shell + tools share one tree over any VFS backend. The shell keeps its own
`cd`-mutated cwd and resolves every path to ABSOLUTE before calling env methods,
so it is independent of `env.cwd`.

## Contract (SDK Shell / S13a)

- `exec()` NEVER throws. A failed command is `ok:true` with a nonzero `exitCode`
  (unix convention); only aborts/timeouts become an `ExecutionError`
  (`aborted` / `timeout`).
- `options.cwd` arrives already resolved to an absolute path; honored for
  relative path ops.
- Honors `abortSignal` + `timeout` (seconds); streams via `onStdout`/`onStderr`.
- `available` is always `true` (pure JS, no async deps / endpoint).

## Supported grammar (`js-shell/parse.ts`)

Word splitting with `'…'` (literal), `"…"` (literal; no expansion in this MVP)
and `\` escapes; pipelines `|`; connectors `;` `&&` `||`; stdout redirects `>`
`>>`. NOT supported (follow-ups): subshells, globbing, variable expansion,
here-docs, stderr redirects, `<` input redirect.

## Builtins (`js-shell/coreutils.ts`)

`echo` (`-n`), `pwd`, `cd`, `true`/`false`/`:`, `ls` (`-l` `-a`), `cat`, `mkdir`
(`-p`), `rm` (`-r` `-f`), `touch`, `head`/`tail` (`-n`), `wc` (`-l` `-w` `-c`),
`grep` (`-i` `-n` `-v`, JS-regex with literal fallback). Unknown commands →
`command not found` (exit 127). New builtins register in the `BUILTINS` table
without touching the parser or runner.

## Modules

- `parse.ts` — tokenizer + AST (pure, never throws).
- `coreutils.ts` — the builtin table over `ShellFs`.
- `run.ts` — executes the AST: pipes, redirects, connectors, `cd`.
- `../js-shell-backend.ts` — the `ExecBackend` wrapper (abort/timeout/never-throw).

Registered by id `"js-shell"` in the S13 selection registry (bd-6ebbf6).
