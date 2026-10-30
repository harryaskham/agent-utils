// How TUI Pi's timers (/after, /cron) deliver their text: `/compact [instructions]` compacts
// (ctx.compact), another `/…` runs as the command it names (an extension command, prompt template
// or skill: Pi's expandPromptTemplates), anything else is a prompt. pi-daemon's Durable /loop,
// /after and /cron run theirs with pi-daemon.command instead.

/** Deliver `payload` now in the session `ctx` belongs to. Throws when it cannot be sent. */
export function dispatchScheduled(pi, ctx, payload, { deliverAs = "followUp", onCompactError } = {}) {
  const text = String(payload ?? "");
  if (/^\/compact(?:\s|$)/i.test(text)) {
    const customInstructions = text.replace(/^\/compact\s*/i, "").trim();
    ctx?.compact?.({
      ...(customInstructions ? { customInstructions } : {}),
      onError(error) {
        onCompactError?.(error);
      },
    });
    return;
  }
  pi.sendUserMessage(text, { deliverAs, expandPromptTemplates: text.startsWith("/") });
}
