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

## Layout

```
pi-wasm/
  index.html            # entry page; renders the spike result into #out
  src/main.ts           # imports the SDK, constructs Agent in-browser (Path A)
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

## Roadmap (epic bd-f76cee)

S2 IndexedDB VFS (`BrowserExecutionEnv`) · S3 provider/CORS layer ·
S4 tools over the VFS (no bash) · S5 isomorphic-git checkout · S6 settings/keys
screen · S7 chat UI wiring the full loop (MVP) · S8 Playwright harness ·
S9 nix build/serve · S10 (stretch) bash-in-browser.

`node_modules/` and `dist/` are gitignored; this subproject is self-contained
and does not affect the agent-utils root build/test gate.
