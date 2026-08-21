import { readJsonIfExists, agentSettingsPath } from "./pi-graphics/agent-io.js";
import { clampRenderedLineToWidth, clampRenderedRowsToWidth } from "./pi-graphics/ansi-width.js";
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
  const startupSettings = settings || readJsonIfExists(agentSettingsPath()) || {};
  const config = resolveEditorChipsConfig(startupSettings, env);

  return async function editorChipsExtension(pi) {
    if (!config.enabled) return;

    let CustomEditor = host?.CustomEditor;
    if (typeof CustomEditor !== "function") {
      try {
        ({ CustomEditor } = await import("@earendil-works/pi-coding-agent"));
      } catch {
        return;
      }
    }

    const state = {
      branch: "",
      additions: 0,
      deletions: 0,
      footerData: null,
      tui: null,
      refreshingGit: false,
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

    pi.on("session_start", async (_event, ctx) => {
      if (ctx.mode !== "tui" || typeof ctx.ui?.setEditorComponent !== "function") return;
      const previous = ctx.ui.getEditorComponent?.();

      class EditorChipsWrapper {
        constructor(base, tui, theme) {
          this.base = base;
          this.tui = tui;
          this.theme = theme;
          this.wantsKeyRelease = base?.wantsKeyRelease;
        }
        get focused() { return Boolean(this.base?.focused); }
        set focused(value) { if (this.base && "focused" in this.base) this.base.focused = value; }
        handleInput(data) { return this.base?.handleInput?.(data); }
        invalidate() { return this.base?.invalidate?.(); }
        dispose() { return this.base?.dispose?.(); }
        render(width) {
          const baseLines = this.base?.render?.(width) || [];
          const rails = buildEditorChipRails({ width, config, values: valuesFor(ctx), theme: this.theme });
          return clampRenderedRowsToWidth(replaceEditorRails(baseLines, baseLines, rails), width);
        }
      }

      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        state.tui = tui;
        const base = previous?.(tui, theme, keybindings) || new CustomEditor(tui, theme, keybindings);
        const wrapper = new EditorChipsWrapper(base, tui, theme);
        // Pi's editor host calls methods beyond the minimal Component contract
        // (getText/setText/cursor helpers). Preserve every method/property from
        // an earlier custom editor without guessing that private surface.
        return new Proxy(wrapper, {
          get(target, property, receiver) {
            if (property in target) return Reflect.get(target, property, receiver);
            const value = base?.[property];
            return typeof value === "function" ? value.bind(base) : value;
          },
          set(target, property, value, receiver) {
            if (property in target) return Reflect.set(target, property, value, receiver);
            if (base) { base[property] = value; return true; }
            return Reflect.set(target, property, value, receiver);
          },
        });
      });

      if (config.hideFooter && typeof ctx.ui.setFooter === "function") {
        ctx.ui.setFooter((tui, theme, footerData) => {
          state.footerData = footerData;
          const unsubscribe = (() => {
            try { return footerData?.onBranchChange?.(() => tui.requestRender()); } catch { return null; }
          })();
          return {
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
        });
      }

      await refreshGit(ctx);
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
