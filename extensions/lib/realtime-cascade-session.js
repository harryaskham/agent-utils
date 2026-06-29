// Cascade session controller + real-dep factories (bd-7c6790).
//
// CascadeController holds the persistent group-chat state (the running
// conversation and round counter) and turns a single human utterance into a
// cascade round via runCascadeRound. It is one-round-at-a-time: a human turn that
// arrives while a round is still playing is dropped, so voices never overlap.
//
// The factory helpers build the concrete `runTurn` / `speak` deps from the tested
// primitives (the chat-completions caller and the tts->pcm synthesiser), leaving
// only the audio `playImpl` and the live mic to the extension. Everything here is
// unit-tested with injected deps.

import { runCascadeRound } from "./realtime-cascade.js";
import { sanitizeForSpeech } from "./realtime-cascade.js";
import { DEFAULT_ORDER, MODE_CASCADE, buildParticipantRoster } from "./realtime-participants.js";
import { runChatCompletionTurn } from "./realtime-cascade-llm.js";
import { synthesizeToPcm } from "./realtime-tts-batch.js";
import { parseEnvStyleArgs } from "./env-args.js";

/// Build a cascade roster from a raw `/cascade` argument string. Maps the
/// env-style args (n=, participants=, order=, plus main overrides voice/model/
/// base_url/tts/instructions/name) onto buildParticipantRoster. Pure given an
/// injected `parseArgs` / `env`. Returns { roster, values }.
export function cascadeRosterFromArgs(rawArgs, { env = process.env, parseArgs = parseEnvStyleArgs } = {}) {
  const { values } = parseArgs(rawArgs || "");
  const roster = buildParticipantRoster({
    mode: MODE_CASCADE,
    n: values.n,
    participants: values.participants ?? values.peers,
    order: values.order || DEFAULT_ORDER,
    main: {
      name: values.name,
      voice: values.voice,
      model: values.model,
      baseUrl: values.base_url ?? values.baseurl ?? values.openai_base_url,
      ttsModel: values.tts ?? values.tts_model ?? values.ttsmodel,
      provider: values.provider,
      speakerProfileId: values.speakerprofileid ?? values.speaker_profile_id ?? values.speaker,
      lang: values.lang ?? values.xml_lang,
      instructions: values.instructions ?? values.persona,
    },
    env,
  });
  return { roster, values };
}

export class CascadeController {
  constructor({ roster = [], order = DEFAULT_ORDER, runTurn, speak, synth, play, onTurn, onSpeak, humanLabel, rng, maxHistory } = {}) {
    if (typeof runTurn !== "function") throw new Error("CascadeController requires a runTurn dep");
    this.roster = Array.isArray(roster) ? roster : (roster?.participants || []);
    this.order = order;
    this.runTurn = runTurn;
    this.speak = typeof speak === "function" ? speak : null;
    this.synth = typeof synth === "function" ? synth : null;
    this.play = typeof play === "function" ? play : null;
    this.onTurn = typeof onTurn === "function" ? onTurn : null;
    this.onSpeak = typeof onSpeak === "function" ? onSpeak : null;
    this.humanLabel = humanLabel;
    this.rng = typeof rng === "function" ? rng : Math.random;
    // Sliding-window cap on the running conversation so a long-lived group chat
    // does not grow context (and cost) without bound. 0/undefined = unbounded.
    const mh = Number(maxHistory);
    this.maxHistory = Number.isFinite(mh) && mh > 0 ? Math.floor(mh) : 0;
    this.conversation = [];
    this.round = 0;
    this.busy = false;
    this.lastError = null;
  }

  get active() { return this.busy; }

  /// Drive one cascade round from a human utterance. Returns the round result, or
  /// null if the text is empty or a round is already in flight (one at a time).
  async handleHumanUtterance(text) {
    const body = String(text ?? "").trim();
    if (!body) return null;
    if (this.busy) return null;
    this.busy = true;
    try {
      const res = await runCascadeRound({
        participants: this.roster,
        humanText: body,
        order: this.order,
        rng: this.rng,
        round: this.round,
        conversation: this.conversation,
        runTurn: this.runTurn,
        speak: this.speak || undefined,
        synth: this.synth || undefined,
        play: this.play || undefined,
        onTurn: this.onTurn || undefined,
        onSpeak: this.onSpeak || undefined,
        humanLabel: this.humanLabel,
      });
      this.conversation = this.maxHistory && res.conversation.length > this.maxHistory
        ? res.conversation.slice(-this.maxHistory)
        : res.conversation;
      this.round += 1;
      this.lastError = null;
      return res;
    } catch (err) {
      this.lastError = err?.message || String(err);
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /// Clear the conversation and round counter (start a fresh group chat).
  reset() {
    this.conversation = [];
    this.round = 0;
    this.lastError = null;
  }
}

/// Build a concrete `runTurn(participant, messages)` dep backed by the
/// chat-completions caller. Per-participant model/base-url win over `defaultModel`.
/// Defaults keep spoken replies short (maxTokens) unless overridden.
export function makeCascadeRunTurn({ defaultModel, defaultBaseUrl, envRead, fetchImpl, temperature, maxTokens = 200 } = {}) {
  return (participant, messages) => runChatCompletionTurn({
    messages,
    model: participant?.model || defaultModel,
    baseUrl: participant?.baseUrl || defaultBaseUrl,
    temperature,
    maxTokens,
    fetchImpl,
    envRead,
  });
}

/// Build a concrete `speak(participant, text)` dep: synthesise the reply to PCM
/// (per-participant voice / tts model / base url) then hand it to `playImpl`.
export function makeCascadeSpeak({ synthImpl = synthesizeToPcm, playImpl, speed } = {}) {
  if (typeof playImpl !== "function") throw new Error("makeCascadeSpeak requires a playImpl(pcm, participant) dep");
  return async (participant, text) => {
    const body = sanitizeForSpeech(text);
    if (!body) return;
    const pcm = await synthImpl(body, {
      voice: participant?.voice,
      model: participant?.ttsModel,
      baseUrl: participant?.baseUrl,
      provider: participant?.provider,
      speakerProfileId: participant?.speakerProfileId,
      lang: participant?.lang,
      instructions: participant?.instructions,
      speed,
    });
    if (pcm && pcm.length) await playImpl(pcm, participant);
  };
}

/// Build a `synth(participant, text) -> pcm` dep for PIPELINED rounds (synthesis
/// runs concurrently with playback). Applies sanitizeForSpeech, returns a PCM
/// buffer (empty for blank text). Pair with makeCascadePlay.
export function makeCascadeSynth({ synthImpl = synthesizeToPcm, speed } = {}) {
  return async (participant, text) => {
    const body = sanitizeForSpeech(text);
    if (!body) return Buffer.alloc(0);
    return synthImpl(body, {
      voice: participant?.voice,
      model: participant?.ttsModel,
      baseUrl: participant?.baseUrl,
      provider: participant?.provider,
      speakerProfileId: participant?.speakerProfileId,
      lang: participant?.lang,
      instructions: participant?.instructions,
      speed,
    });
  };
}

/// Build a `play(participant, pcm)` dep for PIPELINED rounds: plays non-empty PCM
/// through `playImpl` in the order the orchestrator serializes it. Pair with
/// makeCascadeSynth.
export function makeCascadePlay({ playImpl } = {}) {
  if (typeof playImpl !== "function") throw new Error("makeCascadePlay requires a playImpl(pcm, participant) dep");
  return async (participant, pcm) => {
    if (pcm && pcm.length) await playImpl(pcm, participant);
  };
}
