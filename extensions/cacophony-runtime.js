import { execFile } from "node:child_process";

import { readAgentSettings, agentSettingsPath } from "./pi-graphics/agent-io.js";
import {
  CACO_AGENT_ID_FLAG,
  CACO_PROJECT_FLAG,
  DISABLE_PI_CACO_FLAG,
  clearCacophonyRuntimeIdentity,
  explicitCacophonyIdentity,
  getCacophonyRuntimeIdentity,
  isPiCacoDisabled,
  sessionFlagEnvironment,
  setCacophonyRuntimeIdentity,
} from "./lib/cacophony-runtime.js";

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
    hasTmux: Boolean(String(env.TMUX || "").trim()),
  };
}

function execJson(execFileImpl, command, args) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(String(stderr || stdout || error.message).trim())); return; }
      try { resolve(JSON.parse(String(stdout || "{}"))); }
      catch (error_) { reject(new Error(`invalid caco registration JSON: ${error_.message}`)); }
    });
  });
}

function restoreVisitor(entries, project) {
  let latest = null;
  for (const entry of entries || []) {
    if (entry?.type !== "custom" || entry.customType !== CACO_VISITOR_ENTRY_TYPE) continue;
    const data = entry.data;
    if (data?.status === "registered" && data.project === project && data.agentId) latest = data;
  }
  return latest;
}

export function createCacophonyRuntimeExtension({ env = process.env, settings, settingsPath, execFileImpl = execFile } = {}) {
  const startupSettings = settings || readAgentSettings(settingsPath || agentSettingsPath()) || {};
  const config = resolveCacophonyRuntimeConfig(env, startupSettings);

  return function cacophonyRuntimeExtension(pi) {
    pi.registerFlag?.(CACO_AGENT_ID_FLAG, { description: "Session-scoped Cacophony agent identity.", type: "string" });
    pi.registerFlag?.(CACO_PROJECT_FLAG, { description: "Session-scoped Cacophony project.", type: "string" });
    pi.registerFlag?.(DISABLE_PI_CACO_FLAG, { description: "Disable Cacophony integrations for this session.", type: "boolean", default: false });
    const runtimeEnv = sessionFlagEnvironment(pi, env);
    const runtimeConfig = resolveCacophonyRuntimeConfig(runtimeEnv, startupSettings);
    let registration = null;
    let warnedNoTmux = false;

    const announce = (ctx, identity, restored = false) => {
      const content = `Registered as Cacophony visiting agent ${identity.agentId} in project ${identity.project}${restored ? " (restored)" : ""}.`;
      pi.sendMessage?.({
        customType: CACO_VISITOR_MESSAGE_TYPE,
        content,
        display: true,
        details: { ...identity, visiting: true, restored },
      }, { deliverAs: "nextTurn" });
      try { ctx.ui?.notify?.(content, "info"); } catch {}
    };

    pi.registerMessageRenderer?.(CACO_VISITOR_MESSAGE_TYPE, (message, _options, theme) => ({
      render(width) { return [theme.fg("dim", String(message.content || "").slice(0, width))]; },
      invalidate() {},
    }));

    pi.registerCommand("caco-runtime", {
      description: "Show Agent Utils Cacophony identity/registration state.",
      handler: async (_args, ctx) => {
        const identity = getCacophonyRuntimeIdentity(runtimeEnv, pi);
        const status = identity.disabled
          ? "disabled by DISABLE_PI_CACO"
          : identity.agentId
            ? `${identity.visiting ? "visiting" : "managed"} ${identity.agentId} in ${identity.project} (${identity.source})`
            : registration
              ? "visiting registration in progress"
              : "unregistered";
        ctx.ui?.notify?.(`caco-runtime: ${status}`, "info");
      },
    });

    pi.on("session_start", (_event, ctx) => {
      if (runtimeConfig.disabled) return;
      if (runtimeConfig.explicitAgentId && runtimeConfig.project) {
        const source = pi.getFlag?.(CACO_AGENT_ID_FLAG) ? "session-flags" : "environment";
        setCacophonyRuntimeIdentity({ agentId: runtimeConfig.explicitAgentId, project: runtimeConfig.project, source, visiting: false }, pi);
        return;
      }
      if (!runtimeConfig.autoRegister || !runtimeConfig.project) return;

      let entries = [];
      try { entries = ctx.sessionManager?.getBranch?.() || ctx.sessionManager?.getEntries?.() || []; } catch {}
      const restored = restoreVisitor(entries, runtimeConfig.project);
      if (restored) {
        setCacophonyRuntimeIdentity({ ...restored, source: "session", visiting: true }, pi);
        return;
      }

      if (!runtimeConfig.hasTmux) {
        if (!warnedNoTmux) {
          warnedNoTmux = true;
          try { ctx.ui?.notify?.("Cacophony visiting-agent registration skipped: visiting agents require a tmux pane.", "warning"); } catch {}
        }
        return;
      }
      if (registration) return;

      registration = execJson(execFileImpl, runtimeConfig.command, ["agent", "register", "--project", runtimeConfig.project, "--json"])
        .then((response) => {
          const data = response?.data || response;
          const agentId = String(data?.id || data?.agent_id || data?.agentId || "").trim();
          const project = String(data?.project || runtimeConfig.project || "").trim();
          if (!agentId || !project) throw new Error("caco agent register returned no durable visiting-agent identity");
          const identity = { version: 1, status: "registered", agentId, project, registeredAt: Date.now() };
          if (!setCacophonyRuntimeIdentity({ ...identity, source: "registration", visiting: true }, pi)) {
            throw new Error("refusing empty visiting-agent identity");
          }
          pi.appendEntry?.(CACO_VISITOR_ENTRY_TYPE, identity);
          announce(ctx, identity, false);
          try { pi.events?.emit?.("agent-utils:cacophony-identity", { ...identity, visiting: true }); } catch {}
          return identity;
        })
        .catch((error) => {
          try { ctx.ui?.notify?.(`Cacophony visiting-agent registration failed: ${error?.message || String(error)}`, "warning"); } catch {}
          return null;
        })
        .finally(() => { registration = null; });
    });

    pi.on("session_shutdown", () => {
      const identity = getCacophonyRuntimeIdentity(runtimeEnv, pi);
      if (identity.visiting) clearCacophonyRuntimeIdentity(pi);
    });
  };
}

export default createCacophonyRuntimeExtension();
