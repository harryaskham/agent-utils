import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import copilotAuthRefreshExtension, { installCopilotAuthRefresh, MAX_COPILOT_AUTH_RETRIES, underlyingRetryText, COPILOT_RETRY_INJECTION_PREFIX } from "../extensions/copilot-auth-refresh.js";

test("copilot auth refresh patches hasConfiguredAuth for stale GitHub Copilot auth", () => {
  let reloads = 0;
  let hasAuth = false;
  const registry = {
    authStorage: { reload() { reloads += 1; hasAuth = true; } },
    hasConfiguredAuth(model) { return model.provider === "github-copilot" && hasAuth; },
  };
  const notifications = [];
  assert.equal(installCopilotAuthRefresh(registry, { notify: (message) => notifications.push(message) }), true);
  assert.equal(registry.hasConfiguredAuth({ provider: "github-copilot", id: "gpt-5.5" }), true);
  assert.equal(reloads, 1);
  assert.match(notifications[0], /stale/);
});

test("copilot auth refresh retries getApiKeyAndHeaders after auth storage reload", async () => {
  let reloads = 0;
  let hasAuth = false;
  const registry = {
    authStorage: { reload() { reloads += 1; hasAuth = true; } },
    async getApiKeyAndHeaders(model) {
      if (model.provider !== "github-copilot") return { ok: true, apiKey: "other" };
      return hasAuth ? { ok: true, apiKey: "copilot-token" } : { ok: false, error: "No API key for provider: github-copilot" };
    },
  };
  assert.equal(installCopilotAuthRefresh(registry), true);
  assert.deepEqual(await registry.getApiKeyAndHeaders({ provider: "github-copilot", id: "gpt-5.5" }), { ok: true, apiKey: "copilot-token" });
  assert.equal(reloads, 1);
});

test("copilot auth refresh does not patch non-Copilot missing auth", async () => {
  let reloads = 0;
  const registry = {
    authStorage: { reload() { reloads += 1; } },
    hasConfiguredAuth() { return false; },
    async getApiKeyAndHeaders() { return { ok: false, error: "No API key for provider: openai" }; },
  };
  installCopilotAuthRefresh(registry);
  assert.equal(registry.hasConfiguredAuth({ provider: "openai", id: "gpt-5" }), false);
  assert.deepEqual(await registry.getApiKeyAndHeaders({ provider: "openai", id: "gpt-5" }), { ok: false, error: "No API key for provider: openai" });
  assert.equal(reloads, 0);
});

test("copilot auth refresh extension registers session patch hook and command", () => {
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, def) { commands.set(name, def); },
  };
  copilotAuthRefreshExtension(pi);
  assert.equal(typeof handlers.get("session_start"), "function");
  assert.equal(typeof handlers.get("agent_end"), "function");
  assert.equal(typeof commands.get("copilot-auth-refresh")?.handler, "function");
});

test("copilot auth refresh agent_end fallback reloads and queues one retry", async () => {
  const handlers = new Map();
  const sent = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    sendUserMessage(text, options) { sent.push({ text, options }); },
  };
  copilotAuthRefreshExtension(pi);
  let reloads = 0;
  const ctx = {
    modelRegistry: { authStorage: { reload() { reloads += 1; } } },
    ui: { notify() {} },
  };
  const event = { messages: [
    { role: "user", content: [{ type: "text", text: "do the work" }] },
    { role: "assistant", stopReason: "error", errorMessage: "No API key for provider: github-copilot", timestamp: 1 },
  ] };
  await handlers.get("agent_end")(event, ctx);
  await handlers.get("agent_end")(event, ctx);
  assert.equal(reloads, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Retry the previous request now:\n\ndo the work/);
  assert.deepEqual(sent[0].options, { deliverAs: "followUp" });
});

