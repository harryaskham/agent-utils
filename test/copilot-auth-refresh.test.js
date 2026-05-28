import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import copilotAuthRefreshExtension, { installCopilotAuthRefresh } from "../extensions/copilot-auth-refresh.js";

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

test("package.json advertises copilot auth refresh extension", async () => {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  assert.ok(pkg.pi.extensions.includes("./extensions/copilot-auth-refresh.js"));
});
