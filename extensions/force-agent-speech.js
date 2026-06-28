// force-agent-speech (bd-9c9877): speak a short spoken precis of the assistant's
// reply after each turn, so a hands-free voice loop (operator speaks via
// `/rt stt local-vad`, assistant replies) is heard aloud instead of only shown as
// text. Opt-in and best-effort: it never blocks or breaks a turn.
//
// Enable with PI_FORCE_AGENT_SPEECH=1 (or true/on), or toggle live with the
// `/force-speech [on|off|status]` command. The spoken text is a SHORT precis
// (markdown/code stripped, truncated to PI_FORCE_AGENT_SPEECH_MAX_CHARS, default
// 240) so it stays snappy — not the whole response.
//
// NOTE (bd-ddc391): when this speaks while `/rt stt local-vad` is listening, the
// assistant's own voice can echo back into the mic. The half-duplex guard is a
// separate follow-up; until it lands, prefer raising /rt energy= or pausing
// local-vad while using force-speech.

import { spawn } from "node:child_process";

export const DEFAULT_MAX_CHARS = 240;

/// True when force-agent-speech is enabled via env. Pure over `env`.
export function isForceSpeechEnabled(env = process.env) {
  const raw = env.PI_FORCE_AGENT_SPEECH;
  if (raw === undefined || raw === null) return false;
  return ["1", "true", "on", "yes"].includes(String(raw).trim().toLowerCase());
}

/// Resolve the max spoken length from env (PI_FORCE_AGENT_SPEECH_MAX_CHARS). Pure.
export function forceSpeechMaxChars(env = process.env) {
  const n = Number(env.PI_FORCE_AGENT_SPEECH_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_MAX_CHARS;
}

/// Extract plain assistant text from a Pi message (string, {content:string}, or
/// an array of content blocks). Returns "" for tool-only / empty messages. Pure.
export function extractAssistantText(message) {
  if (!message) return "";
  if (typeof message === "string") return message.trim();
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === "text" || typeof b.text === "string"))
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join(" ")
      .trim();
  }
  if (typeof message.text === "string") return message.text.trim();
  return "";
}

/// Reduce a (possibly long, markdown-y) response to a short, speakable precis:
/// strip code/markdown, collapse whitespace, and truncate to `maxChars` at a
/// sentence or word boundary. Returns "" when there is nothing speakable. Pure.
export function shortSpokenSummary(text, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  let s = String(text == null ? "" : text);
  s = s.replace(/```[\s\S]*?```/g, " ");          // fenced code blocks
  s = s.replace(/`([^`]+)`/g, "$1");              // inline code -> content
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");    // images
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");  // links -> link text
  s = s.replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/gm, ""); // headers/lists/quotes
  s = s.replace(/(\*\*|\*|__|_|~~|`)/g, "");       // emphasis markers
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length <= maxChars) return s;
  const slice = s.slice(0, maxChars);
  // Prefer a sentence boundary in the back half, else the last word boundary.
  let cut = -1;
  for (const m of slice.matchAll(/[.!?](\s|$)/g)) cut = m.index + 1;
  if (cut >= Math.floor(maxChars * 0.5)) return slice.slice(0, cut).trim();
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim()}…`;
}

// Injectable speak runner (so the hook is testable without spawning caco).
function defaultSpeakRunner(text, { project } = {}) {
  return new Promise((resolve) => {
    const args = ["msg", "speak", "--text", text];
    if (project) args.push("--project", project);
    let proc;
    try {
      proc = spawn(process.env.CACO_BIN || "caco", args, { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));
  });
}

let speakRunner = defaultSpeakRunner;

/// Test seam: override the speak runner (default spawns `caco msg speak`).
export function __setForceSpeechRunnerForTest(fn) {
  speakRunner = typeof fn === "function" ? fn : defaultSpeakRunner;
}

/// Decide what (if anything) to speak for a finished turn. Pure: returns the
/// spoken precis string, or "" to stay silent. Separated for testability.
export function plannedSpeech(event, env = process.env) {
  if (!isForceSpeechEnabled(env)) return "";
  const text = extractAssistantText(event?.message);
  return shortSpokenSummary(text, { maxChars: forceSpeechMaxChars(env) });
}

export default function forceAgentSpeechExtension(pi) {
  let runtimeOverride = null; // null = follow env; true/false = forced by command

  const enabled = () => (runtimeOverride === null ? isForceSpeechEnabled() : runtimeOverride);

  pi.registerCommand?.({
    name: "force-speech",
    summary: "Toggle speaking a short precis of each assistant reply (on|off|status).",
    handler: async (args, ctx) => {
      const arg = String(args || "").trim().toLowerCase();
      if (arg === "on" || arg === "true") runtimeOverride = true;
      else if (arg === "off" || arg === "false") runtimeOverride = false;
      else if (arg === "env" || arg === "default") runtimeOverride = null;
      const state = enabled() ? "on" : "off";
      const src = runtimeOverride === null ? "env" : "command";
      ctx?.ui?.notify?.(`force-speech: ${state} (${src}); max ${forceSpeechMaxChars()} chars`, "info");
    },
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      if (!enabled()) return;
      const text = extractAssistantText(event?.message);
      const spoken = shortSpokenSummary(text, { maxChars: forceSpeechMaxChars() });
      if (!spoken) return;
      await speakRunner(spoken, { project: process.env.CACO_PROJECT || process.env.CACOPHONY_PROJECT });
    } catch {
      // best-effort: never break a turn because speech failed.
    }
  });
}
