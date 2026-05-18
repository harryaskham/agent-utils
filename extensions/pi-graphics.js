// Pi extension that pairs with the agent-utils kitty-graphics theme.
//
// The extension is intentionally narrow in scope:
//
//  * It owns a small set of kitty image ids used to back graphical
//    affordances (prompt enclosure rules, gradient borders, glow panels,
//    accent bars) rendered through the kitty graphics protocol. The image bytes are
//    produced by `extensions/pi-graphics/affordances.js` and transmitted via
//    `extensions/kitty-graphics.js#buildPngVirtualPlacementCommand`.
//
//  * Display happens through Unicode placeholder cells, so placement is
//    tmux-safe and does not move the real terminal cursor (preserving the
//    Pi/Caco UI redraw model). Cleanup is scoped to the extension's own image
//    ids -- we never call the global "delete all images" command -- in
//    cooperation with bd-f89780.
//
//  * It exposes Pi tools (`pi_graphics_render_prompt_enclosure`,
//    `pi_graphics_render_message_border`, `pi_graphics_render_tui_pulse`,
//    `pi_graphics_clear`) that other agents/operators can use to print graphical affordances directly into
//    tool output. Slash commands `/pi-graphics-status` and
//    `/pi-graphics-demo` are registered for human discoverability.
//
// The extension does not attempt to redraw or restyle existing Pi widgets;
// instead it provides primitives that themes/tools can opt-in to. The
// companion theme (`themes/kitty-graphics.json`) sets a Nord-inspired palette
// that pairs with the gradient defaults below.

import { Type } from "@sinclair/typebox";

import { buildScopedDeleteCommand } from "./kitty-graphics.js";
import {
  renderAccentBar,
  renderGlowPanel,
  renderGradientBorder,
  renderPromptEnclosure,
} from "./pi-graphics/affordances.js";
import {
  buildAutoPulseWidget,
  buildPiGraphicsFooterComponent,
  buildPiGraphicsHeaderComponent,
  buildPiGraphicsHudComponent,
  buildPiGraphicsMessageComponent,
  buildStagePanelWidget,
  buildStartupSplashMessage,
  buildTextStagePanel,
  buildWorkingIndicatorFrames,
  shouldAutoApplyTheme,
  shouldAutoShowGraphics,
  shouldAutoShowSplash,
} from "./pi-graphics/auto-widget.js";
import {
  renderPiGraphicsContactSheet,
  renderTuiComponentFrame,
  renderTuiComponentPulseApng,
} from "./pi-graphics/components.js";
import {
  buildPlacement,
  ensureUnicodePlacement,
  makeState,
  renderToText,
} from "./pi-graphics/runtime.js";

const TOOL_PREFIX = "pi_graphics";

