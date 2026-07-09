# pi-wasm

A subproject of **agent-utils** exploring a **fully in-browser Pi agent loop** —
the Pi coding agent running entirely client-side, with an in-browser virtual
filesystem, runtime-injected API keys, real git checkouts, and end-to-end
browser-automation testing. Epic **bd-f76cee**.

## Status

**S1 (scaffold + feasibility spike, bd-11daa5): done.** The Pi agent loop
constructs and runs its event bus inside a real browser with **zero Node
polyfills**, built directly on `@earendil-works/pi-agent-core` +
`@earendil-works/pi-ai` (bypassing the Node-coupled `pi-coding-agent` barrel).
See **[FEASIBILITY.md](./FEASIBILITY.md)**.

**S2 (IndexedDB VFS, bd-56130e): done** — `src/vfs/` (`BrowserExecutionEnv` over
lightning-fs + a `node:fs` shim).

**S3 (browser provider / network layer, bd-cbf86f): done.** A real streaming
model call runs end-to-end against a CORS-enabled OpenAI-compatible endpoint (the
LiteLLM proxy) using a **runtime** key. Sets `window.__PI_WASM_S3__`. See
[**S3 — provider/network layer**](#s3--browser-providernetwork-layer) below.

**S4 (tools over the VFS, bd-a30bc2): done** — `src/tools/`
(read/write/edit/ls/grep/find `AgentTool`s over the S2 VFS; bash excluded).

**S5 (isomorphic-git checkout, bd-3f7a4f): done** — `src/git/` (`git_*` tools
over the shared VFS). See **[src/git/README.md](./src/git/README.md)**.

**S6 (settings/keys screen, bd-4c572a): done** — `src/settings/`
(`SettingsStore` / `toRuntimeConfig` / `mountSettingsPanel`, persisted to IndexedDB).

**S7 (app shell / chat UI, bd-e8949f): done — the demoable MVP.** A real
multi-turn chat that runs the full loop in-browser: S6 settings for keys/model,
S3 streaming provider (with a local **mock echo fallback** when no key), and the
S4 file tools over the S2 VFS installed on the agent. The chat renders text
streaming plus tool-call / tool-result rows.

## Layout

```
pi-wasm/
  index.html              # S7 chat app (primary page)
  provider-demo.html      # S3 standalone provider demo (preserved)
  settings-demo.html      # S6 standalone settings demo (preserved)
  src/main.ts             # S7 chat bootstrap: VFS + tools + settings + session + UI
  src/session.ts          # PiWasmSession — Agent (Path A) + tools + real/mock stream seam
  src/chat-ui.ts          # framework-free chat UI (text stream + tool rows)
  src/mock-stream.ts      # no-key mock streamFn (AssistantMessageEventStream)
  src/provider.ts         # S3: createBrowserAgent / streamFn / currentAssistantText
  src/settings/           # S6: SettingsStore / toRuntimeConfig / mountSettingsPanel
  src/vfs/                # S2: IndexedDB VFS + BrowserExecutionEnv (shared store)
  src/tools/              # S4: read/write/edit/ls/grep/find over the VFS
  src/git/                # S5: isomorphic-git over the shared VFS (+ git_* tools)
  scripts/construct-smoke.mjs  # Node-side construct smoke (npm run spike:node)
  vite.config.ts          # multi-page browser build; intentionally NO node polyfills
  FEASIBILITY.md          # the S1 deliverable — read this
```

## Develop / build / verify

```bash
cd pi-wasm
npm install
npm run typecheck      # tsc --noEmit
npm run build          # vite build -> dist/ (index + provider-demo + settings-demo)
npm run dev            # vite dev server (http://localhost:5173)
npm run test           # vitest (node-side unit + integration)
npm run test:e2e       # Playwright browser E2E (system Chrome; live tiers gated on a key)
```

Open `index.html`, click **⚙ Settings** to enter a runtime key + model, and chat.
With no key the chat runs a local mock echo so the page works out of the box.

**Headless note:** the chat page boots asynchronously (IndexedDB VFS), so a
single `--dump-dom` snapshot races the boot. Poll a readiness hook instead —
`#app[data-pi-wasm-ready="true"]`, then `window.__PI_WASM_S3__` (from
`?autorun=1&prompt=…`) — over CDP, which is what the S8 harness will do. Test
globals: `__PI_WASM_SPIKE__` (S1), `__PI_WASM_S3__` (autorun), `__PI_WASM__`
(`send` / `getTranscript` / `runToolsSmoke`), `__PI_WASM_SETTINGS__` (S6).

### Reproducible nix build / serve (S9, bd-82b969)

The browser bundle is wired into the agent-utils root flake as a `pi-wasm`
subflake (`path:./pi-wasm`), alongside `web-search` and `linear-extra`. It is a
separate package/app and is intentionally **not** part of the root
`default`/`all` collator (it is a web bundle, not a bin), so it does not affect
the root build/test gate.

```bash
# from the repo root:
nix build .#pi-wasm          # deterministic build -> static web root in ./result (index.html + assets/)
nix run   .#pi-wasm-serve    # build + serve the bundle on http://localhost:4319
nix run   .#pi-wasm-serve -- 8080   # ...on a custom port

# from ./pi-wasm directly (self-contained subflake):
nix build .#pi-wasm
nix run   .#pi-wasm-serve
```

The build uses `buildNpmPackage` with the pinned `package-lock.json`
(`npmDepsHash`), runs `npm run build` (vite), and installs `dist/` as the
package output. If `package-lock.json` changes, recompute the deps hash:

```bash
nix run github:NixOS/nixpkgs/nixos-unstable#prefetch-npm-deps -- pi-wasm/package-lock.json
# then update npmDepsHash in pi-wasm/flake.nix
```

### S3 real-browser streaming check

```bash
npm run build
( cd dist && python3 -m http.server 4321 & )
# Provide a runtime key at load time (URL param, not committed). autorun=1 fires
# one streaming call; the page never renders the key.
KEY="$OPENAI_API_KEY"
chromium --headless=new --disable-gpu --user-data-dir=/tmp/piwasm-chrome-s3 \
  --no-first-run --virtual-time-budget=15000 --dump-dom \
  "http://localhost:4321/?autorun=1&model=gpt-4.1&prompt=Say%20hi%20in%20three%20words&key=$KEY"
# -> <title>pi-wasm S7:ok</title> and window.__PI_WASM_S3__ = {"ok":true,"text":"...","chunks":N}
```

Interactively (`npm run dev`), enter a key in **⚙ Settings**; it is kept only in
this browser (IndexedDB, the S6 settings seam).

### S8 — Playwright full-loop browser harness (bd-8a973e foundation + bd-759769 full loop)

The reusable browser-E2E harness proves the whole in-browser loop with **no
human input**. It uses the system Google Chrome (`channel:"chrome"` — no
chromium download) and is isolated from the vitest suite (`e2e/` vs `test/`).

```bash
npm run test:e2e
```

Tiers (`e2e/s8-full-loop.spec.ts` + `e2e/s3-provider.spec.ts`):

- **Tier 1 (always runs, no key):** the chat app boots
  (`#app[data-pi-wasm-ready="true"]`), the S4 file tools run read→edit→write
  against the S2 VFS (`window.__PI_WASM__.runToolsSmoke()`, bash blocked), and
  the mock loop returns a streamed assistant reply. Deterministic + CI-safe.
- **Tier 2 (key-gated):** with a real key seeded into the S6 settings store
  (IndexedDB), a real streaming completion runs, **and** a real
  prompt→reason→tool→reply cycle makes the model call the `write` tool — the
  harness asserts the requested file lands in the VFS via
  `window.__PI_WASM__.env`. Skipped without a key (`PIWASM_E2E_KEY` /
  `OPENAI_API_KEY`), so the bare gate still passes.

Keys are supplied at runtime (settings store / `window.__PI_WASM_KEY__`), never
committed, and never rendered into the DOM.

## Roadmap (epic bd-f76cee)

**S1–S9 done** (feasibility · VFS · provider · tools · git · settings · chat MVP ·
**S8/S8a Playwright E2E harness ✅** · **S9 nix build/serve ✅, bd-82b969**).
The full in-browser prompt→reason→tool→reply loop is now proven by automated
browser testing (`npm run test:e2e`, Tier 2b).
Next: S11 keyed multi-session persistence · S13 pluggable exec backend
(S10 JS-bash / S14 wasm-microVM / S15 remote ssh·MCP).

`node_modules/` and `dist/` are gitignored; this subproject is self-contained
and does not affect the agent-utils root build/test gate.

## S3 — browser provider/network layer

**Deliverable (bd-cbf86f):** make pi-ai provider calls stream from the browser.

**Endpoint / CORS config used (documented per the bead):**

- **Endpoint:** `http://100.83.90.42:4000/v1` — the existing LiteLLM proxy,
  OpenAI-compatible (`POST /v1/chat/completions`, `stream: true`).
- **CORS:** already enabled on the proxy; **no proxy change was required**.
  Preflight `OPTIONS` returns `access-control-allow-origin: *` and allows the
  `authorization` + `content-type` request headers; the streaming `POST`
  response also carries `access-control-allow-origin: *` and
  `content-type: text/event-stream`. A browser page on any origin (e.g. the vite
  dev server) can therefore stream from it directly.
- **Auth:** runtime key via the Agent's `getApiKey(provider)` seam → forwarded
  by the agent loop as `options.apiKey` → `new OpenAI({ apiKey, baseURL:
  model.baseUrl, dangerouslyAllowBrowser: true })`. Keys are entered at runtime
  (settings panel / `localStorage` / URL param / `window.__PI_WASM_KEY__`) and
  **never** committed or hard-coded.

**Wiring (`src/provider.ts`, Path A):**

- `makeOpenAICompatModel()` builds a `Model<"openai-completions">` whose
  `baseUrl` points at the endpoint.
- `makeOpenAICompatStreamFn()` returns a `StreamFn` from pi-ai's
  `openAICompletionsApi()` (`@earendil-works/pi-ai/compat`), which lazily loads
  the isomorphic `openai` SDK on first stream and uses global `fetch` + SSE.
- `createBrowserAgent()` assembles `new Agent({ initialState: { model }, streamFn,
  getApiKey })`. `agent.prompt(text)` then streams; text deltas are read from
  `agent.state.streamingMessage` / `messages` and rendered live. S7 consumes the
  same `streamFn` behind `PiWasmSession`, adding the S4 tools + a mock fallback.

**Bundle note:** the only Node builtin vite externalizes is `node:fs` (pulled by
pi-ai's lazy `utils/provider-env.js`, guarded by `process.versions?.node` and
never executed in a browser), so **no polyfills were added** — the S1 zero-polyfill
posture holds. The `openai` SDK bundles cleanly (isomorphic, web-stream shims).

**Model choice:** any id the proxy exposes works (`gpt-4.1`, `gpt-5-mini`,
`claude-sonnet-5`, `gemini-3.5-flash`, …); the demo defaults to `gpt-4.1`.
