import { readFile, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { Type } from "@sinclair/typebox";
import { captureMacosInteractiveScreenshot, openMacosAppOnAlternateDisplay } from "./lib/macos-native.js";

function result(text, details) {
  return { content: [{ type: "text", text }], details };
}

export default function macosNativeExtension(pi) {
  if (process.platform !== "darwin") return;

  pi.registerTool({
    name: "open_macos_app",
    label: "Open macOS App",
    description: "Open a macOS .app without activation and move its first window to a display other than the currently focused display.",
    promptSnippet: "Open a macOS app for testing on the non-focused display without stealing user focus.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or cwd-relative path to a .app bundle" }),
    }),
    async execute(_id, params) {
      const details = await openMacosAppOnAlternateDisplay(params.path);
      return result(`Opened ${params.path} on the alternate display without activation.`, details);
    },
  });

  const screenshot = async (ctx) => {
    const outputPath = path.join(os.tmpdir(), `pi-macos-screenshot-${process.pid}-${randomUUID()}.png`);
    try {
      await captureMacosInteractiveScreenshot(outputPath);
      const info = await stat(outputPath).catch(() => null);
      if (!info?.isFile() || info.size === 0) {
        ctx?.ui?.notify?.("Screenshot cancelled.", "info");
        return result("Screenshot cancelled.", { cancelled: true });
      }
      const data = await readFile(outputPath, "base64");
      pi.sendUserMessage([
        { type: "text", text: "User-selected macOS screenshot area." },
        { type: "image", data, mimeType: "image/png" },
      ], ctx?.isIdle?.() === false ? { deliverAs: "followUp" } : undefined);
      ctx?.ui?.notify?.("Screenshot shared with the agent.", "info");
      return result("Screenshot captured and shared with the agent.", { outputPath, bytes: info.size });
    } finally {
      await unlink(outputPath).catch(() => {});
    }
  };

  pi.registerTool({
    name: "capture_macos_screenshot",
    label: "Capture macOS Screenshot",
    description: "Show the native macOS crosshair area selector and share the captured PNG with the agent as an image message.",
    promptSnippet: "Ask the operator to select a macOS screen area and receive it as image context.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) { return screenshot(ctx); },
  });

  pi.registerCommand("screenshot", {
    description: "Select a screen area with the native macOS crosshair and share it with the agent.",
    handler: async (_args, ctx) => { await screenshot(ctx); },
  });
}
