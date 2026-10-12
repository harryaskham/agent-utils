// Pi 0.84's Anthropic adapter stores message_start.model verbatim. Copilot's
// Opus 5.5 wire ID is `claude-opus-5-5`, while its selectable/catalog ID is
// `claude-opus-5.5`. Session restore then fails to find the wire ID and falls back
// to the user's unrelated default. Repair only this known alias on NEW replies
// from the matching selected model, via the supported pre-persistence hook.
// Never rewrite history, signatures, content, response IDs, usage or settings;
// never infer identity for other providers or genuine model fallbacks.
export function canonicalCopilotReply(message, selected) {
  if (message?.role !== "assistant" || message.provider !== "github-copilot"
      || selected?.provider !== "github-copilot" || selected.id !== "claude-opus-5.5"
      || message.model !== "claude-opus-5-5") return undefined;
  return { ...message, model: selected.id };
}
export default function copilotModelIdentity(pi) {
  pi.on("message_end", (event, ctx) => {
    const message = canonicalCopilotReply(event.message, ctx.model);
    if (message) return { message };
  });
}
