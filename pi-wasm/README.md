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
See **[FEASIBILITY.md](./FEASIBILITY.md)** for the full analysis, the two viable
build paths, and the per-dependency breakdown.

**S3 (browser provider / network layer, bd-cbf86f): done.** A real streaming
model call runs end-to-end in the browser against a CORS-enabled
OpenAI-compatible endpoint (the LiteLLM proxy), using a **runtime** key (never
hard-coded). Validated in headless Chrome: the page streams a completion and
sets `window.__PI_WASM_S3__ = { ok: true, text, model, baseUrl, chunks }`. See
[**S3 — provider/network layer**](#s3--browser-providernetwork-layer) below.

**S5 (isomorphic-git checkout, bd-3f7a4f): done.** Real git over the shared S2
VFS — `clone` / `checkout` / `listFiles` / `log` plus local `init` / `add` /
`commit`, exposed as browser-clean `git_*` `AgentTool`s. Because git drives the
same lightning-fs store as `BrowserExecutionEnv`, a clone is instantly visible to
the file tools. Deterministic network-free tests; the CORS-proxy contract is in
**[src/git/README.md](./src/git/README.md)**.

## Layout

```
pi-wasm/
  index.html            # entry page; renders the spike result into #out
  src/main.ts           # construct proof (S1) + S3 streaming demo UI
  src/provider.ts       # S3 provider layer: OpenAI-compat model + injected streamFn (Path A)
  src/vfs/              # S2 IndexedDB VFS + BrowserExecutionEnv (shared store)
  src/git/              # S5 isomorphic-git over the shared VFS (+ git_* tools)
  scripts/construct-smoke.mjs  # Node-side construct smoke (npm run spike:node)
  vite.config.ts        # browser build; intentionally NO node polyfills (S1)
  tsconfig.json
  FEASIBILITY.md        # the S1 deliverable — read this
```

## Develop / build / verify

```bash
cd pi-wasm
npm install
npm run spike:node     # Node ESM construct smoke -> "CONSTRUCT-SMOKE: PASS"
npm run build          # vite browser build -> dist/
npm run dev            # vite dev server (http://localhost:5173)

# Real-browser check (what the S1 spike used):
( cd dist && python3 -m http.server 4321 & )
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --user-data-dir=/tmp/piwasm-chrome \
  --virtual-time-budget=10000 --dump-dom http://localhost:4321/
# -> #out contains "... CONSTRUCTS in-browser ... PASS"
```

The page also sets `window.__PI_WASM_SPIKE__ = { ok, detail }` for the S8
Playwright harness to assert on.

### S3 real-browser streaming check

```bash
npm run build
( cd dist && python3 -m http.server 4321 & )
# Provide a runtime key at load time (URL param, not committed). autorun=1 fires
# one streaming call; the page never renders the key.
KEY="$OPENAI_API_KEY"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --user-data-dir=/tmp/piwasm-chrome-s3 \
  --no-first-run --virtual-time-budget=15000 --dump-dom \
  "http://localhost:4321/?autorun=1&model=gpt-4.1&prompt=Say%20hi%20in%20three%20words&key=$KEY"
# -> <title>pi-wasm S3:ok</title> and
#    #result = {"ok":true,"text":"...","model":"gpt-4.1","baseUrl":"http://100.83.90.42:4000/v1","chunks":N}
```

Interactively (`npm run dev`), just enter a key in the S3 form and press **Run**;
the key is kept only in this browser (`localStorage`, the S6 settings-screen seam).

## Roadmap (epic bd-f76cee)

S2 IndexedDB VFS (`BrowserExecutionEnv`) · **S3 provider/CORS layer ✅** ·
S4 tools over the VFS (no bash) · **S5 isomorphic-git checkout ✅** · S6
settings/keys screen · S7 chat UI wiring the full loop (MVP) · S8 Playwright
harness · S9 nix build/serve · S10 (stretch) bash-in-browser.

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
  (form / `localStorage` / URL param / `window.__PI_WASM_KEY__`) and **never**
  committed or hard-coded.

**Wiring (`src/provider.ts`, Path A):**

- `makeOpenAICompatModel()` builds a `Model<"openai-completions">` whose
  `baseUrl` points at the endpoint.
- `makeOpenAICompatStreamFn()` returns a `StreamFn` from pi-ai's
  `openAICompletionsApi()` (`@earendil-works/pi-ai/compat`), which lazily loads
  the isomorphic `openai` SDK on first stream and uses global `fetch` + SSE.
- `createBrowserAgent()` assembles `new Agent({ initialState: { model }, streamFn,
  getApiKey })`. `agent.prompt(text)` then streams; text deltas are read from
  `agent.state.streamingMessage` / `messages` and rendered live.

**Bundle note:** the only Node builtin vite externalizes is `node:fs` (pulled by
pi-ai's lazy `utils/provider-env.js`, guarded by `process.versions?.node` and
never executed in a browser), so **no polyfills were added** — the S1 zero-polyfill
posture holds. The `openai` SDK bundles cleanly (isomorphic, web-stream shims).

**Model choice:** any id the proxy exposes works (`gpt-4.1`, `gpt-5-mini`,
`claude-sonnet-5`, `gemini-3.5-flash`, …); the demo defaults to `gpt-4.1`.
