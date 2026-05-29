// Pi extension: keep post-compaction continuation on a model-valid role.
//
// Pi core cannot continue an agent loop when the current transcript ends with an
// assistant message. A compaction can legally keep a suffix whose newest message
// is assistant-authored, so the rebuilt model context may end at that assistant
// boundary. Add one hidden custom/user-role checkpoint after compaction so a
// later retry or manual continue starts from a provider-valid user/custom role
// instead of throwing "Cannot continue from message role: assistant".

const FALSE_RE = /^(0|false|off|no|disabled)$/i;
const CUSTOM_TYPE = "agent-utils.compaction-continue-boundary";
const CHECKPOINT_TEXT = [
  "Post-compaction continuation checkpoint.",
  "Use the compacted summary and retained recent messages as context.",
  "If this turn is an automatic retry, continue the interrupted or most recent user request; otherwise wait for the next explicit user instruction.",
].join(" ");

function envBool(name, fallback = true) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !FALSE_RE.test(String(value).trim());
}

export function buildCompactionContinueBoundary(event = {}) {
  return {
    customType: CUSTOM_TYPE,
    content: CHECKPOINT_TEXT,
    display: false,
    details: {
      compactionEntryId: event.compactionEntry?.id ?? null,
      firstKeptEntryId: event.compactionEntry?.firstKeptEntryId ?? null,
      fromExtension: Boolean(event.fromExtension),
      purpose: "avoid-assistant-role-continuation-boundary",
    },
  };
}

export default function compactionContinueGuardExtension(pi) {
  if (!envBool("PI_COMPACTION_CONTINUE_GUARD", true)) return;

  pi.on?.("session_compact", async (event = {}) => {
    try {
      pi.sendMessage?.(buildCompactionContinueBoundary(event));
    } catch (error) {
      try {
        pi.notify?.(`Compaction continue guard failed: ${error?.message || error}`, "warning");
      } catch {}
    }
  });
}
