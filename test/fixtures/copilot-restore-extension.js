// Isolated model identity fixture. The only model endpoint is a test-owned
// loopback HTTP server; never uses the operator's auth or a real model service.
import { appendFileSync } from "node:fs";
import identity from "../../extensions/copilot-model-identity.js";
export default function fixture(pi) {
  const baseUrl = process.env.COPILOT_RESTORE_QA_URL;
  const receipt = process.env.COPILOT_RESTORE_QA_RECEIPT;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl || "") || !receipt) throw new Error("isolated fixture endpoints required");
  pi.registerProvider("github-copilot", {
    baseUrl, api: "anthropic-messages", apiKey: "fixture-only",
    models: ["claude-opus-5.5", "gpt-6-astra"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 100 })),
  });
  identity(pi);
  pi.on("session_start", (_event, ctx) => appendFileSync(receipt, JSON.stringify({ model: { provider: ctx.model?.provider, id: ctx.model?.id }, file: ctx.sessionManager.getSessionFile() }) + "\n", { mode: 0o600 }));
}
