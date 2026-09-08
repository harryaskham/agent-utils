import { ToolSchema as Type } from "./lib/tool-schema.js";
import { createInterruptiblePcmPlayer } from "./lib/tts.js";
import { MachineTtsQueue, TTS_QUEUE_SYMBOL, ttsQueueAgentToolsEnabled, ttsQueueRoot } from "./lib/tts-queue.js";

const content = (text) => [{ type: "text", text }];
const summary = (s) => `tts queue: ${s.active} active, ${s.queued} queued · parallel=${s.config.maxParallel} overlap=${s.config.overlapMs}ms`;

export default function ttsQueueExtension(pi) {
  const queue = new MachineTtsQueue({ player: createInterruptiblePcmPlayer({ queue: false }) });
  globalThis[TTS_QUEUE_SYMBOL] = queue;

  pi.on("session_start", () => queue.start());
  pi.on("session_shutdown", () => {
    queue.stop();
    if (globalThis[TTS_QUEUE_SYMBOL] === queue) delete globalThis[TTS_QUEUE_SYMBOL];
  });

  pi.registerCommand("tts-queue", {
    description: "Inspect/control the machine-global TTS queue: status, skip, next, clear, parallel=N, overlap=SECONDS",
    handler: async (raw, ctx) => {
      const arg = String(raw || "status").trim().toLowerCase();
      if (!arg || arg === "status") return ctx.ui.notify(summary(queue.status()), "info");
      if (arg === "skip") return ctx.ui.notify(queue.skipCurrent() ? "Skipped the oldest active TTS job; the queue will advance." : "No active TTS job.", "info");
      if (arg === "next") { queue.playNext(); return ctx.ui.notify(summary(queue.status()), "info"); }
      if (arg === "clear") return ctx.ui.notify(`Cleared ${queue.clearQueued()} queued TTS job(s); active speech was left playing.`, "info");
      const match = arg.match(/^(parallel|overlap)=(\d+(?:\.\d+)?)$/);
      if (!match) return ctx.ui.notify("Usage: /tts-queue [status|skip|next|clear|parallel=N|overlap=SECONDS]", "warning");
      const config = match[1] === "parallel" ? queue.configure({ maxParallel: Number(match[2]) }) : queue.configure({ overlapMs: Number(match[2]) * 1000 });
      ctx.ui.notify(`TTS queue configured: parallel=${config.maxParallel}, overlap=${config.overlapMs}ms.`, "info");
    },
  });

  if (ttsQueueAgentToolsEnabled()) pi.registerTool({
    name: "tts_queue_status", label: "TTS Queue Status",
    description: "Inspect the machine-global file-backed TTS playback queue and its parallelism/overlap policy.",
    parameters: Type.object({}),
    async execute() { const status = queue.status(); return { content: content(summary(status)), details: { ...status, root: ttsQueueRoot() } }; },
  });
  if (ttsQueueAgentToolsEnabled()) pi.registerTool({
    name: "tts_queue_configure", label: "Configure TTS Queue",
    description: "Set machine-global TTS playback parallelism (1-8) and optional early overlap (0-30000ms).",
    parameters: Type.object({ maxParallel: Type.optional(Type.number()), overlapMs: Type.optional(Type.number()) }),
    async execute(_id, params) { const config = queue.configure(params); return { content: content(`Configured TTS queue: parallel=${config.maxParallel}, overlap=${config.overlapMs}ms.`), details: config }; },
  });
  if (ttsQueueAgentToolsEnabled()) pi.registerTool({
    name: "tts_queue_control", label: "Control TTS Queue",
    description: "Skip the oldest current TTS playback, prompt queue advancement, or clear waiting speech. Clearing requires confirmed=true.",
    parameters: Type.object({ action: Type.StringEnum(["skip", "next", "clear"]), confirmed: Type.optional(Type.boolean()) }),
    async execute(_id, params) {
      if (params.action === "clear" && params.confirmed !== true) return { content: content("Refusing to clear queued speech without confirmed=true."), details: { action: "clear", confirmed: false }, isError: true };
      if (params.action === "skip") { const skipped = queue.skipCurrent(); return { content: content(skipped ? "Skipped current TTS playback; advancing the queue." : "No active TTS playback."), details: { action: "skip", skipped } }; }
      if (params.action === "clear") { const cleared = queue.clearQueued(); return { content: content(`Cleared ${cleared} waiting TTS job(s).`), details: { action: "clear", cleared } }; }
      queue.playNext(); const status = queue.status(); return { content: content(summary(status)), details: { action: "next", status } };
    },
  });
}