test("copilot auth refresh bounds retries across distinct failure timestamps (no storm)", async () => {
  const handlers = new Map();
  const sent = [];
  const notes = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    sendUserMessage(text, options) { sent.push({ text, options }); },
  };
  copilotAuthRefreshExtension(pi);
  const ctx = {
    modelRegistry: { authStorage: { reload() {} } },
    ui: { notify(message, level) { notes.push({ message, level }); } },
  };
  const makeEvent = (ts) => ({ messages: [
    { role: "user", content: [{ type: "text", text: "do the work" }] },
    { role: "assistant", stopReason: "error", errorMessage: "No API key for provider: github-copilot", timestamp: ts },
  ] });
  // Five successive failures with DISTINCT timestamps but the same retry text.
  for (let ts = 1; ts <= 5; ts += 1) {
    await handlers.get("agent_end")(makeEvent(ts), ctx);
  }
  // Injections are capped at MAX_COPILOT_AUTH_RETRIES regardless of distinct timestamps.
  assert.equal(sent.length, MAX_COPILOT_AUTH_RETRIES);
  // After the cap, a terminal error notify is emitted instead of more injections.
  assert.ok(notes.some((n) => n.level === "error" && /not re-injecting/i.test(n.message)));
});

test("underlyingRetryText strips one or more nested injection prefixes", () => {
  assert.equal(underlyingRetryText("do the work"), "do the work");
  assert.equal(underlyingRetryText(`${COPILOT_RETRY_INJECTION_PREFIX}do the work`), "do the work");
  assert.equal(
    underlyingRetryText(`${COPILOT_RETRY_INJECTION_PREFIX}${COPILOT_RETRY_INJECTION_PREFIX}do the work`),
    "do the work",
  );
});

test("copilot auth refresh bounds retries when the injected message feeds back as the next request (real storm loop)", async () => {
  // Regression for bd-57477b: the injected retry message becomes the next
  // turn's most recent user message. If the budget keys on the raw text it
  // resets every cycle and storms unbounded. Simulate the true loop by feeding
  // each injected message back in as the next lastUser.
  const handlers = new Map();
  const sent = [];
  const notes = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    sendUserMessage(text, options) { sent.push({ text, options }); },
  };
  copilotAuthRefreshExtension(pi);
  const ctx = {
    modelRegistry: { authStorage: { reload() {} } },
    ui: { notify(message, level) { notes.push({ message, level }); } },
  };
  // Start with the original user request; thereafter the most recent user
  // message is whatever the extension last injected.
  let currentUserText = "do the work";
  for (let ts = 1; ts <= 5; ts += 1) {
    const event = { messages: [
      { role: "user", content: [{ type: "text", text: currentUserText }] },
      { role: "assistant", stopReason: "error", errorMessage: "No API key for provider: github-copilot", timestamp: ts },
    ] };
    const before = sent.length;
    await handlers.get("agent_end")(event, ctx);
    if (sent.length > before) currentUserText = sent[sent.length - 1].text; // feed injected text back
  }
  // Despite the request text mutating each cycle, the bound holds.
  assert.equal(sent.length, MAX_COPILOT_AUTH_RETRIES);
  // Every injected message carries exactly one prefix (no nested accretion).
  for (const s of sent) {
    assert.ok(s.text.startsWith(COPILOT_RETRY_INJECTION_PREFIX));
    assert.equal(underlyingRetryText(s.text), "do the work");
  }
  // Terminal error notify fires instead of storming.
  assert.ok(notes.some((n) => n.level === "error" && /not re-injecting/i.test(n.message)));
});

test("copilot auth refresh resets retry budget when the request text changes", async () => {
  const handlers = new Map();
  const sent = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    sendUserMessage(text, options) { sent.push({ text, options }); },
  };
  copilotAuthRefreshExtension(pi);
  const ctx = { modelRegistry: { authStorage: { reload() {} } }, ui: { notify() {} } };
  const makeEvent = (ts, work) => ({ messages: [
    { role: "user", content: [{ type: "text", text: work }] },
    { role: "assistant", stopReason: "error", errorMessage: "No API key for provider: github-copilot", timestamp: ts },
  ] });
  // Exhaust budget on request A.
  for (let ts = 1; ts <= 4; ts += 1) await handlers.get("agent_end")(makeEvent(ts, "work A"), ctx);
  assert.equal(sent.length, MAX_COPILOT_AUTH_RETRIES);
  // A different request text gets a fresh budget.
  await handlers.get("agent_end")(makeEvent(10, "work B"), ctx);
  assert.equal(sent.length, MAX_COPILOT_AUTH_RETRIES + 1);
});

test("package.json advertises copilot auth refresh extension", async () => {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  assert.ok(pkg.pi.extensions.includes("./extensions/copilot-auth-refresh.js"));
});
