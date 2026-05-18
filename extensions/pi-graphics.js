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
  buildEditorAuraWidget,
  buildPiGraphicsAnsiSceneText,
  buildPiGraphicsAnsiTakeoverText,
  buildPiGraphicsOscPaletteLines,
  buildPiGraphicsOscPaletteResetSequence,
  buildPiGraphicsOscPaletteSequence,
  buildPiGraphicsConversationFrameComponent,
  buildPiGraphicsConversationFrameLines,
  buildPiGraphicsEditorFrameComponent,
  buildPiGraphicsFloodlightComponent,
  buildPiGraphicsFooterComponent,
  buildPiGraphicsHeaderComponent,
  buildPiGraphicsHudComponent,
  buildPiGraphicsMessageComponent,
  buildPiGraphicsDoctorLines,
  buildPiGraphicsLighthouseComponent,
  buildPiGraphicsLighthouseLines,
  buildPiGraphicsPhotonRainComponent,
  buildPiGraphicsPhotonRainLines,
  buildPiGraphicsReloadSentinelLines,
  buildPiGraphicsThemeDeltaLines,
  buildPiGraphicsThemeSwatchComponent,
  buildPiGraphicsThemeSwatchLines,
  buildPiGraphicsThemeSwatchMessageComponent,
  buildStagePanelWidget,
  buildStartupConversationFrameMessage,
  buildStartupSplashMessage,
  buildStartupThemeSwatchMessage,
  buildTerminalTitle,
  buildTextStagePanel,
  buildVisualContractLines,
  buildHiddenThinkingLabel,
  buildWorkingIndicatorFrames,
  buildWorkingMessage,
  PI_GRAPHICS_RELOAD_SENTINEL,
  shouldAutoApplyTerminalPalette,
  shouldAutoApplyTheme,
  shouldAutoShowAnsiScene,
  shouldAutoShowAnsiTakeover,
  shouldAutoShowConversationFrame,
  shouldAutoShowGraphics,
  shouldAutoShowSplash,
  shouldAutoShowTerminalScene,
  shouldAutoShowThemeSwatchSplash,
} from "./pi-graphics/auto-widget.js";
import {
  renderPiGraphicsContactSheet,
  renderTerminalSceneFrame,
  renderTerminalScenePulseApng,
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
  const editorFrameTopId = "pi-graphics-editor-frame-top";
  const editorFrameBottomId = "pi-graphics-editor-frame-bottom";
  const editorAuraWidgetId = "pi-graphics-editor-aura";
  const floodlightWidgetId = "pi-graphics-floodlight";
  const themeSwatchWidgetId = "pi-graphics-theme-swatch";
  const photonRainWidgetId = "pi-graphics-photon-rain";
  const terminalSceneWidgetId = "pi-graphics-terminal-scene";
  const lighthouseWidgetId = "pi-graphics-lighthouse";
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

  function writeRawTerminal(ctx, text) {
    try {
      if (typeof ctx?.ui?.write === "function") {
        ctx.ui.write(text);
        return true;
      }
      if (typeof process.stdout?.write === "function") {
        process.stdout.write(text);
        return true;
      }
    } catch {}
    return false;
  }

  function writeAnsiText(ctx, text) {
    try {
      if (typeof ctx?.ui?.write === "function") {
        ctx.ui.write(`${text}\n`);
        return true;
      }
      if (typeof process.stdout?.write === "function") {
        process.stdout.write(`${text}\n`);
        return true;
      }
    } catch {}
    return false;
  }

  function writeAnsiTakeover(ctx, options = {}) {
    if (!shouldAutoShowAnsiTakeover()) return false;
    return writeAnsiText(ctx, buildPiGraphicsAnsiTakeoverText(options));
  }

  function writeAnsiScene(ctx, options = {}) {
    if (!shouldAutoShowAnsiScene()) return false;
    return writeAnsiText(ctx, buildPiGraphicsAnsiSceneText(options));
  }

  function applyTerminalPalette(ctx) {
    if (!shouldAutoApplyTerminalPalette()) return false;
    return writeRawTerminal(ctx, buildPiGraphicsOscPaletteSequence());
  }

  function resetTerminalPalette(ctx) {
    return writeRawTerminal(ctx, buildPiGraphicsOscPaletteResetSequence());
  }

  function setWorkingChrome(ctx, stage, toolName = "") {
    try { ctx.ui?.setWorkingVisible?.(true); } catch {}
    try { ctx.ui?.setTitle?.(buildTerminalTitle({ stage, toolName })); } catch {}
    try { ctx.ui?.setWorkingMessage?.(buildWorkingMessage({ stage, toolName }, ctx.ui?.theme)); } catch {}
    try { ctx.ui?.setHiddenThinkingLabel?.(buildHiddenThinkingLabel(ctx.ui?.theme)); } catch {}
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
    ctx.ui?.setStatus?.("pi-gfx-mode", "⬢ floodlight");
    ctx.ui?.setStatus?.("pi-gfx-pulse", "◆ APNG editor aura");
    ctx.ui?.setStatus?.("pi-gfx-row", "✦ neon working row");
    ctx.ui?.setStatus?.("pi-gfx-build", PI_GRAPHICS_RELOAD_SENTINEL);
    setWorkingChrome(ctx, "ready");
    ctx.ui?.setHeader?.((_tui, theme) => buildPiGraphicsHeaderComponent(theme));
    ctx.ui?.setFooter?.((_tui, theme, footerData) => buildPiGraphicsFooterComponent(theme, footerData));
    ctx.ui?.setWidget?.(floodlightWidgetId, (_tui, theme) => buildPiGraphicsFloodlightComponent(theme), { placement: "aboveEditor" });
    ctx.ui?.setWidget?.(themeSwatchWidgetId, (_tui, theme) => buildPiGraphicsThemeSwatchComponent(theme), { placement: "aboveEditor" });
    ctx.ui?.setWidget?.(photonRainWidgetId, (_tui, theme) => buildPiGraphicsPhotonRainComponent(theme), { placement: "aboveEditor" });
    ctx.ui?.setWidget?.(lighthouseWidgetId, (_tui, theme) => buildPiGraphicsLighthouseComponent(theme), { placement: "aboveEditor" });
    ctx.ui?.setWidget?.(editorFrameTopId, (_tui, theme) => buildPiGraphicsEditorFrameComponent(theme, { edge: "top" }), { placement: "aboveEditor" });
    ctx.ui?.setWidget?.(editorFrameBottomId, (_tui, theme) => buildPiGraphicsEditorFrameComponent(theme, { edge: "bottom" }), { placement: "belowEditor" });
    if (ensureUnicodePlacement(state)) {
      const aura = buildEditorAuraWidget(state, { caption: "editor aura active", tone: "tool" });
      ctx.ui?.setWidget?.(editorAuraWidgetId, aura.lines, { placement: "belowEditor" });
      if (shouldAutoShowTerminalScene()) {
        const sceneFrame = renderTerminalScenePulseApng({ columns: 54, rows: 10, frames: 8, delayMs: 90 });
        const scene = buildPlacement(state, {
          name: "auto-terminal-scene",
          png: sceneFrame.png,
          columns: sceneFrame.columns,
          rows: sceneFrame.rows,
          caption: "auto rendered terminal scene",
        });
        ctx.ui?.setWidget?.(terminalSceneWidgetId, renderToText(scene).split("\n"), { placement: "aboveEditor" });
        ctx.ui?.setStatus?.("pi-gfx-scene", `⬢ terminal scene ${sceneFrame.frames}f`);
      }
    } else {
      ctx.ui?.setStatus?.("pi-gfx-scene", "⚠ terminal scene needs kitty placeholders");
    }
    ctx.ui?.setWidget?.(hudWidgetId, (_tui, theme) => buildPiGraphicsHudComponent(theme), { placement: "belowEditor" });
  }

  pi.on("session_start", (_event, ctx) => {
    applyTerminalPalette(ctx);
    applyThemeCues(ctx);
    writeAnsiTakeover(ctx, { label: "PI KITTY GRAPHICS TRUECOLOR TAKEOVER // STARTUP" });
    writeAnsiScene(ctx, { label: "PI KITTY GRAPHICS ANSI SCENE // RENDERED PIXELS", phase: 0.18 });
    showAutoPulse(ctx, { caption: "kitty graphics pulse active", tone: "assistant" });
    if (shouldAutoShowSplash()) {
      try { pi.sendMessage?.(buildStartupSplashMessage()); } catch {}
    }
    if (shouldAutoShowThemeSwatchSplash()) {
      try { pi.sendMessage?.(buildStartupThemeSwatchMessage()); } catch {}
    }
    if (shouldAutoShowConversationFrame()) {
      try { pi.sendMessage?.(buildStartupConversationFrameMessage({ title: "startup conversation frame" })); } catch {}
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    setWorkingChrome(ctx, "prompt captured");
    showAutoPulse(ctx, { caption: "prompt captured", tone: "user", delayMs: 80 });
  });

  pi.on("agent_start", (_event, ctx) => {
    setWorkingChrome(ctx, "agent thinking");
    showAutoPulse(ctx, { caption: "agent thinking", tone: "assistant", delayMs: 90 });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const toolName = String(event?.toolName || "tool").slice(0, 32);
    setWorkingChrome(ctx, "tool execution", toolName);
    showAutoPulse(ctx, { caption: `tool ${toolName}`, tone: "tool", delayMs: 70 });
  });

  pi.on("agent_end", (_event, ctx) => {
    setWorkingChrome(ctx, "ready");
    showAutoPulse(ctx, { caption: "ready", tone: "assistant", delayMs: 120 });
    if (shouldAutoShowConversationFrame()) {
      try { pi.sendMessage?.(buildStartupConversationFrameMessage({ content: "Assistant turn complete — the normal transcript is carrying Pi kitty graphics conversation chrome.", title: "assistant turn frame" })); } catch {}
    }
  });

  pi.registerMessageRenderer?.("pi-graphics-message", (message, options, theme) =>
    buildPiGraphicsMessageComponent(message, options, theme));
  pi.registerMessageRenderer?.("pi-graphics-theme-swatch", (message, options, theme) =>
    buildPiGraphicsThemeSwatchMessageComponent(message, options, theme));
  pi.registerMessageRenderer?.("pi-graphics-conversation-frame", (message, options, theme) =>
    buildPiGraphicsConversationFrameComponent(message, options, theme));

  pi.on("session_shutdown", (_event, ctx) => {
    try { ctx?.ui?.setWidget?.(autoWidgetId, undefined); } catch {}
    try { ctx?.ui?.setStatus?.("pi-graphics", undefined); } catch {}
    try { ctx?.ui?.setStatus?.("pi-theme", undefined); } catch {}
    try { ctx?.ui?.setStatus?.("pi-gfx-mode", undefined); } catch {}
    try { ctx?.ui?.setStatus?.("pi-gfx-pulse", undefined); } catch {}
    try { ctx?.ui?.setStatus?.("pi-gfx-row", undefined); } catch {}
    try { ctx?.ui?.setStatus?.("pi-gfx-scene", undefined); } catch {}
    try { ctx?.ui?.setStatus?.("pi-gfx-build", undefined); } catch {}
    try { ctx?.ui?.setWorkingIndicator?.(); } catch {}
    try { ctx?.ui?.setWorkingMessage?.(); } catch {}
    try { ctx?.ui?.setHiddenThinkingLabel?.(); } catch {}
    try { ctx?.ui?.setTitle?.("pi"); } catch {}
    try { resetTerminalPalette(ctx); } catch {}
    try { ctx?.ui?.setHeader?.(undefined); } catch {}
    try { ctx?.ui?.setFooter?.(undefined); } catch {}
    try { ctx?.ui?.setWidget?.(hudWidgetId, undefined); } catch {}
    try { ctx?.ui?.setWidget?.(editorFrameTopId, undefined); } catch {}
    try { ctx?.ui?.setWidget?.(editorFrameBottomId, undefined); } catch {}
    try { ctx?.ui?.setWidget?.(editorAuraWidgetId, undefined); } catch {}
    try { ctx?.ui?.setWidget?.(floodlightWidgetId, undefined); } catch {}
    try { ctx?.ui?.setWidget?.(themeSwatchWidgetId, undefined); } catch {}
    try { ctx?.ui?.setWidget?.(photonRainWidgetId, undefined); } catch {}
    try { ctx?.ui?.setWidget?.(terminalSceneWidgetId, undefined); } catch {}
    try { ctx?.ui?.setWidget?.(lighthouseWidgetId, undefined); } catch {}

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
    name: `${TOOL_PREFIX}_render_terminal_scene`,
    label: "Pi Graphics: Rendered Terminal Scene",
    description: "Render a deep-Nordic graphical terminal scene with cell grid, aurora glow, status chips, and pulse waveform as PNG/APNG kitty graphics output.",
    promptSnippet: "Render a high-tech Pi kitty graphics terminal scene.",
    parameters: Type.Object({
      columns: Type.Optional(Type.Number({ description: "Width in terminal cells. Defaults to 72.", minimum: 16, maximum: 160 })),
      rows: Type.Optional(Type.Number({ description: "Height in terminal cells. Defaults to 14.", minimum: 8, maximum: 48 })),
      animated: Type.Optional(Type.Boolean({ description: "Return APNG pulse animation instead of a static PNG. Defaults to true." })),
      frames: Type.Optional(Type.Number({ description: "Animation frame count. Defaults to 8.", minimum: 2, maximum: 32 })),
      delayMs: Type.Optional(Type.Number({ description: "APNG frame delay. Defaults to 90ms." })),
      phase: Type.Optional(Type.Number({ description: "Static phase when animated=false." })),
    }),
    async execute(_toolCallId, params) {
      if (!ensureUnicodePlacement(state)) {
        return {
          content: [{ type: "text", text: "pi-graphics: not running in a kitty/tmux placeholder-capable terminal; rendered terminal scene requires kitty image placement." }],
          details: { fallback: true },
        };
      }
      const scene = params.animated === false
        ? renderTerminalSceneFrame({ columns: params.columns, rows: params.rows, phase: params.phase })
        : renderTerminalScenePulseApng({ columns: params.columns, rows: params.rows, frames: params.frames, delayMs: params.delayMs });
      const placement = buildPlacement(state, {
        name: `terminal-scene-${scene.columns}x${scene.rows}`,
        png: scene.png,
        columns: scene.columns,
        rows: scene.rows,
        caption: "rendered terminal scene",
      });
      return {
        content: [{ type: "text", text: renderToText(placement) }],
        details: {
          imageId: placement.imageId,
          placementId: placement.placementId,
          columns: scene.columns,
          rows: scene.rows,
          widthPx: scene.widthPx,
          heightPx: scene.heightPx,
          frames: scene.frames || 1,
          delayMs: scene.delayMs || 0,
          metrics: scene.metrics,
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
    name: `${TOOL_PREFIX}_osc_palette`,
    label: "Pi Graphics: OSC Palette Takeover",
    description: "Return OSC sequences that ask compatible terminals to switch foreground/background/cursor and ANSI palette slots to deep-Nordic kitty graphics colors.",
    promptSnippet: "Show the Pi kitty graphics OSC terminal palette takeover sequence.",
    parameters: Type.Object({
      includeAnsi: Type.Optional(Type.Boolean({ description: "Include OSC 4 ANSI palette slots. Defaults to true." })),
    }),
    async execute(_toolCallId, params = {}) {
      return {
        content: [{ type: "text", text: `${buildPiGraphicsOscPaletteSequence(params)}\n${buildPiGraphicsOscPaletteLines().join("\n")}` }],
        details: { sentinel: PI_GRAPHICS_RELOAD_SENTINEL, oscPalette: true },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_ansi_scene`,
    label: "Pi Graphics: ANSI Scene Shader",
    description: "Return a truecolor ANSI half-block rendering sampled from the TypeScript terminal scene pixels.",
    promptSnippet: "Show the Pi kitty graphics ANSI terminal scene shader.",
    parameters: Type.Object({
      columns: Type.Optional(Type.Number({ description: "Rendered text columns.", minimum: 24, maximum: 120 })),
      rows: Type.Optional(Type.Number({ description: "Rendered text rows.", minimum: 6, maximum: 32 })),
      phase: Type.Optional(Type.Number({ description: "Pulse phase used to render the sampled scene." })),
      label: Type.Optional(Type.String({ description: "Scene label." })),
    }),
    async execute(_toolCallId, params = {}) {
      return {
        content: [{ type: "text", text: buildPiGraphicsAnsiSceneText(params) }],
        details: { sentinel: PI_GRAPHICS_RELOAD_SENTINEL, ansi: true, sampledPixels: true },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_ansi_takeover`,
    label: "Pi Graphics: ANSI Takeover",
    description: "Return a raw truecolor ANSI deep-Nordic takeover banner that does not depend on Pi theme APIs or kitty image placement.",
    promptSnippet: "Show a raw truecolor Pi kitty graphics takeover banner.",
    parameters: Type.Object({
      width: Type.Optional(Type.Number({ description: "Target banner width.", minimum: 48, maximum: 160 })),
      phase: Type.Optional(Type.Number({ description: "Pulse phase used to shift the gradient." })),
      label: Type.Optional(Type.String({ description: "Banner label." })),
    }),
    async execute(_toolCallId, params = {}) {
      return {
        content: [{ type: "text", text: buildPiGraphicsAnsiTakeoverText(params) }],
        details: { sentinel: PI_GRAPHICS_RELOAD_SENTINEL, ansi: true },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_conversation_frame`,
    label: "Pi Graphics: Conversation Frame",
    description: "Render a high-contrast deep-Nordic conversation frame for ordinary transcript visibility.",
    promptSnippet: "Show a Pi kitty graphics conversation frame.",
    parameters: Type.Object({
      content: Type.Optional(Type.String({ description: "Text to place inside the graphical conversation frame." })),
      role: Type.Optional(Type.String({ description: "Frame role label, e.g. assistant, user, tool." })),
      title: Type.Optional(Type.String({ description: "Frame title." })),
      width: Type.Optional(Type.Number({ description: "Target text width.", minimum: 52, maximum: 180 })),
    }),
    async execute(_toolCallId, params = {}) {
      return {
        content: [{ type: "text", text: buildPiGraphicsConversationFrameLines(params).join("\n") }],
        details: { sentinel: PI_GRAPHICS_RELOAD_SENTINEL },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_theme_delta`,
    label: "Pi Graphics: Theme Delta",
    description: "Show the Pi kitty graphics reload sentinel and quantified RGB deltas against the default dark theme.",
    promptSnippet: "Show Pi kitty graphics theme delta and reload sentinel.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: [...buildPiGraphicsReloadSentinelLines(), ...buildPiGraphicsThemeDeltaLines()].join("\n") }],
        details: { sentinel: PI_GRAPHICS_RELOAD_SENTINEL },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_lighthouse`,
    label: "Pi Graphics: Lighthouse Beacon",
    description: "Render an oversized normal-TUI lighthouse beacon so Pi kitty graphics mode is impossible to miss even without image placement.",
    promptSnippet: "Show the Pi kitty graphics lighthouse beacon.",
    parameters: Type.Object({
      width: Type.Optional(Type.Number({ description: "Target width in cells. Defaults to 112.", minimum: 64, maximum: 180 })),
      phase: Type.Optional(Type.Number({ description: "Pulse phase from 0 to 1." })),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: buildPiGraphicsLighthouseLines(undefined, { width: params.width, phase: params.phase }).join("\n") }],
        details: { width: params.width || 112, phase: params.phase || 0 },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_doctor`,
    label: "Pi Graphics: Doctor",
    description: "Report Pi kitty graphics visibility state, opt-outs, and remediation steps for diagnosing why graphics mode is not visibly different.",
    promptSnippet: "Run the Pi kitty graphics visibility doctor.",
    parameters: Type.Object({}),
    async execute() {
      const unicodePlacement = ensureUnicodePlacement(state);
      return {
        content: [{ type: "text", text: buildPiGraphicsDoctorLines({
          themeName: "unknown",
          unicodePlacement,
          autoTerminalScene: shouldAutoShowTerminalScene(),
          autoTheme: shouldAutoApplyTheme(),
          autoWidget: shouldAutoShowGraphics(),
          autoSplash: shouldAutoShowSplash(),
          autoThemeSwatch: shouldAutoShowThemeSwatchSplash(),
        }).join("\n") }],
        details: { unicodePlacement, autoTerminalScene: shouldAutoShowTerminalScene() },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_photon_rain`,
    label: "Pi Graphics: Photon Rain",
    description: "Render a pulsing TypeScript TUI photon-rain component using normal text chrome and theme tokens.",
    promptSnippet: "Show the Pi kitty graphics photon rain component.",
    parameters: Type.Object({
      width: Type.Optional(Type.Number({ description: "Target width in cells. Defaults to 96.", minimum: 48, maximum: 180 })),
      phase: Type.Optional(Type.Number({ description: "Animation phase from 0 to 1." })),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: buildPiGraphicsPhotonRainLines(undefined, { width: params.width, phase: params.phase }).join("\n") }],
        details: { width: params.width || 96, phase: params.phase || 0 },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_theme_swatch`,
    label: "Pi Graphics: Theme Swatch",
    description: "Render a text/TUI theme calibration swatch using real Pi theme tokens so operators can see whether kitty-graphics is active.",
    promptSnippet: "Show the Pi kitty graphics theme calibration swatch.",
    parameters: Type.Object({
      width: Type.Optional(Type.Number({ description: "Target swatch width in cells. Defaults to 96.", minimum: 48, maximum: 160 })),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: buildPiGraphicsThemeSwatchLines(undefined, { width: params.width }).join("\n") }],
        details: { width: params.width || 96, usesRuntimeThemeInCommand: true },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_send_theme_swatch`,
    label: "Pi Graphics: Send Theme Swatch",
    description: "Send a displayed transcript-visible theme swatch rendered by the pi-graphics theme swatch renderer.",
    promptSnippet: "Send a Pi kitty graphics theme swatch into the transcript.",
    parameters: Type.Object({
      width: Type.Optional(Type.Number({ description: "Target swatch width in cells. Defaults to 96.", minimum: 48, maximum: 160 })),
    }),
    async execute(_toolCallId, params) {
      pi.sendMessage?.(buildStartupThemeSwatchMessage({ width: params.width || 96 }));
      return {
        content: [{ type: "text", text: "pi-graphics: displayed transcript theme swatch." }],
        details: { customType: "pi-graphics-theme-swatch", width: params.width || 96 },
      };
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_visual_contract`,
    label: "Pi Graphics: Visual Contract",
    description: "Return a high-contrast checklist of the expected Pi kitty graphics cues so operators can verify the mode is visibly active.",
    promptSnippet: "Show the Pi kitty graphics visual contract checklist.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: buildVisualContractLines({ unicodePlacement: ensureUnicodePlacement(state), splash: shouldAutoShowSplash() }).join("\n") }],
        details: { unicodePlacement: ensureUnicodePlacement(state), startupSplash: shouldAutoShowSplash() },
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

  pi.registerCommand("pi-graphics-osc-palette", {
    description: "Apply the deep-Nordic OSC terminal palette takeover when supported by the terminal.",
    handler: async (_args, ctx) => {
      const wrote = applyTerminalPalette(ctx);
      const text = buildPiGraphicsOscPaletteLines(ctx.ui?.theme).join("\n");
      ctx.ui?.notify?.(`${wrote ? "OSC palette sequence written." : "OSC palette write unavailable."}\n${text}`, wrote ? "info" : "warning");
    },
  });

  pi.registerCommand("pi-graphics-ansi-scene", {
    description: "Write a truecolor ANSI half-block rendering sampled from the pixel terminal scene.",
    handler: async (args, ctx) => {
      const label = args.trim() || "PI KITTY GRAPHICS ANSI SCENE SHADER";
      const wrote = writeAnsiScene(ctx, { label, phase: 0.25 });
      if (!wrote) ctx.ui?.notify?.(buildPiGraphicsAnsiSceneText({ label, phase: 0.25 }), "info");
    },
  });

  pi.registerCommand("pi-graphics-ansi-takeover", {
    description: "Write a raw truecolor ANSI deep-Nordic takeover banner.",
    handler: async (args, ctx) => {
      const label = args.trim() || "PI KITTY GRAPHICS TRUECOLOR TAKEOVER";
      const wrote = writeAnsiTakeover(ctx, { label });
      if (!wrote) ctx.ui?.notify?.(buildPiGraphicsAnsiTakeoverText({ label }), "info");
    },
  });

  pi.registerCommand("pi-graphics-conversation-frame", {
    description: "Send a graphical deep-Nordic conversation frame message.",
    handler: async (args, _ctx) => {
      pi.sendMessage?.(buildStartupConversationFrameMessage({ content: args.trim() || undefined, title: "manual conversation frame" }));
    },
  });

  pi.registerCommand("pi-graphics-theme-delta", {
    description: "Show the Pi kitty graphics reload sentinel and quantified theme delta report.",
    handler: async (_args, ctx) => {
      ctx.ui?.notify?.([...buildPiGraphicsReloadSentinelLines(ctx.ui?.theme), ...buildPiGraphicsThemeDeltaLines(ctx.ui?.theme)].join("\n"), "info");
    },
  });

  pi.registerCommand("pi-graphics-lighthouse", {
    description: "Show the oversized Pi kitty graphics lighthouse beacon.",
    handler: async (_args, ctx) => {
      ctx.ui?.notify?.(buildPiGraphicsLighthouseLines(ctx.ui?.theme).join("\n"), "info");
    },
  });

  pi.registerCommand("pi-graphics-doctor", {
    description: "Show Pi kitty graphics visibility diagnostics and trigger the main visible surfaces.",
    handler: async (_args, ctx) => {
      applyThemeCues(ctx);
      showAutoPulse(ctx, { caption: "doctor takeover", tone: "tool", delayMs: 60 });
      try { pi.sendMessage?.(buildStartupThemeSwatchMessage()); } catch {}
      const themeName = ctx.ui?.theme?.name || ctx.ui?.theme?.schema || "unknown";
      ctx.ui?.notify?.(buildPiGraphicsDoctorLines({
        themeName,
        unicodePlacement: ensureUnicodePlacement(state),
        autoTerminalScene: shouldAutoShowTerminalScene(),
        autoTheme: shouldAutoApplyTheme(),
        autoWidget: shouldAutoShowGraphics(),
        autoSplash: shouldAutoShowSplash(),
        autoThemeSwatch: shouldAutoShowThemeSwatchSplash(),
      }, ctx.ui?.theme).join("\n"), "info");
    },
  });

  pi.registerCommand("pi-graphics-takeover", {
    description: "Alias for /pi-graphics-doctor; re-applies all visible Pi graphics surfaces.",
    handler: async (args, ctx) => {
      await pi.commands?.get?.("pi-graphics-doctor")?.handler?.(args, ctx);
      if (!pi.commands?.get) {
        applyThemeCues(ctx);
        showAutoPulse(ctx, { caption: "takeover", tone: "tool", delayMs: 60 });
        try { pi.sendMessage?.(buildStartupThemeSwatchMessage()); } catch {}
        ctx.ui?.notify?.(buildPiGraphicsDoctorLines({ themeName: ctx.ui?.theme?.name || "unknown", unicodePlacement: ensureUnicodePlacement(state) }, ctx.ui?.theme).join("\n"), "info");
      }
    },
  });

  pi.registerCommand("pi-graphics-photon-rain", {
    description: "Show the Pi kitty graphics photon rain component.",
    handler: async (_args, ctx) => {
      ctx.ui?.notify?.(buildPiGraphicsPhotonRainLines(ctx.ui?.theme).join("\n"), "info");
    },
  });

  pi.registerCommand("pi-graphics-theme-swatch", {
    description: "Show the Pi kitty graphics theme calibration swatch.",
    handler: async (_args, ctx) => {
      ctx.ui?.notify?.(buildPiGraphicsThemeSwatchLines(ctx.ui?.theme).join("\n"), "info");
    },
  });

  pi.registerCommand("pi-graphics-theme-swatch-message", {
    description: "Send the Pi kitty graphics theme swatch into the transcript.",
    handler: async (_args, _ctx) => {
      pi.sendMessage?.(buildStartupThemeSwatchMessage());
    },
  });

  pi.registerCommand("pi-graphics-visual-contract", {
    description: "Show the Pi kitty graphics visual contract checklist.",
    handler: async (_args, ctx) => {
      ctx.ui?.notify?.(buildVisualContractLines({ unicodePlacement: ensureUnicodePlacement(state), splash: shouldAutoShowSplash() }, ctx.ui?.theme).join("\n"), "info");
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
        `startup theme swatch: ${shouldAutoShowThemeSwatchSplash() ? "enabled" : "disabled by env"}`,
        `auto terminal scene: ${shouldAutoShowTerminalScene() ? "enabled" : "disabled by env"}`,
        "doctor/takeover: /pi-graphics-doctor",
        `reload sentinel: ${PI_GRAPHICS_RELOAD_SENTINEL}`,
        "theme delta: /pi-graphics-theme-delta",
        "OSC palette: /pi-graphics-osc-palette",
        "ANSI scene shader: /pi-graphics-ansi-scene",
        "ANSI takeover: /pi-graphics-ansi-takeover",
        "conversation frame: /pi-graphics-conversation-frame",
        "session header: enabled",
        "session footer: enabled",
        "component HUD: below editor",
        "editor frame: above/below editor",
        "editor aura: APNG below editor",
        "working row: neon Pi kitty gfx",
        "terminal title: lifecycle Pi kitty gfx",
        "floodlight: high-contrast editor-adjacent banner",
        "theme swatch: above editor + /pi-graphics-theme-swatch",
        "photon rain: above editor + /pi-graphics-photon-rain",
        "lighthouse beacon: above editor + /pi-graphics-lighthouse",
        "rendered terminal scene: auto above editor + pi_graphics_render_terminal_scene",
        "transcript theme swatch: /pi-graphics-theme-swatch-message",
        "live footer: branch/status beacon",
        "visual contract: /pi-graphics-visual-contract",
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
      const sceneFrame = renderTerminalScenePulseApng({ columns: 52, rows: 10, frames: 8, delayMs: 90 });
      const scene = buildPlacement(state, {
        name: "demo-terminal-scene",
        png: sceneFrame.png,
        columns: sceneFrame.columns,
        rows: sceneFrame.rows,
        caption: "rendered terminal scene",
      });
      ctx.ui?.notify?.(`${renderToText(rule)}\n${renderToText(border)}\n${renderToText(glow)}\n${renderToText(component)}\n${renderToText(pulse)}\n${renderToText(scene)}`, "info");
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
  renderTerminalSceneFrame,
  renderTerminalScenePixels,
  renderTerminalScenePulseApng,
  renderTuiComponentFrame,
  renderTuiComponentFrames,
  renderTuiComponentPixels,
  renderTuiComponentPulseApng,
} from "./pi-graphics/components.js";
export {
  buildAutoPulseWidget,
  buildEditorAuraWidget,
  buildPiGraphicsAnsiSceneText,
  buildPiGraphicsAnsiTakeoverText,
  buildPiGraphicsOscPaletteLines,
  buildPiGraphicsOscPaletteResetSequence,
  buildPiGraphicsOscPaletteSequence,
  buildPiGraphicsConversationFrameComponent,
  buildPiGraphicsConversationFrameLines,
  buildPiGraphicsEditorFrameComponent,
  buildPiGraphicsEditorFrameLines,
  buildPiGraphicsFloodlightComponent,
  buildPiGraphicsFloodlightLines,
  buildPiGraphicsFooterComponent,
  buildPiGraphicsFooterLines,
  buildPiGraphicsHeaderComponent,
  buildPiGraphicsHeaderLines,
  buildPiGraphicsHudComponent,
  buildPiGraphicsHudLines,
  buildPiGraphicsMessageComponent,
  buildPiGraphicsMessageLines,
  buildPiGraphicsDoctorLines,
  buildPiGraphicsLighthouseComponent,
  buildPiGraphicsLighthouseLines,
  buildPiGraphicsPhotonRainComponent,
  buildPiGraphicsPhotonRainLines,
  buildPiGraphicsReloadSentinelLines,
  buildPiGraphicsThemeDeltaLines,
  buildPiGraphicsThemeSwatchComponent,
  buildPiGraphicsThemeSwatchLines,
  buildPiGraphicsThemeSwatchMessageComponent,
  buildStagePanelWidget,
  buildStartupConversationFrameMessage,
  buildStartupSplashMessage,
  buildStartupThemeSwatchMessage,
  buildTerminalTitle,
  buildTextStagePanel,
  buildVisualContractLines,
  buildHiddenThinkingLabel,
  buildWorkingIndicatorFrames,
  buildWorkingMessage,
  PI_GRAPHICS_RELOAD_SENTINEL,
  shouldAutoApplyTerminalPalette,
  shouldAutoApplyTheme,
  shouldAutoShowAnsiScene,
  shouldAutoShowAnsiTakeover,
  shouldAutoShowConversationFrame,
  shouldAutoShowGraphics,
  shouldAutoShowSplash,
  shouldAutoShowTerminalScene,
  shouldAutoShowThemeSwatchSplash,
} from "./pi-graphics/auto-widget.js";
