import {
  IMAGE_413_ENTRY_TYPE,
  IMAGE_413_MESSAGE_TYPE,
  createHalfImagePreview,
  hasImageContent,
  imageMessageKey,
  imagePathFromToolMessage,
  imageRecoveryMessage,
  latestImageToolCandidate,
  materializeEmbeddedImage,
  isImagePayload413,
  replaceRecoveredImageMessage,
} from "./lib/image-413-recovery.js";

const RETRY_TRIGGER_TYPE = "agent-utils-image-413-retry";

export function createImage413RecoveryExtension({ resize = createHalfImagePreview } = {}) {
  return function image413RecoveryExtension(pi) {
    let latestImageRead = null;
    let recoveryInFlight = null;
    let sessionCtx = null;
    const readPaths = new Map();
    const recoveries = new Map();

    const restore = (ctx) => {
      recoveries.clear();
      let entries = [];
      try { entries = ctx.sessionManager?.getBranch?.() || ctx.sessionManager?.getEntries?.() || []; } catch {}
      for (const entry of entries) {
        if (entry?.type !== "custom" || entry.customType !== IMAGE_413_ENTRY_TYPE) continue;
        const data = entry.data;
        const key = data?.messageKey || (data?.toolCallId ? `tool:${data.toolCallId}` : "");
        if (data?.status === "recovered" && key && data.message) recoveries.set(key, { ...data, messageKey: key });
      }
    };

    const prepareRecovery = async (candidate, errorMessage, ctx) => {
      if (!candidate || recoveries.has(candidate.messageKey)) return null;
      const cwd = ctx.cwd || process.cwd();
      const safeResize = async (path) => {
        try { return await resize(path, { cwd }); }
        catch (error) { return { ok: false, error: error?.message || String(error) }; }
      };
      let originalPath = candidate.path || "";
      let preview = originalPath ? await safeResize(originalPath) : { ok: false, error: "original image path is unavailable" };
      if (!preview?.ok && candidate.imageData) {
        const materialized = await materializeEmbeddedImage(candidate, { cwd });
        if (materialized.ok) {
          originalPath = materialized.path;
          preview = await safeResize(originalPath);
        } else preview = { ok: false, error: materialized.error };
      }
      const message = imageRecoveryMessage({
        errorMessage,
        previewPath: preview?.ok ? preview.previewPath : null,
        resizeError: preview?.ok ? null : preview?.error,
      });
      const recovery = {
        version: 1,
        status: "recovered",
        messageKey: candidate.messageKey,
        toolCallId: candidate.toolCallId,
        originalPath: originalPath || null,
        errorMessage,
        previewPath: preview?.ok ? preview.previewPath : null,
        originalWidth: preview?.originalWidth,
        originalHeight: preview?.originalHeight,
        width: preview?.width,
        height: preview?.height,
        resizeError: preview?.ok ? null : preview?.error,
        message,
        recoveredAt: Date.now(),
        retryQueued: true,
      };
      recoveries.set(candidate.messageKey, recovery);
      pi.appendEntry?.(IMAGE_413_ENTRY_TYPE, recovery);
      try { ctx.ui?.notify?.(message, "warning"); } catch {}
      // Trigger exactly one new model turn. The context hook strips this hidden
      // trigger itself and replaces the offending tool result in the copied
      // provider context before the retry is serialized.
      pi.sendMessage?.({
        customType: RETRY_TRIGGER_TYPE,
        content: "Oversized image attachment recovered; retry with the text replacement.",
        display: false,
        details: { messageKey: candidate.messageKey, toolCallId: candidate.toolCallId },
      }, { deliverAs: "followUp", triggerTurn: true });
      return recovery;
    };

    pi.registerEntryRenderer?.(IMAGE_413_ENTRY_TYPE, (entry, _options, theme) => ({
      render(width) { return [theme.fg("warning", String(entry.data?.message || "Image read recovery").slice(0, width))]; },
      invalidate() {},
    }));

    pi.registerCommand("image-413-recovery", {
      description: "Show reactive oversized-image provider recovery status.",
      handler: async (_args, ctx) => {
        const latest = [...recoveries.values()].at(-1);
        ctx.ui?.notify?.(latest
          ? `image-413-recovery: ${recoveries.size} replacement(s); latest ${latest.originalPath} -> ${latest.previewPath || "resize failed"}`
          : "image-413-recovery: armed; no recovered image reads in this session", "info");
      },
    });

    pi.on("session_start", (_event, ctx) => {
      sessionCtx = ctx;
      latestImageRead = null;
      recoveryInFlight = null;
      readPaths.clear();
      restore(ctx);
    });

    pi.on("tool_execution_start", (event) => {
      const path = event?.args?.path || event?.input?.path || event?.args?.outputPath;
      if (event?.toolCallId && path) readPaths.set(event.toolCallId, String(path));
    });

    pi.on("tool_execution_end", (event) => {
      if (!event?.toolCallId || !hasImageContent(event?.result?.content)) return;
      const path = event?.args?.path || event?.input?.path || event?.args?.outputPath || readPaths.get(event.toolCallId)
        || imagePathFromToolMessage({ content: event.result.content, details: event.result.details });
      if (!path) return;
      const image = event.result.content.find((block) => block?.type === "image");
      latestImageRead = { messageKey: `tool:${event.toolCallId}`, toolCallId: event.toolCallId, path: String(path), imageData: image?.data || image?.source?.data || "", mimeType: image?.mimeType || image?.source?.mediaType || "image/png", toolName: event.toolName || "unknown" };
    });

    pi.on("message_end", (event) => {
      const message = event?.message;
      if (!hasImageContent(message?.content)) return;
      const messageKey = imageMessageKey(message);
      const toolCallId = message.toolCallId;
      const path = readPaths.get(toolCallId) || imagePathFromToolMessage(message);
      const image = message.content.find((block) => block?.type === "image");
      if (messageKey) latestImageRead = { messageKey, toolCallId, path: path ? String(path) : "", imageData: image?.data || image?.source?.data || "", mimeType: image?.mimeType || image?.source?.mediaType || "image/png", toolName: message.toolName || message.role || "unknown" };
    });

    pi.on("after_provider_response", async (event, ctx) => {
      if (!latestImageRead && isImagePayload413(event?.status)) {
        let entries = [];
        try { entries = (ctx || sessionCtx)?.sessionManager?.getBranch?.() || (ctx || sessionCtx)?.sessionManager?.getEntries?.() || []; } catch {}
        latestImageRead = latestImageToolCandidate(entries);
      }
      if (!latestImageRead) return;
      if (!isImagePayload413(event?.status)) {
        if (Number(event?.status) >= 200 && Number(event?.status) < 300) latestImageRead = null;
        return;
      }
      const candidate = latestImageRead;
      latestImageRead = null;
      if (recoveries.has(candidate.messageKey) || recoveryInFlight) return;
      const errorMessage = `413 Request Entity Too Large`;
      recoveryInFlight = prepareRecovery(candidate, errorMessage, ctx || sessionCtx)
        .finally(() => { recoveryInFlight = null; });
      await recoveryInFlight;
    });

    // Some providers surface HTTP failures only as the terminal assistant error;
    // their transport abstraction never exposes the raw Response to
    // after_provider_response. Recover at agent_end as the authoritative
    // fallback so 413 loops cannot bypass the guard.
    pi.on("agent_end", async (event, ctx) => {
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      const error = [...messages].reverse().find((message) => message?.role === "assistant" && message?.stopReason === "error");
      const errorMessage = String(error?.errorMessage || error?.content || "");
      if (!isImagePayload413(undefined, errorMessage) || recoveryInFlight) return;
      let candidate = latestImageRead;
      if (!candidate) {
        let entries = [];
        try { entries = (ctx || sessionCtx)?.sessionManager?.getBranch?.() || (ctx || sessionCtx)?.sessionManager?.getEntries?.() || []; } catch {}
        candidate = latestImageToolCandidate(entries);
      }
      if (!candidate || recoveries.has(candidate.messageKey)) return;
      latestImageRead = null;
      recoveryInFlight = prepareRecovery(candidate, errorMessage || "413 Request Entity Too Large", ctx || sessionCtx)
        .finally(() => { recoveryInFlight = null; });
      await recoveryInFlight;
    });

    pi.on("context", (event) => {
      const messages = [];
      for (const message of event.messages || []) {
        if (message?.role === "custom" && message.customType === RETRY_TRIGGER_TYPE) continue;
        let next = message;
        for (const recovery of recoveries.values()) next = replaceRecoveredImageMessage(next, recovery);
        messages.push(next);
      }
      return { messages };
    });

    pi.on("session_shutdown", () => {
      sessionCtx = null;
      latestImageRead = null;
      readPaths.clear();
    });
  };
}

export default createImage413RecoveryExtension();
