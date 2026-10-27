import { execFile } from "node:child_process";

import { readAgentSettings, agentSettingsPath } from "./pi-graphics/agent-io.js";
import {
  cacophonySessionId,
  clearCacophonyRuntimeIdentity,
  explicitCacophonyIdentity,
  getCacophonyRuntimeIdentity,
  isPiCacoDisabled,
  ownCacophonyRuntimeSession,
  setCacophonyRuntimeIdentity,
} from "./lib/cacophony-runtime.js";
import { inferVisitingProject, registerInferringProject } from "./lib/cacophony-project.js";

export const CACO_VISITOR_ENTRY_TYPE = "agent-utils-cacophony-visitor";
export const CACO_VISITOR_MESSAGE_TYPE = "agent-utils-cacophony-registration";

function bool(value, fallback = false) {
  if (value == null || String(value).trim() === "") return fallback;
  return /^(1|true|yes|on|enabled)$/i.test(String(value).trim());
}

export function resolveCacophonyRuntimeConfig(env = process.env, settings = {}) {
  const persisted = settings?.agentUtils?.cacophony || settings?.cacophony || {};
  const explicit = explicitCacophonyIdentity(env);
  return {
    disabled: isPiCacoDisabled(env),
    autoRegister: bool(env.PI_CACO_AUTO_REGISTER, bool(persisted.autoRegister, false)),
    command: String(env.CACO_BIN || persisted.command || "caco"),
    project: explicit.project,
    explicitAgentId: explicit.agentId,
    // Explicit provenance supplied by the host/operator, NOT a managed Caco ID.
    // Classic Pi ExtensionContext does not expose Pi-Daemon's logical ID.
    runtimeAgentId: String(env.PI_CACO_RUNTIME_AGENT_ID || "").trim(),
  };
}

function execJson(execFileImpl, command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(String(stderr || stdout || error.message).trim())); return; }
      try { resolve(JSON.parse(String(stdout || "{}"))); }
      catch (error_) { reject(new Error(`invalid caco registration JSON: ${error_.message}`)); }
    });
  });
}

function restoreVisitor(entries, project, sessionId, runtimeAgentId) {
  let latest = null;
  for (const entry of entries || []) {
    if (entry?.type !== "custom" || entry.customType !== CACO_VISITOR_ENTRY_TYPE) continue;
    const data = entry.data;
    if (data?.status === "registered" && String(data.project || "").trim() &&
        (!project || data.project === project) && String(data.agentId || "").trim() &&
        data.sessionId === sessionId && (data.runtimeAgentId || "") === runtimeAgentId) latest = data;
  }
  return latest;
}

