// Session-scoped Cacophony MCP registration (bd-b21029).
//
// Uses pi-mcp-adapter's public runtime registration API. Managed identities are
// available immediately; visiting identities arrive through the shared runtime
// listener after successful registration. Nothing is persisted to settings or
// copied into the parent process environment.

import {
  getCacophonyRuntimeIdentity,
  isPiCacoDisabled,
  onCacophonyRuntimeIdentity,
} from "./lib/cacophony-runtime.js";
import { buildCacophonyMcpRegistration } from "./lib/cacophony-mcp.js";

async function loadRegisterMcpServer() {
  const adapter = await import("pi-mcp-adapter");
  if (typeof adapter.registerMcpServer !== "function") throw new Error("pi-mcp-adapter runtime registration API is unavailable");
  return adapter.registerMcpServer;
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
