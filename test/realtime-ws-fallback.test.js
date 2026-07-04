import test from "node:test";
import assert from "node:assert/strict";
import {
  appendQueryParam,
  globalWsAuthFromHeaders,
  createGlobalWebSocketAdapter,
  setRealtimeWebSocketImplKind,
  getRealtimeWebSocketImplKind,
} from "../extensions/lib/realtime-ws-fallback.js";

// Minimal fake of the WhatWG/global WebSocket for adapter tests.
function makeFakeGlobalWS() {
  class FakeWS {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.binaryType = "blob";
      this.sent = [];
      this.closed = null;
      this._listeners = {};
      FakeWS._instances.push(this);
    }
    addEventListener(type, cb, opts) {
      (this._listeners[type] ||= []).push({ cb, once: !!(opts && opts.once) });
    }
    removeEventListener(type, cb) {
      const ls = this._listeners[type];
      if (ls) this._listeners[type] = ls.filter((l) => l.cb !== cb);
    }
    dispatch(type, event) {
      const ls = this._listeners[type] || [];
      this._listeners[type] = ls.filter((l) => !l.once);
      for (const l of ls) l.cb(event);
    }
    send(d) { this.sent.push(d); }
    close(code, reason) { this.closed = { code, reason }; }
  }
  FakeWS.OPEN = 1;
  FakeWS._instances = [];
  return FakeWS;
}

test("appendQueryParam adds ?/& and url-encodes (bd-777edf)", () => {
  assert.equal(appendQueryParam("wss://h/p", "api-key", "a b"), "wss://h/p?api-key=a%20b");
  assert.equal(appendQueryParam("wss://h/p?model=x", "api-key", "k"), "wss://h/p?model=x&api-key=k");
});

test("globalWsAuthFromHeaders: azure api-key -> query param, no subprotocol", () => {
  const r = globalWsAuthFromHeaders("wss://h/openai/v1/realtime?model=d", { "api-key": "secret", "User-Agent": "x" });
  assert.equal(r.url, "wss://h/openai/v1/realtime?model=d&api-key=secret");
  assert.equal(r.protocols, undefined);
});

test("globalWsAuthFromHeaders: openai Bearer -> insecure-api-key subprotocol (+beta)", () => {
  const r = globalWsAuthFromHeaders("wss://api.openai.com/v1/realtime", { Authorization: "Bearer sk-123", "OpenAI-Beta": "realtime=v1" });
  assert.equal(r.url, "wss://api.openai.com/v1/realtime");
  assert.deepEqual(r.protocols, ["realtime", "openai-insecure-api-key.sk-123", "openai-beta.realtime-v1"]);
});

test("globalWsAuthFromHeaders: no auth headers -> unchanged", () => {
  const r = globalWsAuthFromHeaders("wss://h/p", { "User-Agent": "x" });
  assert.equal(r.url, "wss://h/p");
  assert.equal(r.protocols, undefined);
});

test("adapter .off/.removeListener remove a registered listener (bd-5b816a: no ws.off crash)", () => {
  const FakeWS = makeFakeGlobalWS();
  const Adapter = createGlobalWebSocketAdapter(FakeWS);
  const ws = new Adapter("wss://h/p", {});
  const inner = FakeWS._instances[0];
  // The absence of these threw "ws.off is not a function" and crashed pi.
  assert.equal(typeof ws.off, "function");
  assert.equal(typeof ws.removeListener, "function");

  // off() before dispatch removes the exact wrapper so the cb never fires.
  let msgCalls = 0;
  const onMsg = () => { msgCalls++; };
  ws.once("message", onMsg);
  ws.off("message", onMsg);
  inner.dispatch("message", { data: "x" });
  assert.equal(msgCalls, 0, "off removed the once listener before it could fire");

  // A live once listener still fires and unwraps event.data like 'ws'.
  let got = null;
  ws.once("message", (d) => { got = d; });
  inner.dispatch("message", { data: "hello" });
  assert.equal(got, "hello");

  // recvOnce's exact shape: once(message/close/error) + off(all three) must not throw.
  const closeCb = () => {};
  const errCb = () => {};
  ws.once("close", closeCb);
  ws.once("error", errCb);
  assert.doesNotThrow(() => { ws.off("message", onMsg); ws.off("close", closeCb); ws.off("error", errCb); });
});

// bd-72c993: ws-surface contract. realtime-agent.js drives the WebSocket through this
// exact EventEmitter-style surface (recvOnce/connect/send/close). The undici fallback
// adapter MUST provide every method the real 'ws' package would, or cleanup crashes pi
// on git-checkout hosts where 'ws' is unresolvable (bd-5b816a: the missing .off). The
// real 'ws' inherits on/once/off/removeListener from EventEmitter, so only the shim can
// drift; keep this list in sync with the ws.<method>( call sites in realtime-agent.js.
const REQUIRED_WS_SURFACE = ["on", "once", "off", "removeListener", "send", "close"];

test("ws-surface contract: fallback adapter provides every method the realtime code calls (bd-72c993)", () => {
  const FakeWS = makeFakeGlobalWS();
  const Adapter = createGlobalWebSocketAdapter(FakeWS);
  const ws = new Adapter("wss://h/p", { headers: { "api-key": "k" } });
  for (const method of REQUIRED_WS_SURFACE) {
    assert.equal(typeof ws[method], "function", `fallback adapter is missing ws.${method}() — realtime code calls it`);
  }
});

