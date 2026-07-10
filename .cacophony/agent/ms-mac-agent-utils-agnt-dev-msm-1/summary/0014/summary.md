# Session summary — pi-wasm S3: browser provider/network layer (streaming validated)

## Goal

Deliver S3 of the pi-wasm epic: make the Pi agent's LLM calls stream from a
browser, client-side, against a CORS-enabled OpenAI-compatible endpoint (the
LiteLLM proxy), using a runtime-injected API key. Before this, msm-0's S1 spike
proved the agent loop *constructs* in-browser but had no working provider, so it
could not actually talk to a model. This session wires the provider seam so a
real streaming completion runs and renders in the browser — the network unblock
the rest of the fleet's slices (S7 chat UI especially) build on.

## Bead(s)

- `bd-cbf86f` — pi-wasm S3: browser provider/network layer — fetch-based pi-ai
  calls + CORS/LiteLLM endpoint (streaming validated). (claimed + implemented
  this session)
- parent epic: `bd-f76cee` — pi-wasm: fully in-browser Pi agent loop
- Also filed+closed `bd-81ae15` (draft capturing Harry's pluggable-exec-backend
  vision) as a duplicate once msm-0 canonically filed S10/S13/S14 for the same.

## Before state

- `./pi-wasm` (S1, commit c427059) constructs `new Agent({ getApiKey })`
  in-browser with zero node polyfills, but no provider/model wiring — no real
  model call possible. `src/main.ts` was construct-proof only.
- S3 external unknowns were already de-risked earlier this session (scratch note
  `pi-wasm-recon`): CORS on the proxy is green, `openai@6.26.0` is isomorphic,
  pi-ai already passes `dangerouslyAllowBrowser`.
- Failing tests: none (pi-wasm is self-contained, gitignored `dist/`/`node_modules`,
  outside the root gate).

## After state

- A real streaming completion runs end-to-end in headless Chrome:
  `<title>pi-wasm S3:ok</title>`, `window.__PI_WASM_S3__ =
  {"ok":true,"text":"Hello to you!","model":"gpt-4.1",
  "baseUrl":"http://100.83.90.42:4000/v1","chunks":14}`. 14 streamed updates
  rendered live; the runtime key never appears in the DOM (verified).
- `npm run typecheck` clean; `npm run build` clean (one expected `node:fs`
  externalization warning from pi-ai's guarded lazy `provider-env.js`; no
  polyfills added — S1 zero-polyfill posture holds; `openai` SDK bundles cleanly).
- README documents the exact endpoint + CORS config used and the S3 browser check.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched:
  - `pi-wasm/src/provider.ts` (new) — S3 provider layer: `makeOpenAICompatModel`,
    `makeOpenAICompatStreamFn` (Path A injected `streamFn` from
    `@earendil-works/pi-ai/compat` `openAICompletionsApi`), `createBrowserAgent`,
    plus `messageText`/`currentAssistantText` render helpers. Reusable by S7.
  - `pi-wasm/src/main.ts` — keeps the S1 construct proof (`__PI_WASM_SPIKE__`);
    adds the S3 streaming demo: runtime-key resolution (form/localStorage/URL/
    global, never hard-coded), live delta rendering, `__PI_WASM_S3__` + DOM/title
    result sink for headless capture, `?autorun=1` for scripted checks.
  - `pi-wasm/index.html` — S3 form (key/model/baseUrl/prompt/run + status) and
    `#stream`/`#result` output.
  - `pi-wasm/README.md` — S3 status, layout, browser-check command, and a
    dedicated "S3 — browser provider/network layer" section documenting the
    endpoint/CORS/wiring.
- Tests: no automated tests added (the browser E2E is the S8 Playwright harness's
  scope; `__PI_WASM_S3__` is exposed for it). Node/browser smokes: typecheck +
  vite build + headless-Chrome streaming run all pass.
- Behavioural delta: the in-browser agent can now perform a real streaming model
  call; provider/CORS is proven to need no operator/proxy change.

## Operator-takeaway

S3 is done and the whole network/CORS risk is retired: the LiteLLM proxy already
speaks CORS, so the in-browser Pi agent streams from it directly with a runtime
key and no proxy changes. The provider layer is a small reusable module
(`src/provider.ts`) that S7's chat UI can build the full loop on immediately.
The key architectural choice — Path A: build on `pi-agent-core`'s `Agent` and
inject a `streamFn` from `pi-ai` rather than going through the node-coupled
`pi-coding-agent` barrel — is what keeps the browser bundle polyfill-free.
