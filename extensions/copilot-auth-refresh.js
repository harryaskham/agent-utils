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

// Maximum number of auto-injected retries for a single underlying request
// before we stop re-injecting and surface a terminal notice. This bounds the
// reply-storm / context-fill failure mode where each successive copilot auth
// failure carries a fresh assistant-error timestamp and would otherwise pass a
// timestamp-keyed dedup guard forever.
export const MAX_COPILOT_AUTH_RETRIES = 2;

// Prefix prepended to the underlying request when we re-inject a retry. The
// injected message becomes the most recent user message, so on the next auth
// failure it is what we extract as `retryText`. To keep the bounded budget
// keyed on the STABLE underlying request (and not reset every cycle), we strip
// this prefix back off before computing the budget key. Without this, the
// budget text changes each injection, the counter resets to 0, and the storm
// the budget was meant to prevent continues unbounded (bd-57477b).
export const COPILOT_RETRY_INJECTION_PREFIX =
  "GitHub Copilot auth was refreshed after a transient missing-token error. Retry the previous request now:\n\n";

// Recover the original underlying request from a (possibly already-injected)
// retry message. Strips one or more nested injection prefixes so that a
// re-failure of an already-injected retry shares the original request's budget.
export function underlyingRetryText(text) {
  let value = String(text || "");
  while (value.startsWith(COPILOT_RETRY_INJECTION_PREFIX)) {
    value = value.slice(COPILOT_RETRY_INJECTION_PREFIX.length);
  }
  return value;
}

export default function copilotAuthRefreshExtension(pi) {
  let lastFallbackRetryKey = null;
  // Bounded retry budget keyed on the stable retry text (the user request being
  // retried). Distinct failure timestamps with the same retry text share one
  // budget so transient repeated auth failures cannot inject unbounded retries.
  let retryBudgetText = null;
  let retryBudgetCount = 0;
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
    const rawRetryText = messageText(lastUser);
    if (!rawRetryText) return;
    // Normalize away any auto-injection prefix(es) so the budget keys on the
    // stable underlying request. The injected retry message becomes the next
    // turn's most recent user message; without this recovery the budget text
    // would change every cycle and reset the counter, defeating the bound
    // (bd-57477b).
    const retryText = underlyingRetryText(rawRetryText);
    const retryKey = `${lastAssistant?.timestamp || ""}:${retryText}`;
    if (retryKey === lastFallbackRetryKey) return;
    lastFallbackRetryKey = retryKey;

    // Reset the bounded budget when the underlying request text changes.
    if (retryText !== retryBudgetText) {
      retryBudgetText = retryText;
      retryBudgetCount = 0;
    }
    if (retryBudgetCount >= MAX_COPILOT_AUTH_RETRIES) {
      ctx?.ui?.notify?.(`GitHub Copilot auth still failing after ${MAX_COPILOT_AUTH_RETRIES} automatic retries; not re-injecting. Run /copilot-auth-refresh or check Copilot auth.`, "error");
      return;
    }
    retryBudgetCount += 1;

    reloadRegistryAuthStorage(ctx?.modelRegistry);
    patch(ctx);
    ctx?.ui?.notify?.(`GitHub Copilot auth looked stale after a provider error; reloaded auth storage and queued one retry (${retryBudgetCount}/${MAX_COPILOT_AUTH_RETRIES}).`, "warning");
    // Re-inject using the recovered underlying request so the injected message
    // does not accrete nested prefixes across retries.
    pi.sendUserMessage(`${COPILOT_RETRY_INJECTION_PREFIX}${retryText}`, { deliverAs: "followUp" });
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