test("ws-surface contract: the recvOnce register-then-cleanup lifecycle never throws and removes all listeners (bd-72c993)", () => {
  const FakeWS = makeFakeGlobalWS();
  const Adapter = createGlobalWebSocketAdapter(FakeWS);
  const ws = new Adapter("wss://h/p", { headers: { "api-key": "k" } });
  const inner = FakeWS._instances[0];

  // Exactly recvOnce's shape: one-shot listeners on message/close/error, then off()
  // all three in cleanup (bd-5b816a's missing .off crashed pi right here).
  let msg = 0, close = 0, err = 0;
  const onMessage = () => { msg++; };
  const onClose = () => { close++; };
  const onError = () => { err++; };
  ws.once("message", onMessage);
  ws.once("close", onClose);
  ws.once("error", onError);
  assert.doesNotThrow(() => {
    ws.off("message", onMessage);
    ws.off("close", onClose);
    ws.off("error", onError);
  }, "recvOnce cleanup (off message/close/error) must not throw");
  inner.dispatch("message", { data: "x" });
  inner.dispatch("close", { code: 1000 });
  inner.dispatch("error", { message: "e" });
  assert.deepEqual([msg, close, err], [0, 0, 0], "off() removed every recvOnce listener before it could fire");

  // The persistent listeners connect() installs (on message/close) keep firing.
  const seen = [];
  ws.on("message", (d) => seen.push(d));
  inner.dispatch("message", { data: "a" });
  inner.dispatch("message", { data: "b" });
  assert.deepEqual(seen, ["a", "b"], "on(message) persists across dispatches");
});

test("createGlobalWebSocketAdapter returns null without a global WebSocket", () => {
  // Pass an explicit non-function (undefined would trigger the globalThis.WebSocket default).
  assert.equal(createGlobalWebSocketAdapter(null), null);
  assert.equal(createGlobalWebSocketAdapter({}), null);
});

test("adapter constructs the global WS with azure query auth + passthrough + OPEN", () => {
  const FakeWS = makeFakeGlobalWS();
  const Adapter = createGlobalWebSocketAdapter(FakeWS);
  assert.equal(Adapter.OPEN, 1);
  const ws = new Adapter("wss://h/openai/v1/realtime?model=d", { headers: { "api-key": "secret" } });
  const inner = FakeWS._instances[0];
  assert.equal(inner.url, "wss://h/openai/v1/realtime?model=d&api-key=secret");
  assert.equal(inner.protocols, undefined);
  ws.binaryType = "arraybuffer";
  assert.equal(inner.binaryType, "arraybuffer");
  ws.send("hi");
  assert.deepEqual(inner.sent, ["hi"]);
  inner.readyState = 1;
  assert.equal(ws.readyState, 1);
  ws.close();
  assert.deepEqual(inner.closed, { code: undefined, reason: undefined });
});

test("adapter constructs with openai subprotocol auth", () => {
  const FakeWS = makeFakeGlobalWS();
  const Adapter = createGlobalWebSocketAdapter(FakeWS);
  new Adapter("wss://api.openai.com/v1/realtime", { headers: { Authorization: "Bearer sk-9" } });
  assert.deepEqual(FakeWS._instances[0].protocols, ["realtime", "openai-insecure-api-key.sk-9"]);
});

test("adapter bridges .once/.on events into ws-style argument shapes", () => {
  const FakeWS = makeFakeGlobalWS();
  const Adapter = createGlobalWebSocketAdapter(FakeWS);
  const ws = new Adapter("wss://h/p", { headers: { "api-key": "k" } });
  const inner = FakeWS._instances[0];

  let opened = 0; ws.once("open", () => { opened += 1; });
  const messages = []; ws.on("message", (data) => messages.push(data));
  let closeArgs = null; ws.once("close", (code, reason) => { closeArgs = { code, reason }; });
  let errMsg = null; ws.once("error", (e) => { errMsg = e.message; });

  inner.dispatch("open", {});
  inner.dispatch("message", { data: '{"type":"session.created"}' });
  inner.dispatch("message", { data: "second" });
  inner.dispatch("error", { message: "boom" });
  inner.dispatch("close", { code: 1006, reason: "gone" });

  assert.equal(opened, 1, "open bridged with no args");
  assert.deepEqual(messages, ['{"type":"session.created"}', "second"], ".on(message) receives event.data and fires repeatedly");
  assert.deepEqual(closeArgs, { code: 1006, reason: "gone" }, "close bridged to (code, reason)");
  assert.equal(errMsg, "boom", "error bridged to an Error-like with .message");
});

test("adapter .once fires at most once (auto-removed)", () => {
  const FakeWS = makeFakeGlobalWS();
  const Adapter = createGlobalWebSocketAdapter(FakeWS);
  const ws = new Adapter("wss://h/p", {});
  const inner = FakeWS._instances[0];
  let n = 0; ws.once("message", () => { n += 1; });
  inner.dispatch("message", { data: "a" });
  inner.dispatch("message", { data: "b" });
  assert.equal(n, 1, "once handler fires a single time");
});

test("realtime WebSocket impl kind set/get round-trips for /rt-doctor (bd-828f2d)", () => {
  const prev = getRealtimeWebSocketImplKind();
  try {
    assert.equal(setRealtimeWebSocketImplKind("ws"), "ws");
    assert.equal(getRealtimeWebSocketImplKind(), "ws");
    assert.equal(setRealtimeWebSocketImplKind("global-fallback"), "global-fallback");
    assert.equal(getRealtimeWebSocketImplKind(), "global-fallback");
    assert.equal(setRealtimeWebSocketImplKind(""), null, "falsy clears to null");
    assert.equal(getRealtimeWebSocketImplKind(), null);
  } finally {
    setRealtimeWebSocketImplKind(prev);
  }
});
