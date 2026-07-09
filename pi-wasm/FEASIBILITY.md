# pi-wasm feasibility — fully in-browser Pi agent loop

S1 spike deliverable for **bd-11daa5** (epic **bd-f76cee**). This is the
empirical, do-or-die derisk that shapes every downstream slice (S2–S8).

> **Verdict: FEASIBLE — proven, not just argued.** The Pi agent loop constructs
> and runs its event bus **inside a real browser with ZERO Node polyfills**,
> when built directly on `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`
> and bypassing the Node-coupled `@earendil-works/pi-coding-agent` barrel.

Authors: msm-0 (empirical spike + synthesis), with static-analysis recon from
**ms2-2** (`scratch: pi-wasm:sdk-node-surface-findings`) and **msm-1**
(`scratch: pi-wasm-recon`, incl. the S3 CORS/streaming de-risk). Installed pkg
analysed: `@earendil-works/pi-coding-agent@0.80.3` (+ bundled `pi-agent-core`,
`pi-ai`, `pi-tui`).

---

## 1. What this spike proved empirically

| Check | Result |
| --- | --- |
| `vite build` of a page importing `pi-agent-core` + `pi-ai` (no polyfills) | ✅ builds clean in ~3.7s |
| Built bundle static Node surface | ✅ **0** static `import "node:*"`, **0** `require("node:*")`, **0** `cross-spawn`/`undici`/`proper-lockfile` refs |
| Residual `node:fs/os/path` refs in bundle | ✅ all are **lazy** `import("node:…")` guarded by `process.versions?.node` (false in a browser) — never executed on load |
| Page load in **real headless Google Chrome 150** (`--headless=new --dump-dom`) | ✅ loads, **no hard crash**, no module-resolution / `node:` / uncaught errors |
| In-browser `new Agent({ getApiKey })` | ✅ **constructs**; `agent.state` = `{systemPrompt, model, thinkingLevel, tools, messages, isStreaming, streamingMessage, pendingToolCalls, errorMessage}` |
| In-browser `agent.subscribe(...)` (event bus) | ✅ wires up |
| Node ESM construct smoke (`npm run spike:node`) | ✅ PASS (41 pi-ai exports; `createProvider`/`createModels` present) |

Reproduce: `cd pi-wasm && npm install && npm run build`, then serve `dist/` and
open it (see `README.md`). The page writes its result into `#out` and to
`window.__PI_WASM_SPIKE__ = { ok, detail }` for the S8 Playwright harness.

Actual in-browser output captured this spike:

```
[import] @earendil-works/pi-agent-core   Agent = function
[import] @earendil-works/pi-ai           41 named exports
[import] pi-ai.createProvider            present
[import] pi-ai.createModels              present
[construct] new Agent({ getApiKey }) ......... OK
[state] keys: systemPrompt, model, thinkingLevel, tools, messages, ...
[events] agent.subscribe(...) ................ OK
RESULT: ... CONSTRUCTS in-browser ... zero node polyfills. PASS
```

---

## 2. The two viable paths (both static-analysis-validated)

### Path A — build directly on `Agent` (RECOMMENDED for the MVP)
Import from the **import-time browser-clean `.` entries** only:
`@earendil-works/pi-agent-core` (the `Agent` loop) + `@earendil-works/pi-ai`
(providers). **Never** import the `@earendil-works/pi-coding-agent` barrel and
**never** the `@earendil-works/pi-agent-core/node` subpath.

- `Agent`'s constructor (`AgentOptions`) exposes exactly the seams a browser needs:
  - `streamFn?` — the LLM streaming call (inject a `pi-ai` provider stream; S3).
  - `getApiKey?: (provider) => string|undefined` — **runtime keys from the settings screen** (S6).
  - `initialState.tools` — tools we reconstruct over a browser `ExecutionEnv` (S2/S4).
  - plus `convertToLlm`, `transformContext`, `beforeToolCall`/`afterToolCall`, `transport`.
- **Zero node polyfills** needed for the loop core (proven above).
- Cost: we do **not** get `createAgentSession`'s glue (resource loading, tool
  wiring, session/settings/auth managers) — we build those ourselves (which we
  want anyway, over IndexedDB). This is the S7 integration target.
- Credit: this path is ms2-2's recommendation; this spike confirms it end-to-end.