export default function piGraphicsExtension(pi) {
  const state = makeState();
  const autoWidgetId = "pi-graphics-auto-pulse";
  const hudWidgetId = "pi-graphics-hud-component";
  let lastAutoWidgetSignature = "";

  function showAutoPulse(ctx, options = {}) {
    if (!shouldAutoShowGraphics()) return false;
    const signature = JSON.stringify({
      tone: options.tone || "assistant",
      caption: options.caption || "kitty graphics pulse active",
      columns: options.columns || 58,
      rows: options.rows || 7,
      frames: options.frames || 8,
      delayMs: options.delayMs || 80,
    });
    if (signature === lastAutoWidgetSignature) return true;
    try {
      if (!ensureUnicodePlacement(state)) {
        const lines = buildTextStagePanel(options);
        ctx.ui?.setWidget?.(autoWidgetId, lines, { placement: "aboveEditor" });
        ctx.ui?.setStatus?.("pi-graphics", "◆ text-stage glow fallback");
        lastAutoWidgetSignature = signature;
        return true;
      }
      const widget = buildStagePanelWidget(state, options);
      ctx.ui?.setWidget?.(autoWidgetId, widget.lines, { placement: "aboveEditor" });
      ctx.ui?.setStatus?.("pi-graphics", `◆ ${widget.details.tone} stage ${widget.details.frames}f ${widget.details.delayMs}ms`);
      lastAutoWidgetSignature = signature;
      return true;
    } catch (error) {
      ctx.ui?.setStatus?.("pi-graphics", `graphics unavailable: ${error?.message || error}`);
      return false;
    }
  }

  function applyThemeCues(ctx) {
    if (shouldAutoApplyTheme() && typeof ctx.ui?.setTheme === "function") {
      const result = ctx.ui.setTheme("kitty-graphics");
      if (result?.success) {
        ctx.ui?.setStatus?.("pi-theme", "◆ kitty-graphics active");
      } else {
        ctx.ui?.setStatus?.("pi-theme", "⚠ select /settings → kitty-graphics");
        ctx.ui?.notify?.(`pi-graphics theme not active: ${result?.error || "select kitty-graphics in /settings"}`, "warning");
      }
    }
    ctx.ui?.setWorkingIndicator?.({ frames: buildWorkingIndicatorFrames(ctx.ui?.theme), intervalMs: 90 });
    ctx.ui?.setHeader?.((_tui, theme) => buildPiGraphicsHeaderComponent(theme));
    ctx.ui?.setFooter?.((_tui, theme, footerData) => buildPiGraphicsFooterComponent(theme, footerData));
    ctx.ui?.setWidget?.(hudWidgetId, (_tui, theme) => buildPiGraphicsHudComponent(theme), { placement: "belowEditor" });
  }

  pi.on("session_start", (_event, ctx) => {
    applyThemeCues(ctx);
    showAutoPulse(ctx, { caption: "kitty graphics pulse active", tone: "assistant" });
    if (shouldAutoShowSplash()) {
      try { pi.sendMessage?.(buildStartupSplashMessage()); } catch {}
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    showAutoPulse(ctx, { caption: "prompt captured", tone: "user", delayMs: 80 });
  });

  pi.on("agent_start", (_event, ctx) => {
    showAutoPulse(ctx, { caption: "agent thinking", tone: "assistant", delayMs: 90 });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const toolName = String(event?.toolName || "tool").slice(0, 32);
    showAutoPulse(ctx, { caption: `tool ${toolName}`, tone: "tool", delayMs: 70 });
  });

  pi.on("agent_end", (_event, ctx) => {
    showAutoPulse(ctx, { caption: "ready", tone: "assistant", delayMs: 120 });
  });

  pi.registerMessageRenderer?.("pi-graphics-message", (message, options, theme) =>
    buildPiGraphicsMessageComponent(message, options, theme));

  pi.on("session_shutdown", (_event, ctx) => {
    try { ctx?.ui?.setWidget?.(autoWidgetId, undefined); } catch {}
    try { ctx?.ui?.setStatus?.("pi-graphics", undefined); } catch {}
    try { ctx?.ui?.setStatus?.("pi-theme", undefined); } catch {}
    try { ctx?.ui?.setWorkingIndicator?.(); } catch {}
    try { ctx?.ui?.setHeader?.(undefined); } catch {}
    try { ctx?.ui?.setFooter?.(undefined); } catch {}
    try { ctx?.ui?.setWidget?.(hudWidgetId, undefined); } catch {}

    const cmd = buildScopedDeleteCommand({
      ownedImageIds: state.ownedImageIds,
      passthrough: state.config.passthrough,
    });
    state.ownedImageIds.clear();
    if (!cmd) return;
    if (ctx?.hasUI && typeof ctx.ui?.write === "function") {
      try { ctx.ui.write(cmd); } catch (_error) { /* best-effort cleanup */ }
    } else if (typeof process.stdout?.write === "function") {
      process.stdout.write(cmd);
    }
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_render_prompt_enclosure`,
    label: "Pi Graphics: Prompt Enclosure",
    description: "Render a kitty-graphics-backed gradient prompt enclosure rule (a graphical replacement for ASCII '-----' separators) and return text with embedded kitty graphics escape sequences plus Unicode placeholder cells.",
    promptSnippet: "Replace ASCII '-----' prompt separators with a graphical kitty-graphics gradient rule.",
    parameters: Type.Object({
      columns: Type.Number({ description: "Width in terminal cells of the rule.", minimum: 1, maximum: 512 }),
      leftColor: Type.Optional(Type.String({ description: "Left/start CSS color (#rrggbb)." })),
      rightColor: Type.Optional(Type.String({ description: "Right/end CSS color (#rrggbb)." })),
      fadeEdges: Type.Optional(Type.Boolean({ description: "Fade alpha at start/end. Defaults to true." })),
      caption: Type.Optional(Type.String({ description: "Optional trailing caption appended after the placeholder cells." })),
    }),
    async execute(_toolCallId, params) {
      if (!ensureUnicodePlacement(state)) {
        return {
          content: [{
            type: "text",
            text: "pi-graphics: Unicode placeholder placement is not active in this terminal; falling back to plain '─' rule.",
          }],
          details: { fallback: true, columns: params.columns },
        };
      }
      const { png, columns, rows } = renderPromptEnclosure({
        columns: params.columns,
        leftColor: params.leftColor,
        rightColor: params.rightColor,
        fadeEdges: params.fadeEdges,
      });
      const placement = buildPlacement(state, {
        name: `prompt-enclosure-${columns}`,
        png,
        columns,
        rows,
        caption: params.caption,
      });
      return {
        content: [{ type: "text", text: renderToText(placement) }],
        details: {
          imageId: placement.imageId,
          placementId: placement.placementId,
          columns,
          rows,
        },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_render_message_border`,
    label: "Pi Graphics: Message Border",
    description: "Render a kitty-graphics-backed translucent gradient border block sized in terminal cells. Useful for framing agent/code blocks or table panels.",
    promptSnippet: "Render a translucent gradient border around a tabular or message block using kitty graphics.",
    parameters: Type.Object({
      columns: Type.Number({ description: "Width in terminal cells.", minimum: 2, maximum: 512 }),
      rows: Type.Number({ description: "Height in terminal cells.", minimum: 2, maximum: 256 }),
      topColor: Type.Optional(Type.String({ description: "Top/start CSS color (#rrggbbaa)." })),
      bottomColor: Type.Optional(Type.String({ description: "Bottom/end CSS color (#rrggbbaa)." })),
      cornerRadius: Type.Optional(Type.Number({ description: "Corner radius in pixels (rough quarter-circle softening).", minimum: 0, maximum: 32 })),
      borderThickness: Type.Optional(Type.Number({ description: "Border stroke thickness in pixels.", minimum: 1, maximum: 8 })),
    }),
    async execute(_toolCallId, params) {
      if (!ensureUnicodePlacement(state)) {
        return {
          content: [{ type: "text", text: "pi-graphics: not running in a kitty/tmux placeholder-capable terminal; skipping graphical border." }],
          details: { fallback: true },
        };
      }
      const { png, columns, rows } = renderGradientBorder({
        columns: params.columns,
        rows: params.rows,
        topColor: params.topColor,
        bottomColor: params.bottomColor,
        cornerRadius: params.cornerRadius,
        borderThickness: params.borderThickness,
      });
      const placement = buildPlacement(state, {
        name: `message-border-${columns}x${rows}`,
        png,
        columns,
        rows,
      });
      return {
        content: [{ type: "text", text: renderToText(placement) }],
        details: {
          imageId: placement.imageId,
          placementId: placement.placementId,
          columns,
          rows,
        },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_render_glow_panel`,
    label: "Pi Graphics: Nordic Glow Panel",
    description: "Render a kitty-graphics-backed high-tech Nordic glow panel with deep gradients, scanlines, corner ticks, and phase-based pulse variation.",
    promptSnippet: "Render a deep Nordic glowing kitty graphics panel for high-tech Pi TUI styling.",
    parameters: Type.Object({
      columns: Type.Number({ description: "Width in terminal cells.", minimum: 2, maximum: 512 }),
      rows: Type.Number({ description: "Height in terminal cells.", minimum: 2, maximum: 256 }),
      phase: Type.Optional(Type.Number({ description: "Normalized pulse phase from 0..1. Different phases shift glow centers/brightness." })),
      scanlines: Type.Optional(Type.Boolean({ description: "Draw subtle scanlines. Defaults to true." })),
    }),
    async execute(_toolCallId, params) {
      if (!ensureUnicodePlacement(state)) {
        return {
          content: [{ type: "text", text: "pi-graphics: not running in a kitty/tmux placeholder-capable terminal; skipping graphical glow panel." }],
          details: { fallback: true },
        };
      }
      const { png, columns, rows, phase } = renderGlowPanel({
        columns: params.columns,
        rows: params.rows,
        phase: params.phase,
        scanlines: params.scanlines,
      });
      const placement = buildPlacement(state, {
        name: `glow-panel-${columns}x${rows}-${phase.toFixed(3)}`,
        png,
        columns,
        rows,
      });
      return {
        content: [{ type: "text", text: renderToText(placement) }],
        details: {
          imageId: placement.imageId,
          placementId: placement.placementId,
          columns,
          rows,
          phase,
        },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_render_tui_component`,
    label: "Pi Graphics: TUI Component Frame",
    description: "Render a kitty-graphics-backed TUI component frame with graphical chrome, deep Nordic glow, status chips, content skeleton rows, scanlines, and phase-based pulse motion.",
    promptSnippet: "Render a high-tech glowing graphical TUI component frame for Pi kitty graphics mode.",
    parameters: Type.Object({
      columns: Type.Optional(Type.Number({ description: "Width in terminal cells. Defaults to 56.", minimum: 8, maximum: 512 })),
      rows: Type.Optional(Type.Number({ description: "Height in terminal cells. Defaults to 9.", minimum: 4, maximum: 256 })),
      phase: Type.Optional(Type.Number({ description: "Normalized pulse phase from 0..1." })),
      tone: Type.Optional(Type.String({ description: "Component tone: assistant, tool, or user." })),
      density: Type.Optional(Type.Number({ description: "Content skeleton density from 0.1..1." })),
      caption: Type.Optional(Type.String({ description: "Optional text caption rendered after the first placeholder line." })),
    }),
    async execute(_toolCallId, params) {
      if (!ensureUnicodePlacement(state)) {
        return {
          content: [{ type: "text", text: "pi-graphics: not running in a kitty/tmux placeholder-capable terminal; skipping graphical TUI component." }],
          details: { fallback: true },
        };
      }
      const frame = renderTuiComponentFrame({
        columns: params.columns,
        rows: params.rows,
        phase: params.phase,
        tone: params.tone,
        density: params.density,
      });
      const placement = buildPlacement(state, {
        name: `tui-component-${frame.tone}-${frame.columns}x${frame.rows}-${frame.phase.toFixed(3)}`,
        png: frame.png,
        columns: frame.columns,
        rows: frame.rows,
        caption: params.caption,
      });
      return {
        content: [{ type: "text", text: renderToText(placement) }],
        details: {
          imageId: placement.imageId,
          placementId: placement.placementId,
          columns: frame.columns,
          rows: frame.rows,
          phase: frame.phase,
          tone: frame.tone,
          metrics: frame.metrics,
        },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_render_tui_pulse`,
    label: "Pi Graphics: Animated TUI Pulse",
    description: "Render an animated APNG kitty-graphics TUI component that pulses continuously with one bounded image transmission.",
    promptSnippet: "Render an efficiently pulsating high-tech TUI component as an animated kitty graphics APNG.",
    parameters: Type.Object({
      columns: Type.Optional(Type.Number({ description: "Width in terminal cells. Defaults to 56.", minimum: 8, maximum: 512 })),
      rows: Type.Optional(Type.Number({ description: "Height in terminal cells. Defaults to 9.", minimum: 4, maximum: 256 })),
      frames: Type.Optional(Type.Number({ description: "Animation frame count. Defaults to 8, capped at 32.", minimum: 2, maximum: 32 })),
      delayMs: Type.Optional(Type.Number({ description: "Per-frame delay in milliseconds. Defaults to 100." })),
      plays: Type.Optional(Type.Number({ description: "APNG play count. 0 loops forever. Defaults to 0." })),
      tone: Type.Optional(Type.String({ description: "Component tone: assistant, tool, or user." })),
      density: Type.Optional(Type.Number({ description: "Content skeleton density from 0.1..1." })),
      caption: Type.Optional(Type.String({ description: "Optional text caption rendered after the first placeholder line." })),
    }),
    async execute(_toolCallId, params) {
      if (!ensureUnicodePlacement(state)) {
        return {
          content: [{ type: "text", text: "pi-graphics: not running in a kitty/tmux placeholder-capable terminal; skipping animated TUI pulse." }],
          details: { fallback: true },
        };
      }
      const pulse = renderTuiComponentPulseApng({
        columns: params.columns,
        rows: params.rows,
        frames: params.frames,
        delayMs: params.delayMs,
        plays: params.plays,
        tone: params.tone,
        density: params.density,
      });
      const placement = buildPlacement(state, {
        name: `tui-pulse-${pulse.tone}-${pulse.columns}x${pulse.rows}-${pulse.frames}f`,
        png: pulse.png,
        columns: pulse.columns,
        rows: pulse.rows,
        caption: params.caption,
      });
      return {
        content: [{ type: "text", text: renderToText(placement) }],
        details: {
          imageId: placement.imageId,
          placementId: placement.placementId,
          columns: pulse.columns,
          rows: pulse.rows,
          frames: pulse.frames,
          delayMs: pulse.delayMs,
          plays: pulse.plays,
          tone: pulse.tone,
          metrics: pulse.metrics,
        },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_render_stage_panel`,
    label: "Pi Graphics: Conversation Stage Panel",
    description: "Render the always-visible conversation stage panel used by pi-graphics lifecycle chrome, including textual neon header plus an APNG TUI component.",
    promptSnippet: "Render a high-tech Pi kitty graphics conversation stage panel for normal turn chrome.",
    parameters: Type.Object({
      columns: Type.Optional(Type.Number({ description: "Width in terminal cells. Defaults to 58.", minimum: 12, maximum: 160 })),
      rows: Type.Optional(Type.Number({ description: "Graphic height in terminal cells. Defaults to 7.", minimum: 4, maximum: 40 })),
      frames: Type.Optional(Type.Number({ description: "Animation frame count. Defaults to 8.", minimum: 2, maximum: 32 })),
      delayMs: Type.Optional(Type.Number({ description: "Per-frame delay in milliseconds. Defaults to 80." })),
      tone: Type.Optional(Type.String({ description: "Panel tone: assistant, tool, or user." })),
      caption: Type.Optional(Type.String({ description: "Stage caption, for example agent thinking or tool read." })),
    }),
    async execute(_toolCallId, params) {
      if (!ensureUnicodePlacement(state)) {
        return {
          content: [{ type: "text", text: buildTextStagePanel(params).join("\n") }],
          details: { fallback: true },
        };
      }
      const widget = buildStagePanelWidget(state, params);
      return {
        content: [{ type: "text", text: widget.lines.join("\n") }],
        details: {
          imageId: widget.placement.imageId,
          placementId: widget.placement.placementId,
          columns: widget.details.columns,
          rows: widget.details.rows,
          frames: widget.details.frames,
          delayMs: widget.details.delayMs,
          tone: widget.details.tone,
          caption: widget.details.caption,
          metrics: widget.details.metrics,
        },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_render_contact_sheet`,
    label: "Pi Graphics: Visual Contact Sheet",
    description: "Render a static PNG contact sheet of Pi kitty graphics component tones and pulse phases for visual regression and human validation.",
    promptSnippet: "Render a Pi kitty graphics visual contact sheet covering tones and pulse phases.",
    parameters: Type.Object({
      columns: Type.Optional(Type.Number({ description: "Tile width in terminal cells. Defaults to 36.", minimum: 8, maximum: 128 })),
      rows: Type.Optional(Type.Number({ description: "Tile height in terminal cells. Defaults to 6.", minimum: 4, maximum: 64 })),
      gapPx: Type.Optional(Type.Number({ description: "Pixel gap between tiles. Defaults to 12." })),
    }),
    async execute(_toolCallId, params) {
      if (!ensureUnicodePlacement(state)) {
        return {
          content: [{ type: "text", text: "pi-graphics: not running in a kitty/tmux placeholder-capable terminal; skipping contact sheet." }],
          details: { fallback: true },
        };
      }
      const sheet = renderPiGraphicsContactSheet({ columns: params.columns, rows: params.rows, gapPx: params.gapPx });
      const placement = buildPlacement(state, {
        name: `contact-sheet-${sheet.widthPx}x${sheet.heightPx}`,
        png: sheet.png,
        columns: Math.min(120, sheet.columns),
        rows: Math.min(40, sheet.rows),
        caption: "Pi graphics visual contact sheet",
      });
      return {
        content: [{ type: "text", text: renderToText(placement) }],
        details: {
          imageId: placement.imageId,
          placementId: placement.placementId,
          columns: sheet.columns,
          rows: sheet.rows,
          widthPx: sheet.widthPx,
          heightPx: sheet.heightPx,
          tileCount: sheet.tileCount,
          tones: sheet.tones,
          phases: sheet.phases,
          metrics: sheet.metrics,
        },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_send_message`,
    label: "Pi Graphics: Send Rendered Message",
    description: "Send a displayed custom message rendered by the pi-graphics custom message renderer.",
    promptSnippet: "Send a visibly rendered Pi graphics custom message into the conversation.",
    parameters: Type.Object({
      content: Type.Optional(Type.String({ description: "Message content to render." })),
      tone: Type.Optional(Type.String({ description: "Renderer tone: assistant, tool, or user." })),
      title: Type.Optional(Type.String({ description: "Renderer title/caption." })),
    }),
    async execute(_toolCallId, params) {
      pi.sendMessage?.({
        customType: "pi-graphics-message",
        content: params.content || "Pi graphics rendered message",
        display: true,
        details: { tone: params.tone || "assistant", title: params.title || "graphics message" },
      });
      return {
        content: [{ type: "text", text: "pi-graphics: displayed rendered custom message." }],
        details: { customType: "pi-graphics-message", tone: params.tone || "assistant" },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_clear`,
    label: "Pi Graphics: Clear",
    description: "Delete every kitty graphics image owned by the pi-graphics extension. Scoped: never deletes images owned by other extensions, never issues a global clear.",
    promptSnippet: "Free every kitty graphics image owned by the pi-graphics extension without disturbing other widgets.",
    parameters: Type.Object({}),
    async execute() {
      const ids = Array.from(state.ownedImageIds);
      const cmd = buildScopedDeleteCommand({
        ownedImageIds: ids,
        passthrough: state.config.passthrough,
      });
      state.ownedImageIds.clear();
      return {
        content: [{ type: "text", text: cmd || "pi-graphics: no owned images to clear." }],
        details: { clearedImageIds: ids },
      };
    },
  });

  pi.registerCommand("pi-graphics-hide", {
    description: "Hide the automatic Pi kitty graphics pulse widget for this session.",
    handler: async (_args, ctx) => {
      ctx.ui?.setWidget?.(autoWidgetId, undefined);
      ctx.ui?.setStatus?.("pi-graphics", "kitty glow hidden");
      ctx.ui?.notify?.("pi-graphics automatic pulse hidden for this session.", "info");
    },
  });

  pi.registerCommand("pi-graphics-show", {
    description: "Show the automatic Pi kitty graphics pulse widget.",
    handler: async (_args, ctx) => {
      if (!ensureUnicodePlacement(state)) {
        ctx.ui?.notify?.("pi-graphics show skipped: terminal lacks Unicode placeholder placement.", "warning");
        return;
      }
      applyThemeCues(ctx);
      const widget = buildStagePanelWidget(state, { caption: "manual graphics stage", tone: "assistant" });
      ctx.ui?.setWidget?.(autoWidgetId, widget.lines, { placement: "aboveEditor" });
      ctx.ui?.setStatus?.("pi-graphics", `◆ ${widget.details.tone} stage ${widget.details.frames}f ${widget.details.delayMs}ms`);
      lastAutoWidgetSignature = "";
      ctx.ui?.notify?.("pi-graphics automatic pulse shown.", "info");
    },
  });

  pi.registerCommand("pi-graphics-message", {
    description: "Send a displayed custom message rendered with Pi kitty graphics message chrome.",
    handler: async (args, _ctx) => {
      const content = args.trim() || "Pi kitty graphics rendered message";
      pi.sendMessage?.({
        customType: "pi-graphics-message",
        content,
        display: true,
        details: { tone: "assistant", title: "manual message" },
      });
    },
  });

  pi.registerCommand("pi-graphics-status", {
    description: "Report pi-graphics extension state: owned image ids and placement mode.",
    handler: async (_args, ctx) => {
      const placementActive = ensureUnicodePlacement(state);
      const summary = [
        `pi-graphics owned images: ${state.ownedImageIds.size}`,
        `placement mode: ${state.config.placementMode}`,
        `passthrough: ${state.config.passthrough}`,
        `unicode placeholders active: ${placementActive ? "yes" : "no"}`,
        `auto pulse widget: ${shouldAutoShowGraphics() ? "enabled" : "disabled by env"}`,
        `auto theme apply: ${shouldAutoApplyTheme() ? "enabled" : "disabled by env"}`,
        `startup splash: ${shouldAutoShowSplash() ? "enabled" : "disabled by env"}`,
        "session header: enabled",
        "session footer: enabled",
        "component HUD: below editor",
      ].join("\n");
      ctx.ui?.notify?.(summary, "info");
    },
  });

  pi.registerCommand("pi-graphics-demo", {
    description: "Print a sample prompt-enclosure rule and a small gradient border using the pi-graphics extension.",
    handler: async (_args, ctx) => {
      if (!ensureUnicodePlacement(state)) {
        ctx.ui?.notify?.("pi-graphics demo skipped: terminal lacks Unicode placeholder placement.", "warning");
        return;
      }
      const rule = buildPlacement(state, {
        name: "demo-rule",
        ...renderPromptEnclosure({ columns: 40 }),
      });
      const border = buildPlacement(state, {
        name: "demo-border",
        ...renderGradientBorder({ columns: 24, rows: 4 }),
      });
      const glow = buildPlacement(state, {
        name: "demo-glow-panel",
        ...renderGlowPanel({ columns: 36, rows: 5, phase: 0.2 }),
      });
      const componentFrame = renderTuiComponentFrame({ columns: 44, rows: 7, phase: 0.35, tone: "assistant" });
      const component = buildPlacement(state, {
        name: "demo-tui-component",
        png: componentFrame.png,
        columns: componentFrame.columns,
        rows: componentFrame.rows,
        caption: "graphical TUI component",
      });
      const pulseFrame = renderTuiComponentPulseApng({ columns: 44, rows: 7, frames: 8, delayMs: 90, tone: "tool" });
      const pulse = buildPlacement(state, {
        name: "demo-tui-pulse",
        png: pulseFrame.png,
        columns: pulseFrame.columns,
        rows: pulseFrame.rows,
        caption: "animated pulse APNG",
      });
      ctx.ui?.notify?.(`${renderToText(rule)}\n${renderToText(border)}\n${renderToText(glow)}\n${renderToText(component)}\n${renderToText(pulse)}`, "info");
    },
  });
}

// Re-exports for tests / external composition.
export {
  buildPlacement,
  ensureUnicodePlacement,
  makeState,
  renderToText,
} from "./pi-graphics/runtime.js";
export {
  renderAccentBar,
  renderGlowPanel,
  renderGlowPanelFrames,
  renderGradientBorder,
  renderPromptEnclosure,
} from "./pi-graphics/affordances.js";
export {
  componentFrameCacheKey,
  renderPiGraphicsContactSheet,
  renderTuiComponentFrame,
  renderTuiComponentFrames,
  renderTuiComponentPixels,
  renderTuiComponentPulseApng,
} from "./pi-graphics/components.js";
export {
  buildAutoPulseWidget,
  buildPiGraphicsFooterComponent,
  buildPiGraphicsFooterLines,
  buildPiGraphicsHeaderComponent,
  buildPiGraphicsHeaderLines,
  buildPiGraphicsHudComponent,
  buildPiGraphicsHudLines,
  buildPiGraphicsMessageComponent,
  buildPiGraphicsMessageLines,
  buildStagePanelWidget,
  buildStartupSplashMessage,
  buildTextStagePanel,
  buildWorkingIndicatorFrames,
  shouldAutoApplyTheme,
  shouldAutoShowGraphics,
  shouldAutoShowSplash,
} from "./pi-graphics/auto-widget.js";
