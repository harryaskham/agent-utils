// Bidirectional bridge between Agent Utils async_choice and Cacophony's async
// operator-decision queue (`caco decision`). Cacophony choices allow one active
// prompt per agent; decisions are the durable, batch-reviewable surface that
// can hold many questions at once. Pi remains the owner of local presentation,
// speech and agent delivery; Cacophony is a mirrored answer surface.

import { execFile } from "node:child_process";

import { getCacophonyRuntimeIdentity } from "./cacophony-runtime.js";

const TRUE_RE = /^(1|true|yes|on|enabled)$/i;
const FALSE_RE = /^(0|false|no|off|disabled)$/i;
const TERMINAL_CANCELLED = new Set(["discarded", "timed_out", "unavailable"]);
const MAX_CONTEXT_BYTES = 4096;

function bool(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  if (TRUE_RE.test(String(value).trim())) return true;
  if (FALSE_RE.test(String(value).trim())) return false;
  return fallback;
}

export function resolveCacophonyDecisionConfig(env = process.env, persisted = {}, syncPersisted = {}) {
  const identity = getCacophonyRuntimeIdentity(env);
  const discovered = Boolean(identity.agentId && identity.project);
  const pollRaw = env.PI_ASYNC_CHOICE_CACO_POLL_MS ?? persisted.pollMs ?? syncPersisted.pollMs ?? 3000;
  const pollMs = Number.isFinite(Number(pollRaw)) ? Math.max(500, Math.min(60_000, Math.trunc(Number(pollRaw)))) : 3000;
  // Async mirroring follows the sync choice mirror switch unless configured
  // separately, so one operator decision disables both Cacophony surfaces.
  const syncEnabled = bool(env.PI_CHOICE_CACO_ENABLED, bool(syncPersisted.enabled, discovered));
  return {
    enabled: !identity.disabled && bool(env.PI_ASYNC_CHOICE_CACO_ENABLED, bool(persisted.enabled, syncEnabled)) && discovered,
    command: String(env.CACO_BIN || persisted.command || syncPersisted.command || "caco"),
    agentId: identity.agentId,
    project: identity.project,
    pollMs,
    notifyFiler: bool(env.PI_ASYNC_CHOICE_CACO_NOTIFY_FILER, bool(persisted.notifyFiler, false)),
  };
}

function execJson(execFileImpl, command, args) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim()));
        return;
      }
      try { resolve(JSON.parse(String(stdout || "{}"))); }
      catch (parseError) { reject(new Error(`invalid caco JSON: ${parseError.message}`)); }
    });
  });
}

const data = (response) => response?.data ?? response ?? {};

function boundedContext(text) {
  const value = String(text || "");
  if (Buffer.byteLength(value) <= MAX_CONTEXT_BYTES) return value;
  let out = value.slice(0, MAX_CONTEXT_BYTES);
  while (Buffer.byteLength(out) > MAX_CONTEXT_BYTES - 3) out = out.slice(0, -1);
  return `${out}…`;
}

// Caco decision options are plain labels. Keep summaries and the agent's
// context visible to the operator through the decision's context field.
export function decisionContext({ context = "", choices = [], asyncId = "" } = {}) {
  const lines = [];
  if (String(context || "").trim()) lines.push(String(context).trim());
  const described = choices.filter((choice) => choice.summary);
  if (described.length) {
    lines.push("Options:");
    for (const choice of described) lines.push(`[${choice.index}] ${choice.headline || choice.label} — ${choice.summary}`);
  }
  lines.push(`Pi async_choice ${asyncId}; answer here or in Pi.`);
  return boundedContext(lines.join("\n"));
}