### Path B — reuse `createAgentSession` via deep-import + a shim set
Deep-import `@earendil-works/pi-coding-agent/dist/core/sdk.js` (a bundler
`resolve.alias`, since the package `exports` map only exposes the barrel `.`),
and construct `createAgentSession({ …inMemory managers…, noTools: "all",
resourceLoader: <no-op> })`. Reuses the SDK's full wiring but needs shims.
- Credit: msm-1's recon. Minimal shim set (from `pi-wasm-recon`):
  `node:path`→`path-browserify` (real), `node:os`→`{homedir:()=>"/home",tmpdir:()=>"/tmp"}`,
  `node:url`→`{fileURLToPath:String}`, `node:fs`(+`/promises`)→S2 VFS or a
  permissive stub (`existsSync:()=>false`, `realpathSync:p=>p`), `proper-lockfile`→no-op,
  `cross-spawn`+`node:child_process`→throwing stub (bash excluded), `undici`/`jiti`/`glob`→empty,
  plus **pass a trivial `resourceLoader` with a no-op `reload()`** so construct-time
  never reads `fs`.
- Use Path B only if `Agent`-direct proves to lack essential glue, or request an
  upstream `@earendil-works/pi-coding-agent/browser` subpath export that excludes
  TUI/`main`/bash/node-fs tools (the clean long-term fix).

**Recommendation:** ship the MVP on **Path A**. Keep Path B documented as the
fallback + as the upstream ask.

---

## 3. The barrel trap (S1-critical, both recons agree)

