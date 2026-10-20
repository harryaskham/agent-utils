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

import { explicitCacophonyIdentity, isPiCacoDisabled } from "./cacophony-runtime.js";

/** This module's name in pi-daemon (its file name), which keys its session state. */
export const MODULE = "cacophony";
/** pi-daemon's module state document (a session family keyed by module name), as a plain token. */
export const MODULE_STATE_DOC = {
  definition: { kind: "pi-daemon.module-state", version: 1, scope: "session", family: true, initial: () => ({ values: {} }) },
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

function execJson(execFileImpl, command, args) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
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

/** Register a pi-daemon session as a visiting agent; the identity and guidance. */
export async function registerVisiting({ config, project, sessionId, execFileImpl = execFile, now = () => Date.now() }) {
  const args = ["agent", "register", "--project", project, "--session-id", sessionId];
  if (config.runtimeAgentId) args.push("--runtime-agent-id", config.runtimeAgentId);
  args.push("--json");
  const response = await execJson(execFileImpl, config.command, args);
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

  /** Register (once at a time per session), keep the identity and set the session's variables. */
  const register = (sessionId, state, sessionEnv, project) => {
    const running = pending.get(sessionId);
    if (running) return running;
    const work = (async () => {
      const identity = await registerVisiting({ config, project, sessionId, execFileImpl, now });
      await state.set("identity", identity);
      await sessionEnv.set({ CACO_AGENT_ID: identity.agentId, CACO_PROJECT: identity.project });
      return identity;
    })().finally(() => pending.delete(sessionId));
    pending.set(sessionId, work);
    return work;
  };
  // Managed agents (or an operator-set identity) already have one in their environment.
  const preset = async (sessionEnv) => {
    const vars = (await sessionEnv?.get?.()) ?? {};
    return Boolean(vars.CACO_AGENT_ID) || Boolean(explicitCacophonyIdentity(env).agentId);
  };

  return {
    extension: { name: "agent-utils-cacophony", sections: [identitySection()] },
    commands: {
      "caco-agent-register": {
        description: "Register this session as a Cacophony visiting agent; optionally project=<name>",
        async run(args, ctx) {
          if (config.disabled) return ctx.notify("Cacophony is disabled here (DISABLE_PI_CACO or incognito).");
          if (typeof ctx.env?.set !== "function") return ctx.notify("/caco-agent-register needs pi-daemon 1.12 or later (per-session environment).");
          const text = String(args ?? "").trim();
          const match = /^project=([^\s=]+)$/.exec(text);
          if (text && !match) return ctx.notify("Usage: /caco-agent-register [project=<name>] (defaults to CACO_PROJECT or agentUtils.cacophony.project)");
          const project = match?.[1] || config.project;
          if (!project) return ctx.notify("No project: /caco-agent-register project=<name>, or set CACO_PROJECT or agentUtils.cacophony.project.");
          try {
            const identity = await register(ctx.sessionId, ctx.state, ctx.env, project);
            ctx.notify(`Registered as Cacophony visiting agent ${identity.agentId} in project ${identity.project}.`);
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
          if (identity?.agentId) return ctx.notify(`visiting ${identity.agentId} in ${identity.project} (registered ${new Date(identity.registeredAt).toISOString()})`);
          if (vars.CACO_AGENT_ID) return ctx.notify(`managed ${vars.CACO_AGENT_ID} in ${vars.CACO_PROJECT ?? "?"} (environment)`);
          ctx.notify(config.disabled ? "disabled" : `not registered${config.autoRegister ? " (registers on the next run)" : "; /caco-agent-register"}`);
        },
      },
    },
    /** Auto-registration on a session's first run. */
    async observe(event, info) {
      if (event.type !== "agent_start" || config.disabled || !config.autoRegister || !config.project) return;
      if (typeof info.env?.set !== "function") return;
      if ((await info.state.get("identity"))?.agentId || (await preset(info.env))) return;
      await register(info.sessionId, info.state, info.env, config.project).catch(() => undefined);
    },
  };
}
