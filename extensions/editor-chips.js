import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAgentSettings, agentSettingsPath } from "./pi-graphics/agent-io.js";
import { clampRenderedLineToWidth, clampRenderedRowsToWidth } from "./pi-graphics/ansi-width.js";
import { getOrCreateEditorChromeRegistry } from "./pi-graphics/fullscreen-contract.js";
import {
  buildEditorChipRails,
  parseMcpCount,
  prettyDirectory,
  replaceEditorRails,
  resolveEditorChipsConfig,
  summarizeUsage,
} from "./lib/editor-chips.js";

function parseNumstat(output) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(output || "").split(/\r?\n/)) {
    const [added, removed] = line.split(/\s+/, 3);
    if (/^\d+$/.test(added || "")) additions += Number(added);
    if (/^\d+$/.test(removed || "")) deletions += Number(removed);
  }
  return { additions, deletions };
}

function sanitizeStatus(text) {
  return String(text || "").replace(/[\r\n]+/g, " ").trim();
}

export function createEditorChipsExtension({ settings, env = process.env, host } = {}) {
  const startupSettings = settings || readAgentSettings(agentSettingsPath()) || {};
  const config = resolveEditorChipsConfig(startupSettings, env);

  return function editorChipsExtension(pi) {
    if (!config.enabled) return;

    let CustomEditor = host?.CustomEditor;
    let hostImportError = null;
    const loadCustomEditor = async () => {
      if (typeof CustomEditor === "function") return CustomEditor;
      try {
        const require = createRequire(import.meta.url);
        const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@earendil-works", "pi-coding-agent");
        const nodeModulesRoot = join(packageRoot, "..", "..");
        // Use absolute paths throughout. Pi's loader deliberately isolates
        // package roots and can override both bare require resolution and
        // import.meta.resolve for an extension module.
        const { createJiti } = require(join(nodeModulesRoot, "jiti", "lib", "jiti.cjs"));
        const entry = join(packageRoot, "dist", "index.js");
        const module = await createJiti(entry).import(entry);
        ({ CustomEditor } = module);
      } catch (error) { hostImportError = error; }
      return CustomEditor;
    };

    const state = {
      branch: "",
      inGitRepo: false,
      additions: 0,
      deletions: 0,
      footerData: null,
      tui: null,
      refreshingGit: false,
      editorRegistry: null,
      editorLease: null,
      footerFactory: null,
      originalSetFooter: null,
      originalSetFooterRaw: null,
      patchedSetFooter: null,
      footerUi: null,
      timers: new Set(),
      stopped: false,
    };

    const refreshGit = async (ctx) => {
      if (state.refreshingGit) return;
      state.refreshingGit = true;
      try {
        const [branch, diff] = await Promise.all([
          pi.exec("git", ["branch", "--show-current"], { timeout: 4000 }),
          pi.exec("git", ["diff", "--numstat", "HEAD", "--"], { timeout: 4000 }),
        ]);
        state.inGitRepo = branch?.code === 0 && Boolean(String(branch.stdout || "").trim());
        state.branch = state.inGitRepo ? String(branch.stdout || "").trim() : "";
        if (state.inGitRepo && diff?.code === 0) Object.assign(state, parseNumstat(diff.stdout));
        else Object.assign(state, { additions: 0, deletions: 0 });
      } catch {
        // Non-git cwd or a transient command failure leaves the last stable data.
      } finally {
        state.refreshingGit = false;
        try { state.tui?.requestRender?.(); } catch {}
      }
    };

    const valuesFor = (ctx) => {
      let footerBranch = "";
      let statuses = new Map();
      try { footerBranch = state.footerData?.getGitBranch?.() || ""; } catch {}
      try { statuses = state.footerData?.getExtensionStatuses?.() || statuses; } catch {}
      const usage = (() => {
        try { return ctx.getContextUsage?.() || {}; } catch { return {}; }
      })();
      const totals = (() => {
        try { return summarizeUsage(ctx.sessionManager?.getEntries?.() || ctx.sessionManager?.getBranch?.() || []); } catch { return { cost: 0 }; }
      })();
      const contextMax = Number(usage.contextWindow ?? usage.contextWindowSize ?? ctx.model?.contextWindow ?? 0);
      const contextTokens = Number(usage.tokens ?? usage.contextTokens ?? 0);
      const contextPct = Number(usage.percent ?? usage.usedPercentage ?? (contextMax > 0 ? (contextTokens / contextMax) * 100 : 0));
      const provider = String(ctx.model?.provider || "model");
      return {
        provider,
        model: String(ctx.model?.id || "n/a"),
        effort: String(pi.getThinkingLevel?.() || ctx.thinkingLevel || "off").toLowerCase(),
        mcpCount: parseMcpCount(statuses),
        cost: totals.cost,
        subscription: provider === "github-copilot" || provider === "kimi-coding",
        contextPct: Number.isFinite(contextPct) ? contextPct : 0,
        contextMax: Number.isFinite(contextMax) ? contextMax : 0,
        directory: prettyDirectory(ctx.cwd || process.cwd(), env.HOME || env.USERPROFILE),
        branch: footerBranch || state.branch,
        inGitRepo: state.inGitRepo || Boolean(footerBranch),
        additions: state.additions,
        deletions: state.deletions,
      };
    };

    const installFooter = (ctx) => {
      if (!config.hideFooter || typeof ctx.ui?.setFooter !== "function") return false;
      const factory = (tui, theme, footerData) => {
        state.footerData = footerData;
        const unsubscribe = (() => {
          try { return footerData?.onBranchChange?.(() => tui.requestRender()); } catch { return null; }
        })();
        return {
          __agentUtilsEditorChipsFooter: true,
          dispose() { try { unsubscribe?.(); } catch {} },
          invalidate() {},
          render(width) {
            state.footerData = footerData;
            const statuses = (() => {
              try { return [...(footerData?.getExtensionStatuses?.() || new Map()).values()]; } catch { return []; }
            })().map(sanitizeStatus).filter((text) => text && !/(?:\bMCP\s*:?\s*\(?\s*\d+|🔌\s*MCP)/i.test(text));
            if (statuses.length === 0) return [];
            const line = theme.fg("dim", statuses.join(" "));
            return [clampRenderedLineToWidth(line, width)];
          },
        };
      };
      factory.__agentUtilsEditorChipsFooter = true;
      state.footerFactory = factory;
      state.footerUi = ctx.ui;
      if (!state.originalSetFooter) {
        const staleOriginal = ctx.ui.setFooter.__agentUtilsEditorChipsOriginal;
        if (typeof staleOriginal === "function") ctx.ui.setFooter = staleOriginal;
        state.originalSetFooterRaw = ctx.ui.setFooter;
        state.originalSetFooter = state.originalSetFooterRaw.bind(ctx.ui);
        state.patchedSetFooter = function (next, ...rest) {
          if (next?.__agentUtilsEditorChipsFooter) return state.originalSetFooter(next, ...rest);
          // Keep later core/status extensions from restoring the redundant
          // default footer while hideFooter is active. Their status values still
          // flow through the shared FooterData provider consumed by our chips.
          return state.originalSetFooter(state.footerFactory, ...rest);
        };
        state.patchedSetFooter.__agentUtilsEditorChipsFooterGuard = true;
        state.patchedSetFooter.__agentUtilsEditorChipsOriginal = state.originalSetFooterRaw;
        ctx.ui.setFooter = state.patchedSetFooter;
      }
      state.originalSetFooter(factory);
      return true;
    };

    const installSurfaces = (ctx) => {
      if (typeof CustomEditor !== "function" || typeof ctx.ui?.setEditorComponent !== "function") return false;
      state.editorRegistry = getOrCreateEditorChromeRegistry(ctx.ui, {
        defaultFactory: (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
      });
      state.editorLease = state.editorRegistry?.acquire({
        owner: "editor-chips",
        priority: 20,
        decorate(base, { tui, theme }) {
          state.tui = tui;
          if (!base || typeof base.render !== "function") return base;
          // Preserve the exact host editor object. Pi routes global abort,
          // key-release, focus and hardware-cursor behavior through that full
          // component; a proxy-shaped partial wrapper can break Escape/Ctrl-C.
          if (!base.__agentUtilsEditorChipsRender) {
            const originalRender = base.render.bind(base);
            base.__agentUtilsEditorChipsRender = originalRender;
            base.render = (width) => {
              const baseLines = originalRender(width);
              const rails = buildEditorChipRails({ width, config, values: valuesFor(ctx), theme });
              return clampRenderedRowsToWidth(replaceEditorRails(baseLines, baseLines, rails), width);
            };
          }
          return base;
        },
      });
      installFooter(ctx);
      try { ctx.ui?.setStatus?.("editor-chips", undefined); } catch {}
      return Boolean(state.editorLease);
    };

    pi.registerCommand("editor-chips", {
      description: "Show or repair configured editor rail chips.",
      handler: async (args, ctx) => {
        const action = String(args || "status").trim().toLowerCase();
        if (action === "repair" || action === "reload") {
          await loadCustomEditor();
          installSurfaces(ctx);
        }
        const owners = state.editorRegistry?.owners?.() || [];
        ctx.ui?.notify?.(`editor-chips:${config.enabled ? "enabled" : "disabled"} · mounted=${owners.includes("editor-chips")} · owners=${owners.join(",") || "none"} · footer=${config.hideFooter ? "hidden" : "normal"}${hostImportError ? ` · host-import-error=${hostImportError.message || String(hostImportError)}` : ""}`, hostImportError ? "warning" : "info");
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      state.stopped = false;
      await loadCustomEditor();
      if (!installSurfaces(ctx)) {
        try { ctx.ui?.notify?.(`Editor chips could not mount: ${hostImportError?.message || "CustomEditor host API unavailable"}`, "warning"); } catch {}
        return;
      }
      // Some fullscreen/runtime extensions establish their singleton surfaces in
      // later session_start handlers. Reassert the lease after the startup event
      // drains; acquire() is owner-deduplicated, so this cannot stack wrappers.
      for (const delay of [0, 100]) {
        let timer;
        timer = setTimeout(() => {
          state.timers.delete(timer);
          if (state.stopped) return;
          try { installSurfaces(ctx); } catch {}
        }, delay);
        state.timers.add(timer);
        timer.unref?.();
      }
      await refreshGit(ctx);
    });

    pi.on("session_shutdown", () => {
      state.stopped = true;
      for (const timer of state.timers) clearTimeout(timer);
      state.timers.clear();
      if (state.editorRegistry && state.editorLease) {
        try { state.editorRegistry.release(state.editorLease); } catch {}
      }
      state.editorLease = null;
      if (state.originalSetFooter && state.patchedSetFooter) {
        try { state.originalSetFooter(undefined); } catch {}
        if (state.footerUi?.setFooter === state.patchedSetFooter) state.footerUi.setFooter = state.originalSetFooterRaw;
      }
      state.originalSetFooter = null;
      state.originalSetFooterRaw = null;
      state.patchedSetFooter = null;
      state.footerFactory = null;
      state.footerUi = null;
      state.tui = null;
    });

    const reassertAfterCoreUpdate = (ctx) => {
      if (state.stopped) return;
      installSurfaces(ctx);
      let timer;
      timer = setTimeout(() => {
        state.timers.delete(timer);
        if (state.stopped) return;
        try { installSurfaces(ctx); state.tui?.requestRender?.(); } catch {}
      }, 0);
      state.timers.add(timer);
      timer.unref?.();
    };
    pi.on("model_select", async (_event, ctx) => { reassertAfterCoreUpdate(ctx); });
    pi.on("thinking_level_select", async (_event, ctx) => { reassertAfterCoreUpdate(ctx); });
    pi.on("turn_end", async (_event, ctx) => { await refreshGit(ctx); installFooter(ctx); });
    pi.on("tool_execution_end", async (event, ctx) => {
      if (["edit", "write", "bash"].includes(String(event?.toolName || ""))) await refreshGit(ctx);
    });
  };
}

export default createEditorChipsExtension();
