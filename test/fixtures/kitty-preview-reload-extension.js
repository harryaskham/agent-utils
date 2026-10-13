// Real Pi reload regression. Loaded only by the isolated smoke test, never as
// a normal package extension. No model, mic, capture CLI or external host calls.
import { appendFileSync } from "node:fs";
export default async function fixture(pi) {
  const pty = Boolean(process.env.KITTY_PREVIEW_QA_ENTRY);
  const entry = process.env.KITTY_PREVIEW_QA_ENTRY || new URL("../../extensions/kitty-image-preview.js", import.meta.url).href;
  const { default: preview } = await import(entry);
  const file = process.env.KITTY_RELOAD_QA_IMAGE || process.env.KITTY_PREVIEW_QA_FIXTURE;
  const receipt = process.env.KITTY_RELOAD_QA_RECEIPT || process.env.KITTY_PREVIEW_QA_RECEIPT;
  if (!file || !receipt) throw new Error("isolated reload fixture paths required");
  const tools = new Map();
  preview({
    ...pi,
    registerTool(definition) { tools.set(definition.name, definition); pi.registerTool(definition); },
  });
  const note = event => appendFileSync(receipt, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  pi.on("session_start", async (event, ctx) => {
    if (pty) {
      await tools.get("kitty_image_preview_add").execute("qa-owned-image", {
        path: file, show: process.env.KITTY_PREVIEW_QA_PRUNE === "1",
        config: { placement: process.env.KITTY_PREVIEW_QA_PLACEMENT || "aboveEditor", passthrough: "none" },
      }, undefined, undefined, ctx);
      ctx.ui.notify("PREVIEW-QA-READY", "info");
    }
    note({ event: "start", reason: event.reason, pid: process.pid });
  });
  pi.registerCommand("qa-preview-state", {
    description: "Isolated preview liveness snapshot",
    handler: async (_args, ctx) => {
      const result = await tools.get("kitty_image_preview_status").execute("state", {}, undefined, undefined, ctx);
      const state = result.details.kittyImagePreviewState;
      note({ event: "state", pid: process.pid, images: state.items.length, visible: state.visible });
    },
  });
  pi.registerCommand("qa-preview-reload", {
    description: "Isolated preview reload regression (test only)",
    handler: async (args, ctx) => {
      const placement = args.trim() === "side" ? "rightOverlay" : "aboveEditor";
      await tools.get("kitty_image_preview_add").execute("fixture", { path: file, show: false, config: { placement } }, undefined, undefined, ctx);
      if (args.trim() === "hide") {
        await tools.get("kitty_image_preview_show").execute("hide", { action: "hide" }, undefined, undefined, ctx);
      }
      note({ event: "prepared", mode: args.trim() });
      await ctx.reload();
      // No captured ctx/pi access after reload — the new instance records start.
    },
  });
}
