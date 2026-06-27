// Cascade group-chat orchestration logic (bd-7c6790).
//
// This module owns the *logic* of a cascade round — turn order, the "each agent
// hears the human and everyone who already spoke" context, and the sequencing of
// think-then-speak — while delegating the impure parts (running an LLM turn,
// synthesising + playing speech) to injected deps. That split keeps the whole
// orchestration unit-tested with mock deps; the live extension supplies real ones
// (chat-completions for a peer turn, realtime-tts-batch + playPcmBuffer to speak).
//
// A cascade round:
//   1. The human speaks once (already transcribed via the stt primitive).
//   2. planTurnRound picks an order (random by default — "arbitrary order").
//   3. For each participant in turn, we build its chat messages from the running
//      conversation (human + every earlier speaker, each labelled), run its turn,
//      then speak the reply and append it so the NEXT participant hears it.

import { planTurnRound, DEFAULT_ORDER } from "./realtime-participants.js";

export const DEFAULT_HUMAN_LABEL = "Human";

/// Default system framing for a cascade participant: who it is, that it is in a
/// spoken group chat with the other named participants, and that its reply will be
/// spoken aloud (so keep it brief and conversational). Pure.
export function defaultCascadeSystem(participant, roster = []) {
  const others = (Array.isArray(roster) ? roster : [])
    .filter((p) => p && p.name && p.name !== participant?.name)
    .map((p) => p.name);
  const room = others.length ? ` with ${others.join(", ")}` : "";
  return (
    `You are ${participant?.name || "an assistant"}, one voice in a spoken group chat${room}. ` +
    `Reply briefly and conversationally as ${participant?.name || "yourself"}; your reply is spoken aloud, ` +
    `so use plain spoken sentences only — no markdown, asterisks, emoji, lists, code, or URLs. ` +
    `Stay in character as ${participant?.name || "yourself"} and do not mention being an AI assistant; ` +
    `address the others by name when it helps the conversation flow.`
  );
}

/// Build the chat-completions messages for one participant's turn from the running
/// conversation. This participant's own prior utterances become `assistant`
/// messages; the human and every other speaker become `user` messages labelled
/// with the speaker's name, so the model can follow who said what. Pure.
///
/// @param participant   the speaking participant { name, instructions, ... }
/// @param conversation  ordered [{ speaker, text }] visible to this participant
/// @param roster        full participant list (for the room framing)
/// @param humanLabel    label used for the human's turns
/// @param systemPrefix  optional extra text prepended to the system message
export function buildCascadeTurnMessages({
  participant,
  conversation = [],
  roster = [],
  humanLabel = DEFAULT_HUMAN_LABEL,
  systemPrefix,
} = {}) {
  const base = participant?.instructions
    ? `${defaultCascadeSystem(participant, roster)} ${participant.instructions}`
    : defaultCascadeSystem(participant, roster);
  const system = systemPrefix ? `${systemPrefix} ${base}` : base;
  const messages = [{ role: "system", content: system }];
  for (const entry of conversation) {
    if (!entry || entry.text == null || String(entry.text).trim() === "") continue;
    const speaker = entry.speaker || humanLabel;
    const isSelf = speaker === participant?.name;
    if (isSelf) {
      messages.push({ role: "assistant", content: String(entry.text) });
    } else {
      messages.push({ role: "user", content: `${speaker}: ${entry.text}` });
    }
  }
  return messages;
}

/// Run one cascade round. Pure-ish: all side effects go through injected deps.
///
/// deps:
///   runTurn(participant, messages, turn) -> Promise<string>   the LLM reply text
///   speak(participant, text, turn)       -> Promise<void>     synth + play (optional)
///   onTurn({ participant, text, turn })  -> void              progress hook (optional)
///
/// @returns { order: number[], turns: [{ index, name, voice, text }], conversation }
export async function runCascadeRound({
  participants,
  humanText,
  humanLabel = DEFAULT_HUMAN_LABEL,
  order = DEFAULT_ORDER,
  rng = Math.random,
  round = 0,
  conversation = [],
  runTurn,
  speak,
  onTurn,
} = {}) {
  const roster = Array.isArray(participants) ? participants : (participants?.participants || []);
  if (typeof runTurn !== "function") {
    throw new Error("runCascadeRound requires a runTurn(participant, messages) dep");
  }
  const plan = planTurnRound(roster, { order, rng, round });
  const convo = conversation.slice();
  const humanBody = String(humanText ?? "").trim();
  if (humanBody) convo.push({ speaker: humanLabel, text: humanBody, isHuman: true });

  const turns = [];
  for (const turn of plan.turns) {
    const participant = roster[turn.index] || {};
    const messages = buildCascadeTurnMessages({ participant, conversation: convo, roster, humanLabel });
    // eslint-disable-next-line no-await-in-loop -- turns are intentionally sequential so each hears the last.
    const reply = await runTurn(participant, messages, turn);
    const text = String(reply ?? "").trim();
    if (text) convo.push({ speaker: participant.name, text });
    if (typeof speak === "function" && text) {
      // eslint-disable-next-line no-await-in-loop -- speech is sequential within a round.
      await speak(participant, text, turn);
    }
    if (typeof onTurn === "function") onTurn({ participant, text, turn });
    turns.push({ index: turn.index, name: participant.name, voice: participant.voice, text });
  }

  return { order: plan.order, turns, conversation: convo };
}

/// Clean a model reply for SPEECH: strip markdown, code, links, emoji, and list
/// markers so a TTS voice does not read "asterisk", "backtick", URLs, or emoji
/// aloud. Faithful textual history is kept elsewhere; this only shapes audio. Pure.
export function sanitizeForSpeech(text) {
  let s = String(text ?? "");
  if (!s) return "";
  // Fenced code blocks -> drop entirely.
  s = s.replace(/```[\s\S]*?```/g, " ");
  // Inline code `x` -> x.
  s = s.replace(/`([^`]*)`/g, "$1");
  // Markdown links [text](url) / images ![alt](url) -> the text/alt.
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Bare URLs -> drop.
  s = s.replace(/\bhttps?:\/\/\S+/gi, " ");
  // Bold/italic markers (paired) -> inner text.
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
  s = s.replace(/(\*|_)(.*?)\1/g, "$2");
  // Leading heading hashes and blockquote marks.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  // Leading list markers (-, *, +, or "1.").
  s = s.replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, "");
  // Strip emoji / pictographs / dingbats / arrows / variation selectors / ZWJ.
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "");
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
