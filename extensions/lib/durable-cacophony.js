// Cacophony visiting registration for pi-daemon (Durable) sessions (bd-cab485): the Durable
// counterpart of the TUI cacophony-runtime extension.
//
// A session registers as a visiting agent (`caco agent register --project P --session-id S`)
// by `/caco-agent-register`, or on its first run when auto-registration is on. The identity and
// Cacophony's visiting guidance are kept in the module's session state; CACO_AGENT_ID and
// CACO_PROJECT go into the session's environment overrides (pi-daemon >= 1.12), so `caco` in
// bash and the caco MCP server act as the agent; and a `cacophony` system prompt section tells
// the agent who it is. Managed agents already carry their identity in their environment and
// are left alone.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { agentFromVariables } from "./agent-chip.js";
import { explicitCacophonyIdentity, isPiCacoDisabled } from "./cacophony-runtime.js";
import { inferVisitingProject, registerInferringProject } from "./cacophony-project.js";

/** This module's name in pi-daemon (its file name), which keys its session state. */
export const MODULE = "cacophony";
/** pi-daemon's module state document (a session family keyed by module name), as a plain token. */
export const MODULE_STATE_DOC = {
  // checkpointWhen as pi-daemon's own (pi-durable 1.4 requires one; earlier versions ignore it).
  definition: {
    kind: "pi-daemon.module-state",
    version: 1,
    scope: "session",
    family: true,
    initial: () => ({ values: {} }),
    checkpointWhen: (_value, _ops, info) => (info?.deltasSinceBase ?? 0) >= 32,
  },
};

function bool(value, fallback = false) {
  if (value == null || String(value).trim() === "") return fallback;
  return /^(1|true|yes|on|enabled)$/i.test(String(value).trim());
}

/** The agent-utils settings slice for Cacophony, from Pi's settings.json. */
export function readCacophonySettings(env = process.env) {
  try {
    const dir = env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME || homedir(), ".pi", "agent");
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    return settings?.agentUtils?.cacophony || settings?.cacophony || {};
  } catch {
    return {};
  }
}

export function resolveConfig(env = process.env, settings = readCacophonySettings(env)) {
  const explicit = explicitCacophonyIdentity(env);
  return {
    disabled: isPiCacoDisabled(env),
    autoRegister: bool(env.PI_CACO_AUTO_REGISTER, bool(settings.autoRegister, false)),
    command: String(env.CACO_BIN || settings.command || "caco"),
    project: explicit.project || String(settings.project || "").trim(),
    runtimeAgentId: String(env.PI_CACO_RUNTIME_AGENT_ID || "").trim(),
  };
}

function execJson(execFileImpl, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim().split("\n")[0].slice(0, 300)));
        return;
      }
      try {
        resolve(JSON.parse(String(stdout || "{}")));
      } catch (parseError) {
        reject(new Error(`invalid caco registration JSON: ${parseError.message}`));
      }
    });
  });
}

/** Cacophony's name for this node's pi-daemon AHP host. */
export const PI_DAEMON_AHP_HOST = "pi-daemon";

/** Register a pi-daemon session as a visiting agent; the identity and guidance. */
export async function registerVisiting({ config, project, sessionId, sessionName, cwd, execFileImpl = execFile, now = () => Date.now() }) {
  // The visitor's checkout is the session's directory (bd-8c8f5f): never the pi-daemon worker's,
  // whose directory (the home directory) contains managed agents' checkouts.
  if (!cwd) throw new Error("the session's directory is unknown (pi-daemon passes it to modules from 1.13)");
  const args = ["agent", "register", "--project", project, "--session-id", sessionId, "--checkout-root", cwd];
  if (typeof sessionName === "string" && sessionName.trim()) args.push("--session-name", sessionName.trim());
  if (config.runtimeAgentId) args.push("--runtime-agent-id", config.runtimeAgentId);
  // The session is on this node's pi-daemon: Cacophony delivers its messages into it as to a
  // native pi-daemon agent (cacophony bd-6cf22b). An older caco refuses the flag; register
  // without it there, as before.
  let response;
  let ahpHost = PI_DAEMON_AHP_HOST;
  try {
    response = await execJson(execFileImpl, config.command, [...args, "--ahp-host", ahpHost, "--json"], { cwd });
  } catch (error) {
    if (!/--ahp-host|unrecogni[sz]ed flag/i.test(String(error?.message || error))) throw error;
    ahpHost = undefined;
    response = await execJson(execFileImpl, config.command, [...args, "--json"], { cwd });
  }
  const data = response?.data || response;
  const agentId = String(data?.id || data?.agent_id || data?.agentId || "").trim();
  const registeredProject = String(data?.project || project).trim();
  if (!agentId || registeredProject !== project) throw new Error("caco agent register returned no visiting-agent identity for the requested project");
  if (data.session_id != null && data.session_id !== sessionId) throw new Error("caco agent register returned a different session identity");
  return {
    agentId,
    project,
    sessionId,
    ...(config.runtimeAgentId ? { runtimeAgentId: config.runtimeAgentId } : {}),
    ...(ahpHost ? { ahpHost } : {}),
    registeredAt: now(),
    guidance: String(response?.guidance?.text || "").trim().slice(0, 16_000),
  };
}

