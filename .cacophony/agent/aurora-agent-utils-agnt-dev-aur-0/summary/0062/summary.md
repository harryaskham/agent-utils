# Session summary — realtime 'ws' import fails on Termux/Nix (bd-777edf)

## Goal
P1: Harry's TUI realtime (azure:gpt-realtime-2) fails on Termux/Nix with a module
resolution error loading the 'ws' WebSocket package. Make realtime connect without a
'ws' dependency error.

## Root cause
'ws' is a peerDependency (since the original realtime commit), expected to be provided by
the host Pi. realtime-agent.js does `await import("ws")` with no fallback. On a Pi loaded
from a git checkout on Termux/Nix, the host doesn't provide 'ws', so the import throws a
module-resolution error and /rt start cannot construct a WebSocket. The construction is
'ws'-specific: it passes a `headers` option (auth) and uses EventEmitter .on/.once.

## Fix
New extensions/lib/realtime-ws-fallback.js: createGlobalWebSocketAdapter over Node 22+'s
built-in global WebSocket (undici). The adapter bridges .on/.once -> addEventListener
(unwrapping Events into ws-style (data)/(code,reason)/(errorLike) args) and moves auth out
of the ignored headers option into the URL/subprotocol: Azure api-key -> ?api-key= query
(documented browser pattern, verified via MS docs), OpenAI Bearer -> openai-insecure-api-key
subprotocol. getRealtimeWebSocketConstructor now tries import("ws") first and falls back to
the adapter, with a clear error if neither is available. 'ws' stays primary, so hosts that
provide it are unaffected (no regression).

## Tests
- 9 unit tests: appendQueryParam, auth placement (azure query / openai subprotocol / none),
  null without a global WS, construction + passthrough (send/close/readyState/binaryType),
  event bridging shapes, .once fires once. Full suite 1146 green; npm run check green.

## Operator-takeaway
Realtime now works on a Pi without the 'ws' package (Termux/Nix) by falling back to Node's
built-in WebSocket; the Azure api-key rides in the wss URL query (never logged/echoed).
NOTE: I could not live-test the actual connection on Termux — Harry, please confirm
`/rt azure=true start=vad` connects; if not, the exact close code/error will say whether
it's auth-placement or something else. A /rt-doctor "ws impl: package|global-fallback"
indicator would be a good follow-up for visibility.
