// Fallback realtime WebSocket over Node's built-in global WebSocket (undici,
// Node >= 22), for environments where the 'ws' package is not resolvable —
// e.g. a Pi loaded from a git checkout on Termux/Nix where 'ws' (a peer
// dependency) is not provided by the host (bd-777edf).
//
// The realtime code is written against the 'ws' package API: EventEmitter
// .on/.once handlers and a `headers` option for auth. The global WhatWG
// WebSocket has neither — it uses addEventListener and ignores custom headers —
// so this adapter bridges the two:
//   - .on/.once(type, cb) -> addEventListener, unwrapping the browser Event into
//     the (data) / (code, reason) / (errorLike) argument shapes 'ws' delivers;
//   - auth moves out of the (ignored) headers option into the URL/subprotocol:
//       Azure  api-key header        -> ?api-key=<key> query (documented browser
//                                       pattern; the header is not sendable here)
//       OpenAI Authorization: Bearer -> openai-insecure-api-key.<key> subprotocol
//
// The api key only ever lives in the live wss connect URL/subprotocol passed to
// the global WebSocket; it is never logged or echoed (the snapshot effectiveUrl
// is built separately and omits the key).

export function appendQueryParam(url, key, value) {
  const u = String(url == null ? "" : url);
  const sep = u.includes("?") ? "&" : "?";
  return `${u}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

// Translate the 'ws'-style { headers } auth into a global-WebSocket-compatible
// (url, protocols) pair. Pure; returns { url, protocols } (protocols undefined
// when none are needed).
export function globalWsAuthFromHeaders(url, headers = {}) {
  const h = headers || {};
  // Azure: api-key header -> query param (browser-supported; the header is not).
  const apiKey = h["api-key"] ?? h["Api-Key"] ?? h["API-KEY"];
  if (apiKey) {
    return { url: appendQueryParam(url, "api-key", apiKey), protocols: undefined };
  }
  // OpenAI: Authorization: Bearer <key> -> insecure-api-key subprotocol (the
  // documented browser pattern), plus a beta subprotocol when the beta header
  // is set.
  const auth = h["Authorization"] || h["authorization"];
  if (auth && /^Bearer\s+/i.test(auth)) {
    const key = auth.replace(/^Bearer\s+/i, "").trim();
    const protocols = ["realtime", `openai-insecure-api-key.${key}`];
    const beta = h["OpenAI-Beta"] || h["openai-beta"];
    if (beta) protocols.push(`openai-beta.${String(beta).replace(/[^A-Za-z0-9._-]/g, "-")}`);
    return { url, protocols };
  }
  return { url, protocols: undefined };
}

function makeErrorLike(event) {
  if (event instanceof Error) return event;
  const msg =
    (event && (event.message || (event.error && event.error.message) || event.reason)) ||
    "WebSocket error";
  return { message: String(msg) };
}

// Build a 'ws'-compatible constructor backed by the global WebSocket, or null
// when no global WebSocket is available (older Node without the built-in).
export function createGlobalWebSocketAdapter(GlobalWS = globalThis.WebSocket) {
  if (typeof GlobalWS !== "function") return null;

  class GlobalWebSocketAdapter {
    constructor(url, options = {}) {
      const { url: authedUrl, protocols } = globalWsAuthFromHeaders(
        url,
        options && options.headers,
      );
      this._ws = protocols && protocols.length
        ? new GlobalWS(authedUrl, protocols)
        : new GlobalWS(authedUrl);
    }

    _wrap(type, cb) {
      if (type === "message") return (event) => cb(event && event.data);
      if (type === "close") return (event) => cb(event && event.code, event && event.reason);
      if (type === "error") return (event) => cb(makeErrorLike(event));
      // open (and any other) -> no payload, matching 'ws'.
      return () => cb();
    }

    on(type, cb) {
      this._ws.addEventListener(type, this._wrap(type, cb));
      return this;
    }

    once(type, cb) {
      this._ws.addEventListener(type, this._wrap(type, cb), { once: true });
      return this;
    }

    send(data) {
      return this._ws.send(data);
    }

    close(code, reason) {
      try {
        return code === undefined ? this._ws.close() : this._ws.close(code, reason);
      } catch {
        return this._ws.close();
      }
    }

    get readyState() {
      return this._ws.readyState;
    }

    get binaryType() {
      return this._ws.binaryType;
    }

    set binaryType(value) {
      this._ws.binaryType = value;
    }
  }

  GlobalWebSocketAdapter.OPEN = Number.isFinite(Number(GlobalWS.OPEN)) ? GlobalWS.OPEN : 1;
  return GlobalWebSocketAdapter;
}