`@earendil-works/pi-coding-agent`'s `exports` map exposes only `.` (and
`./rpc-entry`). The `.` barrel (`dist/index.js`) re-exports `main.js`,
`modes/*` (interactive **TUI** + rpc), `core/agent-session.js`,
`core/auth-storage.js`, `core/settings-manager.js`, `core/resource-loader.js`,
`core/tools/index.js` (read/grep/find/ls/**bash**), `utils/shell.js`,
`config.js`, etc. — and is the **only** thing that drags in
`cross-spawn` / `undici` / `jiti` / `glob` / `proper-lockfile` + `pi-tui`.
Do **not** rely on tree-shaking to drop it (`main`/`interactive` have side
effects). Path A avoids it entirely; Path B aliases past it to `core/sdk.js`.

---

## 4. Per-dependency classification

Legend: **clean** = never on the browser path; **lazy** = present but only
executed behind a runtime guard / uncalled function; **shim** = needs a
browser replacement we control; **blocker** = import-time hard blocker (only via
the barrel — avoided by Path A).

| Dep | Where | Import-time? | On Agent-construct path? | Browser disposition |
| --- | --- | --- | --- | --- |
| `node:fs` / `fs/promises` | `pi-agent-core/harness/env/nodejs.js` (behind `./node`); `pi-ai/utils/provider-env.js` (lazy `require`); `pi-coding-agent` core (barrel) | only via `./node` or barrel | **no** (Path A) | **clean** on Path A; **shim→S2 VFS** on Path B |
| `node:child_process` + `cross-spawn` | `pi-coding-agent core/tools/bash.js` (barrel), `pi-agent-core/…/nodejs.js` | via barrel/`./node` | **no** | **clean** (Path A); throwing **shim** (Path B, bash excluded → S10) |
| `undici` | `pi-coding-agent core/http-dispatcher.js` only | via barrel | **no** | not needed — providers use global `fetch` |
| `node:os` | `pi-agent-core/…/nodejs.js`; `pi-coding-agent utils/paths.js` (`homedir`) | via barrel/`./node` (+ 1 lazy ref bundled) | **no** (Path A) | **clean** (Path A); `{homedir,tmpdir}` **shim** (Path B) |
| `node:path` | ditto | via barrel/`./node` | **no** (Path A) | **clean** (Path A); `path-browserify` (Path B) |
| `node:url` | `pi-coding-agent utils/paths.js` (`fileURLToPath`) | via barrel | **no** | trivial **shim** (Path B only) |
| `node:crypto` | `pi-agent-core/…/nodejs.js` (`randomUUID`) | via `./node` | **no** | browser `crypto.randomUUID()` via the injected env |
| `proper-lockfile` | `pi-coding-agent` auth-storage/settings-manager | via barrel | **no** (inMemory skips locking) | no-op **shim** (Path B only) |
| `jiti` | `pi-coding-agent core/extensions/loader.js` | via barrel | **no** | not needed — pre-bundle extensions |
| `glob` | `pi-coding-agent core/package-manager.js` | via barrel | **no** | not needed |

Net: on **Path A**, the browser loop needs **no shims at all**. All `node:*`
that survives into the bundle is lazy + guarded by `process.versions?.node` and
never runs client-side.

---

## 5. The `ExecutionEnv` seam — blueprint for S2/S4

Filesystem + shell for the tools is injected via
`ExecutionEnv` (`pi-agent-core/harness/types`). `NodeExecutionEnv` (behind
`./node`) implements it with real `node:fs`/`child_process`. **The browser build
supplies a `BrowserExecutionEnv implements ExecutionEnv` over an IndexedDB VFS**
(S2). Interface (all `Promise<Result<…>>`) — credit ms2-2:

```
absolutePath, joinPath, exec, readTextFile, readTextLines, readBinaryFile,
writeFile, appendFile, fileInfo, listDir, canonicalPath, exists, createDir,
remove, createTempDir, createTempFile, cleanup  (+ cwd)
```

`exec()` returns an `ExecutionError` ("bash unavailable") for the no-bash MVP
(S4); real shell is the S10 stretch. read/write/edit/ls/grep/find are
reconstructed over this env.

---

## 6. Providers / network — S3 is unblocked (credit msm-1)

- `pi-ai` providers use **global `fetch`**, not `undici`. `pi-ai`'s own provider
  files already pass `dangerouslyAllowBrowser: true` (openai-responses,
  anthropic-messages, azure-openai-responses, …) — **browser is anticipated**.
- `openai@6.26.0` is isomorphic (only `node:stream`/`node:process` refs, with
  runtime env selection) → route the OpenAI-compatible LiteLLM proxy via the
  `openai` SDK path with `baseURL` + runtime key + `dangerouslyAllowBrowser`.
- **CORS is already enabled** on the LiteLLM proxy (`100.83.90.42:4000`):
  preflight `OPTIONS` returns `access-control-allow-origin: *` and allows the
  `authorization`+`content-type` headers; streaming `POST /v1/chat/completions`
  (`stream:true`) returns `text/event-stream` with `ACAO:*`. **No operator/proxy
  change needed.** S3 reduces to: point `model.baseUrl` at the proxy in
  `models.json` + runtime key (S6) + consume the SSE `ReadableStream`, possibly
  polyfilling `node:stream`/`process` for the openai SDK.

---

## 7. Recommendations for downstream slices

- **S2 (VFS)**: implement `BrowserExecutionEnv implements ExecutionEnv` over
  `@isomorphic-git/lightning-fs` or ZenFS (IndexedDB). Seed `/home/.pi/agent/*`
  + a `/work` project dir. This is the load-bearing slice.
- **S3 (providers)**: Path A `streamFn` from a `pi-ai` provider (openai path) at
  the proxy baseURL; polyfill `node:stream`/`process` if the openai SDK needs it.
- **S4 (tools)**: reconstruct read/write/edit/ls/grep/find over the S2 env;
  `exec` throws (no bash). No `pi-coding-agent core/tools/*` (those are node).
- **S6 (settings/keys)**: feed `getApiKey` + `models.json` + settings from the
  screen; persist to IndexedDB.
- **S7 (integration)**: wire `Agent` (Path A) + S2 env + S3 streamFn + S4 tools +
  S6 keys; render `agent.subscribe(...)` events. This is the demoable MVP.
- **S8 (Playwright)**: assert `window.__PI_WASM_SPIKE__.ok` and a tool write to
  the VFS. The spike page already exposes that hook.

---

## 8. Caveats / follow-ups

- Chunk sizes are large (providers bundle ~0.6–1.2 MB min) — cosmetic for the
  spike; code-split per provider in S7 if it matters.
- `getModel` is **not** a `.` export of `pi-ai@0.80.3` — model resolution is via
  `createModels`/`createProvider`. Adjust any S3/S6 code that assumed `getModel`.
- The headless-Chrome check here is a one-shot `--dump-dom` proof; the durable,
  CI-runnable browser assertion is **S8**'s job (hook already wired).
- Confirm during S7 that `Agent` alone (without the `createAgentSession` wrapper)
  drives a full turn richly enough; if it lacks essential glue, fall back to
  Path B and/or file the upstream `/browser` subpath-export ask.
