// Pi extension: make stale GitHub Copilot OAuth auth recover without stopping turns.
//
// The transient failure usually appears as "No API key for provider:
// github-copilot" even though a /reload would refresh auth storage and make the
// token available. Patch the model registry's auth checks to reload auth storage
// once and retry only for github-copilot models.

const PATCH_SYMBOL = Symbol.for("agent-utils.copilot-auth-refresh.patch");

function isGithubCopilotModel(modelOrProvider) {
  const provider = typeof modelOrProvider === "string" ? modelOrProvider : modelOrProvider?.provider;
  return String(provider || "").trim().toLowerCase() === "github-copilot";
}

function authResultNeedsCopilotRefresh(result) {
  if (!result) return true;
  if (!result.ok) return /api key|auth|credential|oauth|provider/i.test(String(result.error || ""));
  return !result.apiKey && !result.headers?.Authorization && !result.headers?.authorization;
}

function reloadRegistryAuthStorage(modelRegistry) {
  try {
    modelRegistry?.authStorage?.reload?.();
    return true;
  } catch {
    return false;
  }
}

export function installCopilotAuthRefresh(modelRegistry, { notify = () => {} } = {}) {
  if (!modelRegistry || typeof modelRegistry !== "object") return false;
  if (modelRegistry[PATCH_SYMBOL]) return false;
  const originalHasConfiguredAuth = typeof modelRegistry.hasConfiguredAuth === "function"
    ? modelRegistry.hasConfiguredAuth.bind(modelRegistry)
    : null;
  const originalGetApiKeyAndHeaders = typeof modelRegistry.getApiKeyAndHeaders === "function"
    ? modelRegistry.getApiKeyAndHeaders.bind(modelRegistry)
    : null;
  if (!originalHasConfiguredAuth && !originalGetApiKeyAndHeaders) return false;

  let notified = false;
  const note = (message) => {
    if (notified) return;
    notified = true;
    try { notify(message); } catch {}
  };

  if (originalHasConfiguredAuth) {
    modelRegistry.hasConfiguredAuth = function patchedHasConfiguredAuth(model) {
      const first = originalHasConfiguredAuth(model);
      if (first || !isGithubCopilotModel(model)) return first;
      const reloaded = reloadRegistryAuthStorage(modelRegistry);
      const second = originalHasConfiguredAuth(model);
      if (!first && second && reloaded) note("GitHub Copilot auth storage was stale; refreshed credentials before provider request.");
      return second;
    };
  }

  if (originalGetApiKeyAndHeaders) {
    modelRegistry.getApiKeyAndHeaders = async function patchedGetApiKeyAndHeaders(model) {
      const first = await originalGetApiKeyAndHeaders(model);
      if (!isGithubCopilotModel(model) || !authResultNeedsCopilotRefresh(first)) return first;
      const reloaded = reloadRegistryAuthStorage(modelRegistry);
      const second = await originalGetApiKeyAndHeaders(model);
      if (reloaded && !authResultNeedsCopilotRefresh(second)) note("GitHub Copilot auth storage was stale; refreshed credentials and retried auth resolution.");
      return second;
    };
  }

  Object.defineProperty(modelRegistry, PATCH_SYMBOL, {
    value: { originalHasConfiguredAuth, originalGetApiKeyAndHeaders },
    configurable: false,
    enumerable: false,
  });
  return true;
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n").trim();
}

function isCopilotMissingApiKeyError(message) {
  const text = String(message?.errorMessage || message?.content || "");
  return message?.role === "assistant" && message?.stopReason === "error" &&
    /No API key (?:for provider|found for).*github-copilot|provider:\s*github-copilot/i.test(text);
}

export default function copilotAuthRefreshExtension(pi) {
  let lastFallbackRetryKey = null;
  const patch = (ctx) => installCopilotAuthRefresh(ctx?.modelRegistry, {
    notify(message) { ctx?.ui?.notify?.(message, "info"); },
  });

  pi.on("session_start", async (_event, ctx) => {
    patch(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const lastAssistant = [...messages].reverse().find((message) => message?.role === "assistant");
    if (!isCopilotMissingApiKeyError(lastAssistant)) return;
    const lastUser = [...messages].reverse().find((message) => message?.role === "user");
    const retryText = messageText(lastUser);
    if (!retryText) return;
    const retryKey = `${lastAssistant?.timestamp || ""}:${retryText}`;
    if (retryKey === lastFallbackRetryKey) return;
    lastFallbackRetryKey = retryKey;
    reloadRegistryAuthStorage(ctx?.modelRegistry);
    patch(ctx);
    ctx?.ui?.notify?.("GitHub Copilot auth looked stale after a provider error; reloaded auth storage and queued one retry.", "warning");
    pi.sendUserMessage(`GitHub Copilot auth was refreshed after a transient missing-token error. Retry the previous request now:\n\n${retryText}`, { deliverAs: "followUp" });
  });

  pi.registerCommand?.("copilot-auth-refresh", {
    description: "Reload GitHub Copilot auth storage and retry model auth checks without a full runtime reload.",
    handler: async (_args, ctx) => {
      const ok = reloadRegistryAuthStorage(ctx?.modelRegistry);
      installCopilotAuthRefresh(ctx?.modelRegistry, {
        notify(message) { ctx?.ui?.notify?.(message, "info"); },
      });
      ctx?.ui?.notify?.(ok ? "GitHub Copilot auth storage reloaded." : "GitHub Copilot auth storage reload was unavailable.", ok ? "info" : "warning");
    },
  });
}
