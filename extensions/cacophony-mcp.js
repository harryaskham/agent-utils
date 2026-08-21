// Session-scoped Cacophony MCP registration (bd-b21029).
//
// Uses pi-mcp-adapter's public runtime registration API. Managed identities are
// available immediately; visiting identities arrive through the shared runtime
// listener after successful registration. Nothing is persisted to settings or
// copied into the parent process environment.

import { createRequire } from "node:module";

import {
  getCacophonyRuntimeIdentity,
  isPiCacoDisabled,
  onCacophonyRuntimeIdentity,
} from "./lib/cacophony-runtime.js";
import { buildCacophonyMcpRegistration } from "./lib/cacophony-mcp.js";

export function scopedAdapterPi(pi) {
  const proxyToolName = "caco_mcp";
  return new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") {
        return (definition) => target.registerTool({
          ...definition,
          name: definition?.name === "mcp" ? proxyToolName : definition?.name,
          label: definition?.name === "mcp" ? "Cacophony MCP" : definition?.label,
        });
      }
      if (property === "registerCommand") {
        return (name, definition) => target.registerCommand(`caco-${name}`, definition);
      }
      if (property === "getActiveTools") {
        return () => (target.getActiveTools?.() || []).map((name) => name === proxyToolName ? "mcp" : name);
      }
      if (property === "setActiveTools") {
        return (names) => target.setActiveTools?.((names || []).map((name) => name === "mcp" ? proxyToolName : name));
      }
      if (property === "getAllTools") {
        return () => (target.getAllTools?.() || []).map((tool) => tool?.name === proxyToolName ? { ...tool, name: "mcp" } : tool);
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createScopedAdapterRegistrar(adapter) {
  if (typeof adapter?.createMcpAdapter !== "function") throw new Error("pi-mcp-adapter exposes neither runtime registration nor createMcpAdapter");
  // pi-mcp-adapter 2.25 exposes programmatic isolated configuration but not the
  // newer runtime-registration helper. Activate a session-owned adapter through
  // a scoped Pi facade: its single proxy tool is caco_mcp and its slash commands
  // are caco-prefixed, so it composes with the operator's normal multi-server
  // adapter instead of replacing the existing `mcp` surface.
  return ({ pi, name, definition }) => {
    const extension = adapter.createMcpAdapter({ config: { mcpServers: { [name]: definition } } });
    extension(scopedAdapterPi(pi));
    return {
      compatAdapter: true,
      // The adapter registers its own session_shutdown handler and owns the
      // transport. This compatibility handle intentionally delegates teardown
      // to that lifecycle rather than reaching into adapter internals.
      async dispose() {},
    };
  };
}

async function loadRegisterMcpServer() {
  let adapter;
  try {
    adapter = await import("pi-mcp-adapter");
  } catch (nativeError) {
    // Resolve from THIS package root. Pi package module roots are intentionally
    // isolated, and its extension loader does not guarantee that a dynamic bare
    // import can see nested dependencies even when npm installed them.
    const require = createRequire(import.meta.url);
    let createJiti;
    try { ({ createJiti } = require("jiti")); }
    catch { throw nativeError; }
    const jiti = createJiti(import.meta.url);
    try { adapter = await jiti.import(require.resolve("pi-mcp-adapter")); }
    catch { throw nativeError; }
  }
  if (typeof adapter.registerMcpServer === "function") return adapter.registerMcpServer;
  return createScopedAdapterRegistrar(adapter);
}

export function createCacophonyMcpExtension({ env = process.env, registerServer, loadRegister = loadRegisterMcpServer } = {}) {
  return function cacophonyMcpExtension(pi) {
    let sessionCtx = null;
    let registration = null;
    let registrationKey = null;
    let operation = Promise.resolve();
    let generation = 0;
    let stopped = false;
    let warned = false;

    const warnOnce = (error) => {
      if (warned || stopped) return;
      warned = true;
      try { sessionCtx?.ui?.notify?.(`Cacophony MCP unavailable; Pi remains functional: ${error?.message || String(error)}`, "warning"); } catch {}
    };

    const enqueueIdentity = (identity) => {
      const plan = buildCacophonyMcpRegistration(identity, env);
      if (!plan || stopped) return operation;
      const requestedGeneration = ++generation;
      operation = operation.then(async () => {
        if (stopped || requestedGeneration !== generation) return;
        if (registration && registrationKey === plan.identityKey) return;
        if (registration?.compatAdapter) {
          warnOnce(new Error("Cacophony MCP identity changed; reload Pi to replace the compatibility adapter cleanly"));
          return;
        }
        if (registration) {
          try { await registration.dispose(); } catch {}
          registration = null;
          registrationKey = null;
        }
        try {
          const register = registerServer || await loadRegister();
          const next = register({ pi, name: plan.name, definition: plan.definition });
          if (!next || typeof next.dispose !== "function") throw new Error("pi-mcp-adapter returned no disposable registration");
          if (stopped || requestedGeneration !== generation) {
            await next.dispose();
            return;
          }
          registration = next;
          registrationKey = plan.identityKey;
          warned = false;
          try { sessionCtx?.ui?.notify?.(`Cacophony MCP connected for ${identity.agentId} in ${identity.project}.`, "info"); } catch {}
        } catch (error) {
          warnOnce(error);
        }
      });
      return operation;
    };

    const unsubscribeIdentity = onCacophonyRuntimeIdentity((identity) => { void enqueueIdentity(identity); });

    pi.registerCommand?.("caco-mcp", {
      description: "Show transient Cacophony MCP registration state for this Pi session.",
      handler: async (_args, ctx) => {
        const identity = getCacophonyRuntimeIdentity(env);
        const status = isPiCacoDisabled(env)
          ? "disabled by DISABLE_PI_CACO"
          : registration
            ? `registered as ${registrationKey}`
            : identity.agentId && identity.project
              ? `waiting for adapter registration as ${identity.project}:${identity.agentId}`
              : "waiting for a managed or visiting identity";
        ctx.ui?.notify?.(`caco-mcp: ${status}`, "info");
      },
    });

    pi.on("session_start", (_event, ctx) => {
      sessionCtx = ctx;
      stopped = false;
      if (isPiCacoDisabled(env)) return;
      void enqueueIdentity(getCacophonyRuntimeIdentity(env));
    });

    pi.on("session_shutdown", async () => {
      stopped = true;
      generation += 1;
      unsubscribeIdentity();
      try { await operation; } catch {}
      const owned = registration;
      registration = null;
      registrationKey = null;
      if (owned) {
        try { await owned.dispose(); } catch {}
      }
      sessionCtx = null;
    });
  };
}

export default createCacophonyMcpExtension();