/** The `cacophony` system prompt section: who this session is to Cacophony. */
export function identitySection() {
  return {
    key: "cacophony",
    async render(input, context) {
      let doc;
      try {
        doc = await input.read.snapshot(MODULE_STATE_DOC, MODULE, context);
      } catch {
        return undefined;
      }
      const identity = doc?.values?.identity;
      if (!identity?.agentId) return undefined;
      const head = `This session is the Cacophony visiting agent ${identity.agentId} in project ${identity.project}. Its shell has CACO_AGENT_ID and CACO_PROJECT set, so \`caco\` commands act as this agent.`;
      return identity.guidance ? `${head}\n\n${identity.guidance}` : head;
    },
  };
}

/** The module: section, commands and the auto-registration observer. */
export function createCacophonyModule({ env = process.env, settings, execFileImpl = execFile, now = () => Date.now() } = {}) {
  const config = resolveConfig(env, settings ?? readCacophonySettings(env));
  const pending = new Map();
  // Sessions whose host binding was attempted in this process.
  const rebound = new Set();

  /**
   * Register (once at a time per session), keep the identity and set the session's variables.
   * With `infer` (the operator's command), a missing project comes from the checkout's git
   * remotes, and a project caco refuses for this checkout is replaced by the sole one its
   * remotes match; `note` then says so.
   */
  const register = (scope, project, { infer = false } = {}) => {
    const { sessionId, state, env: sessionEnv, cwd } = scope;
    const running = pending.get(sessionId);
    if (running) return running;
    const work = (async () => {
      let identity = await state.get("identity");
      let note = "";
      // A receipt belongs to a session, not its mutable name or conversation.
      if (!identity?.agentId || identity.sessionId !== sessionId) {
        let sessionName;
        try {
          // Generic pi-daemon metadata API (bd-5fbc06), absent on older hosts.
          // Read live /name only; never use an auto title, env, or session ID.
          sessionName = await scope.getSessionName?.();
        } catch { /* Unavailable metadata leaves naming to Cacophony. */ }
        const attempt = (chosen) => registerVisiting({ config, project: chosen, sessionId, sessionName, cwd, execFileImpl, now });
        if (infer) {
          const registered = await registerInferringProject({
            requested: project,
            infer: () => inferVisitingProject({ run: (args) => execJson(execFileImpl, config.command, args, { cwd }), cwd, sessionId }),
            attempt,
          });
          identity = registered.result;
          note = registered.note;
        } else {
          identity = await attempt(project);
        }
        await state.set("identity", identity);
      }
      await sessionEnv.set({ CACO_AGENT_ID: identity.agentId, CACO_PROJECT: identity.project });
      return { identity, note };
    })().finally(() => pending.delete(sessionId));
    pending.set(sessionId, work);
    return work;
  };
  // Managed agents (or an operator-set identity) already have one in their environment.
  const preset = async (sessionEnv) => {
    const vars = (await sessionEnv?.get?.()) ?? {};
    return Boolean(vars.CACO_AGENT_ID) || Boolean(explicitCacophonyIdentity(env).agentId);
  };

  // A native (managed) agent's identity as the session's variables have it (pi-daemon 1.15's
  // env.all()), kept in the module's state for clients: pi-client's editor chips name the agent
  // (`cacophony▌router`), and clients never receive the variables themselves.
  const recordAgent = async (info) => {
    if (typeof info.env?.all !== "function") return;
    const agent = agentFromVariables(await info.env.all());
    const managed = agent === undefined || agent.agentId.startsWith("visiting-") ? undefined : agent;
    const kept = await info.state.get("agent");
    if (JSON.stringify(kept ?? null) !== JSON.stringify(managed ?? null)) await info.state.set("agent", managed);
  };

  return {
    extension: { name: "agent-utils-cacophony", sections: [identitySection()] },
    commands: {
      "caco-agent-register": {
        description: "Register this session as a Cacophony visiting agent; the project comes from the checkout's git remotes unless project=<name> is given",
        async run(args, ctx) {
          if (config.disabled) return ctx.notify("Cacophony is disabled here (DISABLE_PI_CACO or incognito).");
          if (typeof ctx.env?.set !== "function") return ctx.notify("/caco-agent-register needs pi-daemon 1.12 or later (per-session environment).");
          const text = String(args ?? "").trim();
          const match = /^project=([^\s=]+)$/.exec(text);
          if (text && !match) return ctx.notify("Usage: /caco-agent-register [project=<name>] (defaults to CACO_PROJECT or agentUtils.cacophony.project, else the project this checkout's git remotes match)");
          const project = match?.[1] || config.project;
          try {
            if (await preset(ctx.env)) return ctx.notify("This session already has a Cacophony identity; use /caco-runtime.");
            const { identity, note } = await register(ctx, project, { infer: true });
            ctx.notify(`Registered as Cacophony visiting agent ${identity.agentId} in project ${identity.project}${note ? ` (${note})` : ""}.`);
          } catch (error) {
            ctx.notify(`Cacophony visiting-agent registration failed: ${error.message}`);
          }
        },
      },
      "caco-runtime": {
        description: "Show this session's Cacophony identity",
        async run(_args, ctx) {
          const identity = await ctx.state.get("identity");
          const vars = (await ctx.env?.get?.()) ?? {};
          if (identity?.agentId) {
            return ctx.notify(
              identity.inherited
                ? `visiting ${identity.agentId} in ${identity.project} (carried over by /migrate)`
                : `visiting ${identity.agentId} in ${identity.project} (registered ${new Date(identity.registeredAt).toISOString()})`,
            );
          }
          if (vars.CACO_AGENT_ID) return ctx.notify(`managed ${vars.CACO_AGENT_ID} in ${vars.CACO_PROJECT ?? "?"} (environment)`);
          ctx.notify(config.disabled ? "disabled" : `not registered${config.autoRegister ? " (registers on the next run)" : "; /caco-agent-register"}`);
        },
      },
    },
    /** Auto-registration on a session's first run; a native agent's identity, for clients. */
    async observe(event, info) {
      if (event.type !== "agent_start" || config.disabled) return;
      await recordAgent(info).catch(() => undefined);
      if (typeof info.env?.set !== "function") return;
      // A session migrated from TUI Pi carries its visiting agent's identity in its variables
      // (pi-daemon's /migrate, bd-737651): it is that agent, as if registered here.
      const identity = await info.state.get("identity");
      const registered = identity?.agentId && identity.sessionId === info.sessionId;
      if (!registered) {
        const vars = (await info.env.get?.()) ?? {};
        const agentId = String(vars.CACO_AGENT_ID || "").trim();
        const project = String(vars.CACO_PROJECT || "").trim();
        if (agentId.startsWith("visiting-") && project) {
          await info.state.set("identity", { agentId, project, sessionId: info.sessionId, registeredAt: now(), guidance: "", inherited: true });
          return;
        }
      }
      // A visitor this module registered before Cacophony routed by host gets its host bound
      // once (cacophony bd-6cf22b), so its messages reach this session.
      if (registered && !identity.ahpHost && !identity.inherited && !rebound.has(info.sessionId) && info.cwd) {
        rebound.add(info.sessionId);
        const again = await registerVisiting({ config, project: identity.project, sessionId: info.sessionId, cwd: info.cwd, execFileImpl, now }).catch(() => undefined);
        if (again?.agentId === identity.agentId && again.ahpHost) await info.state.set("identity", { ...identity, ahpHost: again.ahpHost });
        return;
      }
      if (!config.autoRegister || !config.project) return;
      if (registered || (await preset(info.env))) return;
      await register(info, config.project).catch(() => undefined);
    },
  };
}
