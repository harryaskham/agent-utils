import { execFile } from "node:child_process";

import { readJsonIfExists, agentSettingsPath } from "./pi-graphics/agent-io.js";
import {
  clearCacophonyRuntimeIdentity,
  explicitCacophonyIdentity,
  getCacophonyRuntimeIdentity,
  isPiCacoDisabled,
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
  const startupSettings = settings || readJsonIfExists(settingsPath || agentSettingsPath()) || {};
  const config = resolveCacophonyRuntimeConfig(env, startupSettings);

  return function cacophonyRuntimeExtension(pi) {
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
        const identity = getCacophonyRuntimeIdentity(env);
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
      if (config.disabled) return;
      if (config.explicitAgentId && config.project) {
        setCacophonyRuntimeIdentity({ agentId: config.explicitAgentId, project: config.project, source: "environment", visiting: false });
        return;
      }
      if (!config.autoRegister || !config.project) return;

      let entries = [];
      try { entries = ctx.sessionManager?.getBranch?.() || ctx.sessionManager?.getEntries?.() || []; } catch {}
      const restored = restoreVisitor(entries, config.project);
      if (restored) {
        setCacophonyRuntimeIdentity({ ...restored, source: "session", visiting: true });
        return;
      }

      if (!config.hasTmux) {
        if (!warnedNoTmux) {
          warnedNoTmux = true;
          try { ctx.ui?.notify?.("Cacophony visiting-agent registration skipped: visiting agents require a tmux pane.", "warning"); } catch {}
        }
        return;
      }
      if (registration) return;

      registration = execJson(execFileImpl, config.command, ["agent", "register", "--project", config.project, "--json"])
        .then((response) => {
          const data = response?.data || response;
          const agentId = String(data?.id || data?.agent_id || data?.agentId || "").trim();
          const project = String(data?.project || config.project || "").trim();
          if (!agentId || !project) throw new Error("caco agent register returned no durable visiting-agent identity");
          const identity = { version: 1, status: "registered", agentId, project, registeredAt: Date.now() };
          if (!setCacophonyRuntimeIdentity({ ...identity, source: "registration", visiting: true })) {
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
      const identity = getCacophonyRuntimeIdentity(env);
      if (identity.visiting) clearCacophonyRuntimeIdentity();
    });
  };
}

export default createCacophonyRuntimeExtension();
