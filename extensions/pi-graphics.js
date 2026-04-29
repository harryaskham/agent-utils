// Pi extension that pairs with the agent-utils kitty-graphics theme.
//
// The extension is intentionally narrow in scope:
//
//  * It owns a small set of kitty image ids used to back graphical
//    affordances (prompt enclosure rules, gradient borders, accent bars)
//    rendered through the kitty graphics protocol. The image bytes are
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
//    `pi_graphics_render_message_border`, `pi_graphics_clear`) that other
//    agents/operators can use to print graphical affordances directly into
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
  renderGradientBorder,
  renderPromptEnclosure,
} from "./pi-graphics/affordances.js";
import {
  buildPlacement,
  ensureUnicodePlacement,
  makeState,
  renderToText,
} from "./pi-graphics/runtime.js";

const TOOL_PREFIX = "pi_graphics";

export default function piGraphicsExtension(pi) {
  const state = makeState();

  pi.on("session_shutdown", (_event, ctx) => {
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

  pi.registerCommand("pi-graphics-status", {
    description: "Report pi-graphics extension state: owned image ids and placement mode.",
    handler: async (_args, ctx) => {
      const placementActive = ensureUnicodePlacement(state);
      const summary = [
        `pi-graphics owned images: ${state.ownedImageIds.size}`,
        `placement mode: ${state.config.placementMode}`,
        `passthrough: ${state.config.passthrough}`,
        `unicode placeholders active: ${placementActive ? "yes" : "no"}`,
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
      ctx.ui?.notify?.(`${renderToText(rule)}\n${renderToText(border)}`, "info");
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
  renderGradientBorder,
  renderPromptEnclosure,
} from "./pi-graphics/affordances.js";
