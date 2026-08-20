// Bidirectional bridge between Agent Utils interactive_choice and Cacophony's
// durable/mobile-visible choices surface. Pi remains the modal + speech owner.

import { execFile } from "node:child_process";

const TRUE_RE = /^(1|true|yes|on|enabled)$/i;
const FALSE_RE = /^(0|false|no|off|disabled)$/i;

function bool(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  if (TRUE_RE.test(String(value).trim())) return true;
  if (FALSE_RE.test(String(value).trim())) return false;
  return fallback;
}

export function resolveCacophonyChoiceConfig(env = process.env, persisted = {}) {
  const agentId = env.CACO_AGENT_ID || env.CACOPHONY_AGENT || "";
  const project = env.CACO_PROJECT || env.CACOPHONY_PROJECT || "";
  const discovered = !!(agentId && project);
  const pollRaw = env.PI_CHOICE_CACO_POLL_MS ?? persisted.pollMs ?? 2000;
  const pollMs = Number.isFinite(Number(pollRaw)) ? Math.max(500, Math.min(60_000, Math.trunc(Number(pollRaw)))) : 2000;
  return {
    enabled: bool(env.PI_CHOICE_CACO_ENABLED, bool(persisted.enabled, discovered)) && discovered,
    command: String(env.CACO_BIN || persisted.command || "caco"),
    agentId,
    project,
    pollMs,
    notifyMode: String(env.PI_CHOICE_CACO_NOTIFY_MODE || persisted.notifyMode || "direct-message"),
  };
}

function execJson(execFileImpl, command, args) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim()));
        return;
      }
      try { resolve(JSON.parse(String(stdout || "{}"))); }
      catch (parseError) { reject(new Error(`invalid caco JSON: ${parseError.message}`)); }
    });
  });
}

export function createCacophonyChoiceBridge({
  env = process.env,
  persisted = {},
  execFileImpl = execFile,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const config = resolveCacophonyChoiceConfig(env, persisted);

  const call = (args) => execJson(execFileImpl, config.command, [...args, "--json"]);

  return {
    config,
    start({ question, choices, onResolution, onWarning }) {
      if (!config.enabled) return null;
      const state = { choiceId: null, stopped: false, timer: null, localResult: null, settling: false };
      const warn = (error) => { try { onWarning?.(error?.message || String(error)); } catch {} };
      const stopTimer = () => { if (state.timer) clearTimer(state.timer); state.timer = null; };
      const schedulePoll = () => {
        if (state.stopped || !state.choiceId) return;
        state.timer = setTimer(poll, config.pollMs);
        state.timer?.unref?.();
      };
      const poll = async () => {
        state.timer = null;
        if (state.stopped || !state.choiceId) return;
        try {
          const response = await call(["choices", "show", "--choice-id", state.choiceId]);
          const data = response?.data || response;
          const status = data?.status;
          if (status === "resolved") {
            state.stopped = true;
            const resolution = data.resolution || {};
            onResolution?.({ status: "selected", index: resolution.selected_index, label: resolution.selected_label, source: "cacophony" });
            return;
          }
          if (["timed_out", "unavailable", "discarded"].includes(status)) {
            state.stopped = true;
            onResolution?.({ status: "cancelled", reason: `cacophony-${status}`, source: "cacophony" });
            return;
          }
        } catch (error) { warn(error); }
        schedulePoll();
      };
      const settleLocal = async (result) => {
        state.localResult = result;
        if (!state.choiceId || state.settling || result?.source === "cacophony") return;
        state.settling = true;
        stopTimer();
        try {
          if (result?.status === "selected" && Number.isInteger(result.index)) {
            await call(["choices", "resolve", "--choice-id", state.choiceId, "--selected-index", String(result.index)]);
          } else {
            await call(["choices", "discard", "--choice-id", state.choiceId]);
          }
        } catch (error) { warn(error); }
        state.stopped = true;
      };

      const mirroredChoices = choices.map((choice) => ({ label: choice.headline || choice.label, ...(choice.summary ? { summary: choice.summary } : {}) }));
      void call([
        "choices", "present",
        "--agent-id", config.agentId,
        "--project", config.project,
        "--preamble", question,
        "--choices", JSON.stringify(mirroredChoices),
        "--allow-freeform", "false",
        `--notify-mode=${config.notifyMode}`,
      ]).then((response) => {
        const data = response?.data || response;
        state.choiceId = data?.choice_id || data?.choiceId || null;
        if (!state.choiceId) throw new Error("caco choices present returned no choice_id");
        if (state.localResult) void settleLocal(state.localResult);
        else schedulePoll();
      }).catch(warn);

      return {
        state,
        settleLocal,
        stop({ discard = false } = {}) {
          stopTimer();
          if (state.stopped) return;
          if (discard && state.choiceId) void settleLocal({ status: "cancelled", reason: "bridge-stop" });
          else state.stopped = true;
        },
      };
    },
  };
}