export function createCacophonyRuntimeExtension({ env = process.env, settings, settingsPath, execFileImpl = execFile } = {}) {
  return function cacophonyRuntimeExtension(pi) {
    // Resolve inside the factory: a Pi-Daemon module import can be shared, but
    // each factory invocation runs in its own logical environment.
    const startupSettings = settings || readAgentSettings(settingsPath || agentSettingsPath()) || {};
    const config = resolveCacophonyRuntimeConfig(env, startupSettings);
    let active = null;
    let registration = null;
    const reset = () => {
      if (active) clearCacophonyRuntimeIdentity(active.sessionId, active);
      active = null;
      registration = null;
    };
    const activate = (ctx) => {
      const sessionId = cacophonySessionId(ctx);
      if (active?.sessionId !== sessionId) {
        reset();
        active = { sessionId };
        active.isCurrent = ownCacophonyRuntimeSession(sessionId, active);
      }
      return active;
    };
    const announce = (ctx, identity, guidance = "") => {
      const headline = `Registered as Cacophony visiting agent ${identity.agentId} in project ${identity.project}.`;
      // Cacophony's rendered `visiting` profile explains how visiting works;
      // the model receives it in full, the transcript shows one line.
      const content = guidance ? `${headline}\n\n${guidance}` : headline;
      pi.sendMessage?.({
        customType: CACO_VISITOR_MESSAGE_TYPE,
        content,
        display: true,
        details: { ...identity, visiting: true, guidance: Boolean(guidance) },
      }, { deliverAs: "nextTurn" });
      try { ctx.ui?.notify?.(headline, "info"); } catch {}
    };

    pi.registerMessageRenderer?.(CACO_VISITOR_MESSAGE_TYPE, (message, _options, theme) => ({
      render(width) {
        const first = String(message.content || "").split("\n")[0];
        const suffix = message.details?.guidance ? " · visiting guidance attached" : "";
        return [theme.fg("dim", `${first}${suffix}`.slice(0, width))];
      },
      invalidate() {},
    }));

    // pi-daemon's /migrate (bd-737651): the migrated session keeps this session's identity.
    pi.events?.on?.("pi-durable:migrate", (event) => {
      if (!active || typeof event?.carry !== "function") return;
      const identity = getCacophonyRuntimeIdentity(env, active.sessionId);
      if (identity.disabled || !identity.agentId || !identity.project) return;
      event.carry({ CACO_AGENT_ID: identity.agentId, CACO_PROJECT: identity.project });
    });

    pi.registerCommand("caco-runtime", {
      description: "Show Agent Utils Cacophony identity/registration state.",
      handler: async (_args, ctx) => {
        activate(ctx);
        const identity = getCacophonyRuntimeIdentity(env, ctx);
        const status = identity.disabled
          ? "disabled by DISABLE_PI_CACO"
          : identity.agentId
            ? `${identity.visiting ? "visiting" : "managed"} ${identity.agentId} in ${identity.project} (${identity.source})`
            : registration
              ? "visiting registration in progress"
              : `unregistered; auto-registration ${config.autoRegister ? "on" : "off"}; use /caco-agent-register`;
        ctx.ui?.notify?.(`caco-runtime: ${status}`, "info");
      },
    });

    const ensureRegistration = (ctx, { manual = false, project: requestedProject } = {}) => {
      const owner = activate(ctx);
      if (config.disabled || isPiCacoDisabled(env)) {
        if (manual) ctx.ui?.notify?.("Cacophony integration disabled by DISABLE_PI_CACO; unset it to allow registration. To disable only boot registration, use PI_CACO_AUTO_REGISTER=0 instead.", "warning");
        return;
      }
      const existing = getCacophonyRuntimeIdentity(env, ctx);
      if (existing.agentId) {
        if (manual) ctx.ui?.notify?.(`Already registered as ${existing.agentId} in ${existing.project}.`, "info");
        return;
      }
      const project = requestedProject || config.project;
      const sessionId = owner.sessionId;
      if (!sessionId) {
        if (manual || config.autoRegister) ctx.ui?.notify?.("Cacophony registration requires the current Pi sessionManager.getSessionId(); inherited session environment is not a safe fallback.", "warning");
        return;
      }

      let entries = [];
      try { entries = ctx.sessionManager?.getBranch?.() || []; } catch {}
      const restored = restoreVisitor(entries, project, sessionId, config.runtimeAgentId);
      if (restored) {
        setCacophonyRuntimeIdentity({ ...restored, source: "session", visiting: true }, sessionId, owner);
        if (manual) ctx.ui?.notify?.(`Restored visiting agent ${restored.agentId} in ${restored.project}.`, "info");
        return;
      }
      // Auto-registration needs a configured project; the operator's command infers one
      // from the checkout's git remotes instead (registerInferringProject).
      if (!project && !manual) return;
      if (!manual && !config.autoRegister) return;
      if (registration) {
        if (registration.project !== project && manual) ctx.ui?.notify?.(`Registration is already in progress for ${registration.project}; wait before choosing another project.`, "warning");
        return registration.promise;
      }

      const pending = { project: project || "this checkout's project" };
      registration = pending;
      const current = () => active === owner && owner.isCurrent() && registration === pending &&
        cacophonySessionId(ctx) === sessionId && !isPiCacoDisabled(env);
      const argsFor = (chosen) => {
        const args = ["agent", "register", "--project", chosen, "--session-id", sessionId];
        // Pi's /name metadata, read at registration time from this live runtime.
        // An absent name is not the session UUID, external ID, or inherited env.
        try {
          const name = pi.getSessionName?.();
          if (typeof name === "string" && name.trim()) args.push("--session-name", name.trim());
        } catch { /* Older/unavailable metadata leaves naming to Cacophony. */ }
        if (config.runtimeAgentId) args.push("--runtime-agent-id", config.runtimeAgentId);
        args.push("--json");
        return args;
      };
      const run = (args) => execJson(execFileImpl, config.command, args, ctx.cwd);
      const attempt = (chosen) => run(argsFor(chosen));
      pending.promise = (manual
        ? registerInferringProject({
          requested: project,
          infer: () => inferVisitingProject({ run, cwd: ctx.cwd, sessionId }),
          attempt,
        })
        : attempt(project).then((result) => ({ result, project, note: "" })))
        .then(({ result: response, project: chosen, note }) => {
          if (!current()) return null;
          const data = response?.data || response;
          const agentId = String(data?.id || data?.agent_id || data?.agentId || "").trim();
          const registeredProject = String(data?.project || chosen).trim();
          if (!agentId || registeredProject !== chosen) throw new Error("caco agent register returned no durable visiting-agent identity for the requested project");
          if (data.session_id != null && data.session_id !== sessionId) throw new Error("caco agent register returned a different session identity");
          if (data.runtime_agent_id != null && data.runtime_agent_id !== config.runtimeAgentId) throw new Error("caco agent register returned a different runtime identity");
          const identity = { version: 2, status: "registered", agentId, project: chosen, sessionId, runtimeAgentId: config.runtimeAgentId, registeredAt: Date.now() };
          if (!setCacophonyRuntimeIdentity({ ...identity, source: "registration", visiting: true }, sessionId, owner)) return null;
          pi.appendEntry?.(CACO_VISITOR_ENTRY_TYPE, identity);
          if (note) { try { ctx.ui?.notify?.(`Cacophony project ${chosen}: ${note}.`, "info"); } catch {} }
          announce(ctx, identity, String(response?.guidance?.text || "").trim());
          try { pi.events?.emit?.("agent-utils:cacophony-identity", { ...identity, visiting: true }); } catch {}
          return identity;
        })
        .catch((error) => {
          if (current()) {
            try { ctx.ui?.notify?.(`Cacophony visiting-agent registration failed: ${error?.message || String(error)}`, "warning"); } catch {}
          }
          return null;
        })
        .finally(() => { if (registration === pending) registration = null; });
      return pending.promise;
    };

    pi.registerCommand("caco-agent-register", {
      description: "Register this session as a Cacophony visiting agent; the project comes from the checkout's git remotes unless project=<name> is given.",
      handler: async (args, ctx) => {
        const text = String(args || "").trim();
        const match = /^project=([^\s=]+)$/.exec(text);
        if (text && !match) {
          ctx.ui?.notify?.("Usage: /caco-agent-register [project=<name>] (defaults to CACO_PROJECT or CACOPHONY_PROJECT, else the project this checkout's git remotes match)", "warning");
          return;
        }
        await ensureRegistration(ctx, { manual: true, project: match?.[1] });
      },
    });

    // Successful switches/new sessions/forks provide the fresh context. Do not
    // clear on before_* events: another extension can cancel the transition.
    pi.on("session_start", (_event, ctx) => { void ensureRegistration(ctx); });
    pi.on("session_shutdown", reset);
  };
}

export default createCacophonyRuntimeExtension();