// Interpret one `caco decision show` payload. Returns null while pending.
export function decisionOutcome(decision, choiceCount) {
  const status = String(decision?.status || "").trim().toLowerCase();
  if (!status || status === "active" || status === "pending") return null;
  if (status === "resolved") {
    const resolution = decision.resolution || {};
    const text = resolution.freeform_text ?? resolution.freeformText;
    if (typeof text === "string" && text.trim()) return { status: "freeform", text: text.trim(), source: "cacophony" };
    const index = resolution.selected_index ?? resolution.selectedIndex;
    if (Number.isInteger(index) && index >= 0 && index < choiceCount) {
      return { status: "selected", index, label: resolution.selected_label ?? resolution.selectedLabel, source: "cacophony" };
    }
    return { status: "cancelled", reason: "cacophony-resolved-without-answer", source: "cacophony" };
  }
  if (TERMINAL_CANCELLED.has(status)) return { status: "cancelled", reason: status === "discarded" ? "discarded" : `cacophony-${status}`, source: "cacophony" };
  return null;
}

export function createCacophonyDecisionBridge({
  env = process.env,
  persisted = {},
  syncPersisted = {},
  execFileImpl = execFile,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const config = resolveCacophonyDecisionConfig(env, persisted, syncPersisted);
  const handles = new Map(); // decision id -> handle
  let timer = null;
  let polling = false;
  let listUnreliable = false;
  let discardUnsupported = false;
  let stopped = false;

  const refreshIdentity = () => {
    Object.assign(config, resolveCacophonyDecisionConfig(env, persisted, syncPersisted));
    return config;
  };
  const call = (args) => execJson(execFileImpl, config.command, [...args, "--json"]);

  const armPoll = () => {
    if (stopped || timer || polling || ![...handles.values()].some((handle) => !handle.stopped)) return;
    timer = setTimer(poll, config.pollMs);
    timer?.unref?.();
  };

  const deliver = (handle, outcome) => {
    if (!outcome || handle.stopped) return;
    handle.stopped = true;
    handles.delete(handle.decisionId);
    try { handle.onResolution?.(outcome); } catch {}
  };

  const showOne = async (handle) => {
    const decision = data(await call(["decision", "show", "--id", handle.decisionId]));
    if (decision?.found === false) {
      if (!handle.warnedMissing) {
        handle.warnedMissing = true;
        handle.warn?.(`Cacophony decision ${handle.decisionId} is not visible from this node`);
      }
      return "missing";
    }
    const outcome = decisionOutcome(decision, handle.choiceCount);
    if (outcome) deliver(handle, outcome);
    return outcome ? "terminal" : "active";
  };

  async function poll() {
    timer = null;
    if (stopped || polling) return;
    polling = true;
    try {
      const live = [...handles.values()].filter((handle) => !handle.stopped && !handle.settling);
      if (!live.length) return;
      let active = null;
      if (!listUnreliable) {
        try {
          const listed = data(await call(["decision", "list", "--status", "active", "--project", config.project, "--filer", config.agentId, "--limit", "500"]));
          active = new Set((Array.isArray(listed?.decisions) ? listed.decisions : []).map((decision) => String(decision?.id || "")));
        } catch (error) {
          live[0]?.warn?.(error?.message || String(error));
        }
      }
      for (const handle of live) {
        if (handle.stopped || handle.settling) continue;
        if (active && active.has(handle.decisionId)) continue;
        try {
          const state = await showOne(handle);
          // The decision is still active but the filtered list omitted it: the
          // daemon normalised our filer differently. Fall back to per-ID reads.
          if (active && state === "active") listUnreliable = true;
        } catch (error) { handle.warn?.(error?.message || String(error)); }
      }
    } finally {
      polling = false;
      armPoll();
    }
  }

  const settle = async (handle, result) => {
    handle.localResult = result;
    if (!handle.decisionId || handle.stopped || handle.settling || result?.source === "cacophony") return;
    handle.settling = true;
    try {
      if (result?.status === "freeform" && typeof result.text === "string" && result.text.trim()) {
        await call(["decision", "resolve", "--id", handle.decisionId, "--freeform-text", result.text.trim()]);
      } else if (["selected", "action"].includes(result?.status) && Number.isInteger(result.index) && result.index < handle.choiceCount) {
        await call(["decision", "resolve", "--id", handle.decisionId, "--selected-index", String(result.index)]);
      } else if (!discardUnsupported) {
        const response = data(await call(["decision", "discard", "--id", handle.decisionId]));
        if (response?.discarded === false && /no such|not found/i.test(String(response?.error || ""))) handle.warn?.(`Cacophony decision ${handle.decisionId}: ${response.error}`);
      }
    } catch (error) {
      const message = error?.message || String(error);
      // Older caco releases have no decision discard. Never invent an answer to
      // clear the operator queue; leave it for the operator and say so once.
      if (/unknown subcommand '?discard|unrecognized subcommand '?discard|\b40[45]\b|method not allowed/i.test(message)) {
        discardUnsupported = true;
        handle.warn?.("this caco has no `decision discard`; the withdrawn Cacophony decision stays pending until the operator clears it");
      } else handle.warn?.(message);
    }
    handle.stopped = true;
    handles.delete(handle.decisionId);
  };

  const track = (handle) => {
    handles.set(handle.decisionId, handle);
    if (handle.localResult) void settle(handle, handle.localResult);
    else armPoll();
  };

  return {
    config,
    get pendingCount() { return [...handles.values()].filter((handle) => !handle.stopped).length; },
    // File a new decision for one async choice. Returns a handle immediately;
    // filing completes in the background and reports its ID via onDecisionId.
    start({ asyncId, question, context, choices, recommendIndex = 0, onDecisionId, onResolution, onWarning }) {
      refreshIdentity();
      if (!config.enabled || stopped) return null;
      const mirrored = choices.filter((choice) => !choice.appended);
      if (mirrored.length < 1) return null;
      const handle = { decisionId: null, choiceCount: mirrored.length, stopped: false, settling: false, localResult: null, onResolution, warnedMissing: false };
      let warned = false;
      handle.warn = (message) => {
        if (warned) return;
        warned = true;
        try { onWarning?.(message); } catch {}
      };
      const args = ["decision", "file", "--project", config.project, "--question", question, "--filer", config.agentId];
      for (const choice of mirrored) args.push("--option", choice.headline || choice.label);
      const recommended = mirrored[recommendIndex] || null;
      if (recommended) args.push("--recommend", recommended.headline || recommended.label);
      args.push("--context", decisionContext({ context, choices: mirrored, asyncId }));
      // Pi delivers answers to the agent itself; suppress the daemon's
      // duplicate resolve→filer direct-message wake where supported.
      if (!config.notifyFiler) args.push("--notify-filer", "false");
      void call(args).then((response) => {
        const id = data(response)?.decision_id || data(response)?.decisionId || null;
        if (!id) throw new Error("caco decision file returned no decision_id");
        handle.decisionId = String(id);
        try { onDecisionId?.(handle.decisionId); } catch {}
        track(handle);
      }).catch((error) => handle.warn(error?.message || String(error)));
      return { handle, settleLocal: (result) => settle(handle, result), stop: () => { handle.stopped = true; if (handle.decisionId) handles.delete(handle.decisionId); } };
    },
    // Re-attach a decision filed before a Pi reload/restart.
    attach({ decisionId, choices, onResolution, onWarning }) {
      refreshIdentity();
      if (!config.enabled || stopped || !decisionId) return null;
      const handle = { decisionId: String(decisionId), choiceCount: choices.filter((choice) => !choice.appended).length, stopped: false, settling: false, localResult: null, onResolution, warnedMissing: false };
      let warned = false;
      handle.warn = (message) => { if (warned) return; warned = true; try { onWarning?.(message); } catch {} };
      track(handle);
      return { handle, settleLocal: (result) => settle(handle, result), stop: () => { handle.stopped = true; handles.delete(handle.decisionId); } };
    },
    pollNow: () => poll(),
    // Stop polling without settling remote decisions: a reload re-attaches
    // them, and an operator answer after quit still reaches the next session.
    dispose() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      handles.clear();
    },
  };
}
