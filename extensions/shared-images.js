// Durable machine-local image receipts. Observes explicit sharing, not private
// user uploads or the UI-only live-preview frame stream.
import { randomUUID } from "node:crypto";
import { artifactIdentity, sharedImagesRoot } from "./lib/artifact-state.js";
import { archiveSharedImage, inlineSharedImages, localMarkdownImages } from "./lib/shared-images.js";

const PREVIEW_ADDITIONS = new Set(["kitty_image_preview_add", "kitty_image_preview_add_folder", "kitty_image_preview_capture"]);

export function createSharedImagesExtension({ env = process.env, archive = archiveSharedImage } = {}) {
  return function sharedImagesExtension(pi) {
    let warned = false;
    const capture = async (images, provenance, ctx) => {
      const stored = [], errors = [];
      for (const [index, image] of images.entries()) {
        try { stored.push(await archive(image, { ...provenance, index }, { env })); }
        catch (error) {
          const message = String(error?.message || error).slice(0, 300);
          errors.push(message);
          if (!warned) {
            warned = true;
            try { ctx.ui?.notify?.(`Shared image archive failed: ${message}`, "warning"); } catch {}
          }
        }
      }
      return { root: sharedImagesRoot(env), count: stored.length, stored: stored.slice(0, 32), errors: errors.slice(0, 8) };
    };

    pi.on("tool_result", async (event, ctx) => {
      const images = inlineSharedImages(event.content);
      if (PREVIEW_ADDITIONS.has(event.toolName)) {
        const added = event.details?.added;
        images.push(...(Array.isArray(added) ? added : added ? [added] : []).filter((item) => item?.path));
      }
      if (event.toolName === "kitty_image_preview_stream_sample" && event.details?.sample?.path) images.push(event.details.sample);
      if (event.toolName === "kitty_image_preview_show" && !["hide", "clear"].includes(event.input?.action)) {
        const state = event.details?.kittyImagePreviewState;
        const current = state?.items?.[state.index];
        if (state?.visible && current?.path) images.push(current);
      }
      if (!images.length) return;
      const receipts = await capture(images, {
        ...artifactIdentity(pi, ctx, env), kind: "tool", tool: event.toolName,
        eventId: event.toolCallId || randomUUID(),
        sourcePath: typeof event.input?.path === "string" ? event.input.path : typeof event.details?.outputPath === "string" ? event.details.outputPath : undefined,
      }, ctx);
      // Do not alter image payloads or existing tool semantics. Only a bounded
      // receipt is added; metadata itself lives beside each immutable image.
      if (event.details != null && (typeof event.details !== "object" || Array.isArray(event.details))) return;
      return { details: { ...event.details, sharedImages: receipts } };
    });

    pi.on("message_end", async (event, ctx) => {
      const message = event.message;
      if (!message || !["assistant", "custom"].includes(message.role)) return;
      const images = [...inlineSharedImages(message.content), ...localMarkdownImages(message.content)];
      if (!images.length) return;
      await capture(images, {
        ...artifactIdentity(pi, ctx, env), kind: "message",
        eventId: message.id || `${message.role}:${message.timestamp ?? randomUUID()}:${message.customType || ""}`,
      }, ctx);
    });
  };
}

export default createSharedImagesExtension();
