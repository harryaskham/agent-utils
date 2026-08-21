import {
  IMAGE_413_ENTRY_TYPE,
  IMAGE_413_MESSAGE_TYPE,
  createHalfImagePreview,
  hasImageContent,
  imageRecoveryMessage,
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
        if (data?.status === "recovered" && data.toolCallId && data.message) recoveries.set(data.toolCallId, data);
      }
    };

    const prepareRecovery = async (candidate, errorMessage, ctx) => {
      if (!candidate || recoveries.has(candidate.toolCallId)) return null;
      const preview = await resize(candidate.path, { cwd: ctx.cwd || process.cwd() });
      const message = imageRecoveryMessage({
        errorMessage,
        previewPath: preview?.ok ? preview.previewPath : null,
        resizeError: preview?.ok ? null : preview?.error,
      });
      const recovery = {
        version: 1,
        status: "recovered",
        toolCallId: candidate.toolCallId,
        originalPath: candidate.path,
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
      recoveries.set(candidate.toolCallId, recovery);
      pi.appendEntry?.(IMAGE_413_ENTRY_TYPE, recovery);
      try { ctx.ui?.notify?.(message, "warning"); } catch {}
      // Trigger exactly one new model turn. The context hook strips this hidden
      // trigger itself and replaces the offending tool result in the copied
      // provider context before the retry is serialized.
      pi.sendMessage?.({
        customType: RETRY_TRIGGER_TYPE,
        content: "Oversized image attachment recovered; retry with the text replacement.",
        display: false,
        details: { toolCallId: candidate.toolCallId },
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
      if (event?.toolName !== "read") return;
      const path = event?.args?.path || event?.input?.path;
      if (event.toolCallId && path) readPaths.set(event.toolCallId, String(path));
    });

    pi.on("tool_execution_end", (event) => {
      if (event?.toolName !== "read" || !event.toolCallId || !hasImageContent(event?.result?.content)) return;
      const path = event?.args?.path || event?.input?.path || readPaths.get(event.toolCallId);
      if (!path) return;
      latestImageRead = { toolCallId: event.toolCallId, path: String(path) };
    });

    pi.on("message_end", (event) => {
      const message = event?.message;
      if (message?.role !== "toolResult" || message?.toolName !== "read" || !hasImageContent(message.content)) return;
      const toolCallId = message.toolCallId;
      const path = readPaths.get(toolCallId) || message?.details?.path || message?.details?.originalPath;
      if (toolCallId && path) latestImageRead = { toolCallId, path: String(path) };
    });

    pi.on("after_provider_response", async (event, ctx) => {
      if (!latestImageRead) return;
      if (!isImagePayload413(event?.status)) {
        if (Number(event?.status) >= 200 && Number(event?.status) < 300) latestImageRead = null;
        return;
      }
      const candidate = latestImageRead;
      latestImageRead = null;
      if (recoveries.has(candidate.toolCallId) || recoveryInFlight) return;
      const errorMessage = `413 Request Entity Too Large`;
      recoveryInFlight = prepareRecovery(candidate, errorMessage, ctx || sessionCtx)
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
