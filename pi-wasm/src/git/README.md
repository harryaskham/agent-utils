# pi-wasm git (S5)

Real, in-browser **git** over the shared virtual filesystem — bead **bd-3f7a4f**,
epic **bd-f76cee**. Built on [isomorphic-git](https://isomorphic-git.org)
(pure JS) driving the **same** `@isomorphic-git/lightning-fs` / IndexedDB store
that backs `BrowserExecutionEnv` (S2). There is one filesystem: a cloned or
checked-out repo is immediately visible to the S4 file tools and the agent loop.

## API

```ts
import { LightningFsVfs } from "../vfs";
import { createBrowserGit, createGitTools } from "./git/index";

const vfs = new LightningFsVfs("pi-wasm");          // shared with BrowserExecutionEnv
const git = createBrowserGit({ vfs, dir: "/work" }); // drives vfs.fs directly

await git.clone({ url: "https://github.com/owner/repo" });
await git.listFiles();          // -> ["README.md", "src/index.ts", ...]
await git.checkout({ ref: "v1.2.3" });
await git.log({ depth: 5 });    // newest-first commit summaries

// Expose to the agent loop as browser-clean AgentTools:
const tools = createGitTools(git); // git_clone, git_checkout, git_list_files, git_log
```

Local authoring (no network) is also available and is what the deterministic
tests exercise: `git.init()`, `git.add({ filepath })`, `git.commit({ message })`.

## CORS proxy (why network clone needs one)

Browsers **cannot open raw TCP** and **cannot fetch arbitrary git hosts**
(cross-origin + git's smart-http). isomorphic-git therefore routes fetch/clone
through its `http/web` client against a **CORS git proxy**:

```
browser ── https ──▶ CORS proxy ── https ──▶ git host (github.com, ...)
```

- **Default:** `DEFAULT_CORS_PROXY = "https://cors.isomorphic-git.org"` (the
  public proxy isomorphic-git uses in its own docs/demos). Fine for spikes and
  small public repos; **do not** rely on it for production or private repos.
- **Override per instance:** `createBrowserGit({ vfs, corsProxy: "https://my-proxy" })`.
- **Override per call:** `git.clone({ url, corsProxy: "https://my-proxy" })`.
- **Disable:** pass `corsProxy: ""` when the git host is same-origin or already
  CORS-enabled, or when a proxy is baked into the URL.

Run your own proxy with
[`@isomorphic-git/cors-proxy`](https://github.com/isomorphic-git/cors-proxy)
(a tiny node service; see S9 build/serve wiring), or a first-party proxy the app
provides. Auth for private repos is out of scope for S5 — credentials belong in
the S6 settings store and would be threaded through isomorphic-git's `onAuth`.

Local-only operations (`init` / `add` / `commit` / `log` / `listFiles` /
`checkout` of an existing repo) need **no** network and **no** proxy.

## Verifying a real clone (manual / S8)

CI tests are deterministic and network-free (local git over the VFS + clone
transport wiring against an injected http stub). A real end-to-end clone is a
browser check (mirrors the S1 headless-Chrome proof and lands in the S8
Playwright harness): serve the built bundle, call `git_clone` against a small
public repo through a reachable CORS proxy, and assert the files appear in the
VFS and are readable via the file tools.
