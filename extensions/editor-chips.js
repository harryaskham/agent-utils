import { readAgentSettings, agentSettingsPath } from "./pi-graphics/agent-io.js";
import { clampRenderedLineToWidth, clampRenderedRowsToWidth } from "./pi-graphics/ansi-width.js";
import { getOrCreateEditorChromeRegistry, wrapEditorComponent } from "./pi-graphics/fullscreen-contract.js";
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
        const specifier = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href;
        ({ CustomEditor } = await import(specifier));
      } catch (error) { hostImportError = error; }
      return CustomEditor;
    };

    const state = {
      branch: "",
      additions: 0,
      deletions: 0,
      footerData: null,
      tui: null,
      refreshingGit: false,
      editorRegistry: null,
      editorLease: null,
    };

    const refreshGit = async (ctx) => {
      if (state.refreshingGit) return;
      state.refreshingGit = true;
      try {
        const [branch, diff] = await Promise.all([
          pi.exec("git", ["branch", "--show-current"], { timeout: 4000 }),
          pi.exec("git", ["diff", "--numstat", "HEAD", "--"], { timeout: 4000 }),
        ]);
        if (branch?.code === 0) state.branch = String(branch.stdout || "").trim();
        if (diff?.code === 0) Object.assign(state, parseNumstat(diff.stdout));
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
        branch: footerBranch || state.branch || "no-branch",
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
            })().map(sanitizeStatus).filter((text) => text && !/\bMCP\s*\(?\s*\d+/i.test(text));
            if (statuses.length === 0) return [];
            const line = theme.fg("dim", statuses.join(" "));
            return [clampRenderedLineToWidth(line, width)];
          },
        };
      };
      factory.__agentUtilsEditorChipsFooter = true;
      ctx.ui.setFooter(factory);
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
          return wrapEditorComponent(base, {
            renderRows(baseLines, width) {
              const rails = buildEditorChipRails({ width, config, values: valuesFor(ctx), theme });
              return clampRenderedRowsToWidth(replaceEditorRails(baseLines, baseLines, rails), width);
            },
          });
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
      await loadCustomEditor();
      if (!installSurfaces(ctx)) {
        try { ctx.ui?.notify?.(`Editor chips could not mount: ${hostImportError?.message || "CustomEditor host API unavailable"}`, "warning"); } catch {}
        return;
      }
      // Some fullscreen/runtime extensions establish their singleton surfaces in
      // later session_start handlers. Reassert the lease after the startup event
      // drains; acquire() is owner-deduplicated, so this cannot stack wrappers.
      for (const delay of [0, 100]) {
        const timer = setTimeout(() => { try { installSurfaces(ctx); } catch {} }, delay);
        timer.unref?.();
      }
      await refreshGit(ctx);
    });

    pi.on("session_shutdown", () => {
      if (state.editorRegistry && state.editorLease) {
        try { state.editorRegistry.release(state.editorLease); } catch {}
      }
      state.editorLease = null;
      state.tui = null;
    });

    pi.on("model_select", async (_event, ctx) => { try { state.tui?.requestRender?.(); } catch {} });
    pi.on("thinking_level_select", async (_event, ctx) => { try { state.tui?.requestRender?.(); } catch {} });
    pi.on("turn_end", async (_event, ctx) => { await refreshGit(ctx); });
    pi.on("tool_execution_end", async (event, ctx) => {
      if (["edit", "write", "bash"].includes(String(event?.toolName || ""))) await refreshGit(ctx);
    });
  };
}

export default createEditorChipsExtension();
