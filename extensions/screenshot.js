// Pi extension, for TUI Pi and pi-client (bd-487820): /screenshot sends the agent a screen
// region the person picks, or the whole screen, from the machine they sit at.
//
//   /screenshot                      pick a region (macOS: Space picks a window)
//   /screenshot full                 the whole screen, no picker
//   /screenshot full delay=3 why does this look wrong?
//   /screenshot send=followup        after the agent's run, not into it
//   /screenshot status               which tool each mode uses here
//
// The image goes as an image sent with a prompt goes: resized by Pi's own resizeImage with its
// scale note. TUI Pi sends it with pi.sendUserMessage (Pi then fits it to the model, as any
// prompt image). pi-client sends it to the pane's session with conversation.submit, as its own
// sendUserMessage keeps text only (pi-daemon bd-069673).

import { randomUUID } from "node:crypto";

import { readAgentSettings } from "./lib/describe-model.js";
import {
  SCREENSHOT_MODES,
  SCREENSHOT_USAGE,
  captureScreenshot,
  parseScreenshotArgs,
  planScreenshot,
  prepareScreenshotImage,
  screenshotContent,
  screenshotDisplay,
  screenshotSettings,
} from "./lib/screenshot.js";

function notify(ctx, message, level = "info") {
  try { ctx?.ui?.notify?.(message, level); } catch {}
}

/** The pane the command was typed in (pi-client's `ctx.pinned()`), which focus may leave meanwhile. */
function paneContext(ctx) {
  try {
    if (typeof ctx?.pinned === "function") return ctx.pinned() ?? ctx;
  } catch {}
  return ctx;
}

/** Send the message to the session: over /chord in pi-client, else Pi's sendUserMessage. */
export async function deliverScreenshot(pi, ctx, content, send) {
  const busy = (() => {
    try { return ctx?.isIdle?.() === false; } catch { return false; }
  })();
  if (typeof ctx?.chord?.call === "function") {
    await ctx.chord.call("conversation.submit", {
      requestId: `screenshot-${randomUUID()}`,
      content,
      ...(busy ? { whenBusy: send } : {}),
    });
    return;
  }
  if (typeof pi?.sendUserMessage !== "function") throw new Error("this Pi cannot send messages from an extension");
  pi.sendUserMessage(content, busy ? { deliverAs: send } : undefined);
}

export default function screenshotExtension(pi, options = {}) {
  const readSettings = typeof options.readSettings === "function" ? options.readSettings : () => readAgentSettings();
  const capture = typeof options.capture === "function" ? options.capture : captureScreenshot;
  const prepare = typeof options.prepare === "function" ? options.prepare : prepareScreenshotImage;
  const plan = typeof options.plan === "function" ? options.plan : planScreenshot;

  pi.registerCommand?.("screenshot", {
    description: "Send the agent a screen region you pick, or the whole screen: /screenshot [region|full] [delay=S] [send=steer|followup] [text]",
    getArgumentCompletions: (prefix) => {
      const raw = String(prefix ?? "").trimStart().toLowerCase();
      if (/\s/.test(raw)) return null;
      const items = [...SCREENSHOT_MODES, "status", "delay=", "send=steer", "send=followup"]
        .filter((value) => value.startsWith(raw))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const pane = paneContext(ctx);
      let parsed;
      try {
        parsed = parseScreenshotArgs(args);
      } catch (error) {
        notify(pane, error?.message || String(error), "warning");
        return;
      }
      const settings = screenshotSettings(readSettings());

      if (parsed.kind === "status") {
        const lines = [`/screenshot on this machine (${screenshotDisplay()}):`];
        for (const mode of SCREENSHOT_MODES) {
          try {
            const planned = await plan(mode, "{file}", { settings });
            lines.push(`  ${mode}: ${planned.backend} · ${[planned.command, ...planned.args].join(" ")}`);
          } catch (error) {
            lines.push(`  ${mode}: ${error?.message || String(error)}`);
          }
        }
        lines.push(`  send: ${settings.send} while the agent works · ${SCREENSHOT_USAGE}`);
        notify(pane, lines.join("\n"), "info");
        return;
      }

      if (parsed.mode === "region") notify(pane, "Pick a region to send (Escape cancels)…", "info");
      else if (parsed.delaySeconds > 0) notify(pane, `Taking the screen in ${parsed.delaySeconds}s…`, "info");
      let shot;
      try {
        shot = await capture(parsed.mode, { delaySeconds: parsed.delaySeconds, settings });
      } catch (error) {
        notify(pane, error?.message || String(error), "error");
        return;
      }
      if (shot.cancelled) {
        notify(pane, "Screenshot cancelled.", "info");
        return;
      }
      try {
        const image = await prepare(shot.bytes, shot.mimeType, { maxWidth: settings.maxWidth, maxHeight: settings.maxHeight });
        const content = screenshotContent(image, { mode: parsed.mode, text: parsed.text });
        await deliverScreenshot(pi, pane, content, parsed.send ?? settings.send);
        const size = image.width && image.height ? ` ${image.width}×${image.height}` : "";
        notify(pane, `Screenshot sent${size} (${shot.backend}).`, "info");
      } catch (error) {
        notify(pane, `Screenshot not sent: ${error?.message || String(error)}`, "error");
      }
    },
  });
}
