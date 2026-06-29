# Session summary — make direct-azure the default for /rt

## Goal

Make azure=true the default for /rt (operator request, Harry). The default
realtime model gpt-realtime-2 is GA-only and the LiteLLM proxy beta-routes/
rejects it ("only available on the GA API", bd-0b40ce), so defaulting to the
proxy is broken for the default model — direct-Azure is the only working path.
Flip the directAzure default to true, keep explicit proxy overrides, update
tests.

## Bead(s)

- `bd-8b6f12` — Make direct-azure the default for /rt (proxy GA-rejects the default gpt-realtime-2 model)

## Before state

- Failing tests: none (suite green; 4 green CI checks).
- `makeInitialConfig().directAzure` defaulted to `false` (proxy) unless PI_RT_DIRECT_AZURE=1 / PI_RT_PROVIDER=azure.
- /rt start with the default gpt-realtime-2 model hit the proxy, which GA-rejects it; users had to type `/rt azure=true` every time.

## After state

- Failing tests: none. realtime test files green (133/133).
- `directAzure` now defaults to TRUE via `resolveDirectAzureDefault()`: PI_RT_PROVIDER=azure forces azure; PI_RT_PROVIDER=openai|proxy forces proxy; PI_RT_DIRECT_AZURE=0|1 forces either; otherwise default azure.
- /rt start now uses direct-Azure (the working GA path) by default; proxy is opt-in via PI_RT_DIRECT_AZURE=0 or PI_RT_PROVIDER=openai.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: extensions/lib/realtime-config.js (new resolveDirectAzureDefault + flipped default), test/realtime-config.test.js (default+override coverage), test/realtime-agent.test.js (3 assertions/2 proxy-pinned tests updated for the new default).
- Tests: +0 net new files / updated ~4 assertions; realtime suite 133/133.
- Behavioural delta: /rt defaults to direct-Azure; proxy is now opt-in.

## Operator-takeaway

/rt now connects to Azure GA realtime by default, which is the only path that
serves the default gpt-realtime-2 model (the proxy GA-rejects it). Set
PI_RT_DIRECT_AZURE=0 or PI_RT_PROVIDER=openai to use the proxy/OpenAI path.
Cascade direct-Azure-REST synthesis (azure=true) is a separate follow-up.
